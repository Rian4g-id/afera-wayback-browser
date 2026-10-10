// ==================== LIST: BULK CHECK + HISTORY ====================
// Every check (a search on Home or a bulk check here) is saved to disk, so the
// list survives closing the app. Snapshots are stored per domain, so clicking a
// row opens its calendar right away without asking the archives again.

const fs = require('fs');
const path = require('path');

const DATA_DIR = ipcRenderer.sendSync('get-user-data-path');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const SNAPSHOT_DIR = path.join(DATA_DIR, 'snapshots');

// Domains checked at the same time. Wayback rate-limits per IP, so more
// parallel checks only pay off when they go out through different proxies.
const BULK_CONCURRENCY = 2;
const BULK_CONCURRENCY_PROXY = 4;
// Pause between two domains of one worker
const BULK_DELAY = 1000;

const RESULT_LABELS = { ok: 'OK', empty: 'No data', error: 'Error', pending: 'Pending', checking: 'Checking' };

// Table columns: key, header, how to sort
const LIST_COLUMNS = [
  { key: 'domain', label: 'Domain', type: 'text' },
  { key: 'status', label: 'Result', type: 'status' },
  { key: 'total', label: 'Snapshots', type: 'number' },
  { key: 'firstSeen', label: 'First Seen', type: 'text' },
  { key: 'lastSeen', label: 'Last Seen', type: 'text' },
  { key: 'lastCode', label: 'Last Code', type: 'text' },
  { key: 'last200', label: 'Last 200', type: 'text' },
  { key: 'years', label: 'Years', type: 'number' },
  { key: 'source', label: 'Source', type: 'text' },
  { key: 'checkedAt', label: 'Checked', type: 'number' }
];
const STATUS_ORDER = { checking: 0, pending: 1, error: 2, empty: 3, ok: 4 };
// Result fields of a row (kept while re-checking, and when a re-check fails)
const SUMMARY_KEYS = ['total', 'truncated', 'firstSeen', 'lastSeen', 'lastCode', 'last200', 'years', 'source'];

let listEntries = loadHistory(); // newest first
let bulkRun = null; // { controller, queue, active, workers, done, total } while checking
let listSort = { key: null, dir: 1 };
const selectedDomains = new Set();
let listRenderQueued = false;
let historySaveTimer = null;

const bulkInput = document.getElementById('bulkInput');
const listBody = document.getElementById('listBody');

// ---------- Storage ----------

function loadHistory() {
  try {
    const entries = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    // A check cut off by closing the app is still waiting
    return entries.map(e => (e.status === 'checking' ? { ...e, status: 'pending', note: '' } : e));
  } catch (error) {
    return [];
  }
}

function saveHistoryNow() {
  clearTimeout(historySaveTimer);
  historySaveTimer = null;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(HISTORY_FILE + '.tmp', JSON.stringify(listEntries));
    fs.renameSync(HISTORY_FILE + '.tmp', HISTORY_FILE); // never leaves a half-written file
  } catch (error) {
    console.error('Saving history failed:', error);
    setStatus(`Could not save history: ${error.message}`);
    // Try again (the file may be locked for a moment by antivirus / OneDrive)
    historySaveTimer = setTimeout(saveHistoryNow, 2000);
  }
}

function saveHistorySoon() {
  if (!historySaveTimer) historySaveTimer = setTimeout(saveHistoryNow, 300);
}

window.addEventListener('beforeunload', () => {
  if (historySaveTimer) saveHistoryNow();
});

function snapshotFile(domain) {
  return path.join(SNAPSHOT_DIR, domain.replace(/[^a-z0-9.-]/gi, '_') + '.json');
}

// Stored compactly: original URLs once in a table, rows as [timestamp, urlIndex, statusCode]
function saveSnapshots(domain, result) {
  const urls = [];
  const urlIndex = new Map();
  const rows = result.snapshots.map(s => {
    let i = urlIndex.get(s.originalUrl);
    if (i === undefined) {
      i = urls.length;
      urls.push(s.originalUrl);
      urlIndex.set(s.originalUrl, i);
    }
    return [s.timestamp, i, s.statusCode];
  });
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  fs.writeFileSync(snapshotFile(domain), JSON.stringify({ source: result.source, urls, rows }));
}

function loadSnapshots(domain) {
  try {
    const data = JSON.parse(fs.readFileSync(snapshotFile(domain), 'utf8'));
    return {
      source: data.source,
      snapshots: data.rows.map(([timestamp, i, statusCode]) => ({
        timestamp,
        originalUrl: data.urls[i],
        url: snapshotUrl(data.source, timestamp, data.urls[i]),
        statusCode,
        source: data.source
      }))
    };
  } catch (error) {
    return null;
  }
}

function deleteSnapshots(domain) {
  try {
    fs.unlinkSync(snapshotFile(domain));
  } catch (error) {
    // already gone
  }
}

// ---------- Entries ----------

function findEntry(domain) {
  return listEntries.find(e => e.domain === domain);
}

function pickSummary(entry) {
  const summary = {};
  if (!entry) return summary;
  SUMMARY_KEYS.forEach(key => {
    if (entry[key] !== undefined) summary[key] = entry[key];
  });
  return summary;
}

// Facts that matter for expired-domain checks
function summarizeResult(result) {
  const snaps = [...result.snapshots].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const newest = snaps[snaps.length - 1];
  let last200 = '';
  for (let i = snaps.length - 1; i >= 0; i--) {
    if (snaps[i].statusCode === '200') {
      last200 = snaps[i].timestamp;
      break;
    }
  }
  return {
    total: snaps.length,
    truncated: snaps.length >= SNAPSHOT_LIMIT,
    firstSeen: snaps[0].timestamp,
    lastSeen: newest.timestamp,
    lastCode: newest.statusCode,
    last200,
    years: new Set(snaps.map(s => s.timestamp.slice(0, 4))).size,
    source: result.source
  };
}

// Replace a domain's row with fresh data. addToTop: a search on Home puts it first;
// a bulk check keeps the row where it is and ignores rows deleted meanwhile.
function storeEntry(domain, data, { addToTop = false } = {}) {
  const index = listEntries.findIndex(e => e.domain === domain);
  if (index === -1 && !addToTop) return;

  const previous = index === -1 ? null : listEntries[index];
  const entry = { domain, addedAt: previous ? previous.addedAt : Date.now(), ...data };
  if (index !== -1) listEntries.splice(index, 1);
  if (addToTop || index === -1) listEntries.unshift(entry);
  else listEntries.splice(index, 0, entry);

  saveHistorySoon();
  renderListSoon();
}

function recordCheckResult(domain, result, options = {}) {
  // Row deleted while it was being checked: drop the result (no orphan snapshot file)
  if (!options.addToTop && !findEntry(domain)) return;

  const found = result.snapshots.length > 0;
  // An older result of this domain kept in memory is outdated now
  if (snapshotCache[domain] !== result) delete snapshotCache[domain];
  if (found) {
    try {
      saveSnapshots(domain, result);
    } catch (error) {
      console.error('Saving snapshots failed:', error);
    }
  } else {
    deleteSnapshots(domain);
  }
  storeEntry(domain, {
    status: found ? 'ok' : 'empty',
    checkedAt: Date.now(),
    ...(found ? summarizeResult(result) : { total: 0 })
  }, options);
}

// The last good numbers stay: a failed re-check (e.g. Wayback down) must not wipe them
function recordCheckError(domain, error, options) {
  storeEntry(domain, {
    ...pickSummary(findEntry(domain)),
    status: 'error',
    error: error.message,
    checkedAt: Date.now()
  }, options);
}

// Change fields of a row in place (status / progress note)
function updateEntry(domain, fields) {
  const entry = findEntry(domain);
  if (!entry) return;
  Object.assign(entry, fields);
  saveHistorySoon();
  renderListSoon();
}

// ---------- Bulk check ----------

// Split pasted text into clean, unique domains (URLs and www. are trimmed)
function parseDomainList(text) {
  const domains = [];
  const invalid = [];
  const seen = new Set();

  for (const raw of text.split(/[\s,;]+/)) {
    if (!raw) continue;
    const domain = cleanDomain(raw);
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) {
      invalid.push(raw);
    } else if (!seen.has(domain)) {
      seen.add(domain);
      domains.push(domain);
    }
  }
  return { domains, invalid };
}

function isBusy(domain) {
  return !!bulkRun && (bulkRun.queue.includes(domain) || bulkRun.active.has(domain));
}

function bulkConcurrency() {
  return proxyState.enabled
    ? Math.min(BULK_CONCURRENCY_PROXY, Math.max(BULK_CONCURRENCY, proxyState.count))
    : BULK_CONCURRENCY;
}

function startBulkCheck() {
  const { domains, invalid } = parseDomainList(bulkInput.value);
  if (domains.length === 0) {
    alert(invalid.length ? 'No valid domains found in the box.' : 'Paste one or more domains first.');
    return;
  }

  // New rows go on top in the pasted order. A domain already in the list is re-checked;
  // it keeps its last numbers until the new result is in.
  const fresh = domains.filter(d => !isBusy(d));
  const freshSet = new Set(fresh);
  // Deleted while its check was still running: bring the row back so the result lands
  const runningButDeleted = domains.filter(d => isBusy(d) && !findEntry(d));
  const now = Date.now();
  listEntries = [
    ...fresh.map(domain => ({ ...pickSummary(findEntry(domain)), domain, status: 'pending', addedAt: now })),
    ...runningButDeleted.map(domain => ({ domain, status: 'checking', addedAt: now })),
    ...listEntries.filter(e => !freshSet.has(e.domain))
  ];

  // Keep only the lines that could not be used, so they can be fixed
  bulkInput.value = invalid.join('\n');
  updateBulkCount();
  if (invalid.length) setStatus(`${invalid.length} invalid line(s) left in the box`);

  saveHistorySoon();
  enqueueDomains(fresh);
}

function enqueueDomains(domains) {
  if (domains.length === 0) {
    renderListSoon();
    return;
  }
  if (!bulkRun) {
    bulkRun = { controller: new AbortController(), queue: [], active: new Set(), workers: 0, done: 0, total: 0 };
  }
  bulkRun.queue.push(...domains);
  bulkRun.total += domains.length;

  const run = bulkRun;
  while (run.workers < Math.min(bulkConcurrency(), run.queue.length + run.active.size)) {
    bulkWorker(run);
  }
  renderListSoon();
}

async function bulkWorker(run) {
  run.workers++;
  const { signal } = run.controller;

  try {
    while (!signal.aborted && run.queue.length > 0) {
      const domain = run.queue.shift();
      run.active.add(domain);
      updateEntry(domain, { status: 'checking', note: '' });

      try {
        const result = await fetchWithFallback(domain, {
          signal,
          onStatus: (source, status, detail) => updateEntry(domain, { note: bulkNote(source, status, detail) })
        });
        if (!signal.aborted) recordCheckResult(domain, result);
      } catch (error) {
        if (!signal.aborted) recordCheckError(domain, error);
      } finally {
        run.active.delete(domain);
        if (!signal.aborted) {
          run.done++;
        } else if (findEntry(domain) && findEntry(domain).status === 'checking') {
          // Stopped mid-check (a Home search may have finished this domain meanwhile: keep that)
          updateEntry(domain, { status: 'pending', note: '' });
        }
      }

      if (run.queue.length > 0) await sleep(BULK_DELAY, signal).catch(() => {});
    }
  } finally {
    run.workers--;
    if (run.workers === 0 && bulkRun === run) {
      bulkRun = null;
      if (!signal.aborted) setStatus(`List check finished: ${run.done} domain(s) checked`);
    }
    renderListSoon();
  }
}

// Short progress text shown in the row while it is checked
function bulkNote(source, status, detail) {
  const name = SOURCES[source].name;
  switch (status) {
    case 'loading': return `${name}...`;
    case 'retrying': return `${name}: ${detail}`;
    case 'failed': return `${name} failed, trying next...`;
    case 'empty': return `${name}: no data, trying next...`;
    default: return '';
  }
}

function stopBulkCheck() {
  if (!bulkRun) return;
  const run = bulkRun;
  bulkRun = null;
  run.controller.abort(); // running checks go back to pending
  run.queue = [];
  setStatus('List check stopped. Pending domains can be resumed later.');
  renderListSoon();
}

function resumePending() {
  enqueueDomains(listEntries.filter(e => e.status === 'pending' && !isBusy(e.domain)).map(e => e.domain));
}

function retryFailed() {
  const failed = listEntries.filter(e => e.status === 'error' && !isBusy(e.domain));
  failed.forEach(e => {
    e.status = 'pending';
    e.error = '';
  });
  saveHistorySoon();
  enqueueDomains(failed.map(e => e.domain));
}

// ---------- Open / delete ----------

// Row click: show the domain's calendar on Home, from the saved snapshots
function openFromList(domain) {
  const entry = findEntry(domain);
  if (!entry) return;

  // A search still running on Home must not overwrite what we open now
  if (currentSearchController) {
    currentSearchController.abort();
    currentSearchController = null;
    stopLoadingTimer();
  }

  domainInput.value = domain;
  switchTab('main');

  const checked = entry.checkedAt ? ` (checked ${formatDateTime(entry.checkedAt)})` : '';
  if (entry.status === 'ok' || entry.total > 0) {
    // OK row, or a failed / pending re-check that still has snapshots from before
    const result = snapshotCache[domain] || loadSnapshots(domain);
    if (result) {
      showDomainResult(domain, result, entry.status === 'ok'
        ? `from list${checked}`
        : 'saved snapshots from an earlier check (latest check did not finish)');
      return;
    }
  } else if (entry.status === 'empty') {
    showDomainResult(domain, { snapshots: [], source: null });
    setStatus(`No snapshots found${checked}`);
    return;
  }

  // Not checked yet, failed, or snapshots missing: check it now
  searchDomain();
}

function deleteDomains(domains) {
  const remove = new Set(domains);
  if (bulkRun) {
    const queued = bulkRun.queue.length;
    bulkRun.queue = bulkRun.queue.filter(d => !remove.has(d));
    bulkRun.total -= queued - bulkRun.queue.length; // keep progress (done/total) right
  }
  listEntries = listEntries.filter(e => !remove.has(e.domain));
  remove.forEach(domain => {
    deleteSnapshots(domain);
    selectedDomains.delete(domain);
    delete snapshotCache[domain];
  });
  saveHistorySoon();
  renderListSoon();
}

function deleteSelected() {
  if (selectedDomains.size === 0) return;
  if (!confirm(`Delete ${selectedDomains.size} domain(s) from the list?`)) return;
  deleteDomains([...selectedDomains]);
}

function clearHistory() {
  if (listEntries.length === 0) return;
  if (!confirm(`Delete all ${listEntries.length} domain(s) and their saved snapshots?`)) return;
  stopBulkCheck();
  listEntries = [];
  selectedDomains.clear();
  for (const key of Object.keys(snapshotCache)) delete snapshotCache[key];
  try {
    fs.rmSync(SNAPSHOT_DIR, { recursive: true, force: true });
  } catch (error) {
    console.error('Deleting snapshots failed:', error);
  }
  saveHistoryNow();
  renderListSoon();
  setStatus('History cleared');
}

// ---------- Rendering ----------

function formatTsShort(ts) {
  return ts ? `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}` : '';
}

function formatDateTime(ms) {
  const d = new Date(ms);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function visibleEntries() {
  const search = document.getElementById('listSearch').value.trim().toLowerCase();
  const filter = document.getElementById('listFilter').value;

  let rows = listEntries.filter(e =>
    (!search || e.domain.includes(search)) &&
    (filter === 'all' || e.status === filter || (filter === 'pending' && e.status === 'checking'))
  );

  if (listSort.key) {
    const column = LIST_COLUMNS.find(c => c.key === listSort.key);
    const value = e => (column.type === 'status' ? STATUS_ORDER[e.status] : e[column.key]);
    rows = [...rows].sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      // Empty values always last
      if (va === undefined || va === '') return 1;
      if (vb === undefined || vb === '') return -1;
      const cmp = column.type === 'text' ? String(va).localeCompare(String(vb)) : va - vb;
      return cmp * listSort.dir;
    });
  }
  return rows;
}

// Batch re-renders while a check runs. A timer, not requestAnimationFrame:
// rAF stops while the window is minimized or covered, and the list must keep up.
function renderListSoon() {
  updateListBadge();
  if (listRenderQueued) return;
  listRenderQueued = true;
  setTimeout(() => {
    listRenderQueued = false;
    if (activeTab === 'list') renderList();
  }, 100);
}

function updateListBadge() {
  const badge = document.getElementById('listTabBadge');
  if (!badge) return;
  badge.textContent = bulkRun
    ? `${bulkRun.done}/${bulkRun.total}`
    : (listEntries.length ? String(listEntries.length) : '');
  badge.classList.toggle('running', !!bulkRun);
}

function renderList() {
  const rows = visibleEntries();

  // Header with sort arrows
  document.getElementById('listHead').innerHTML =
    `<th class="col-check"><input type="checkbox" id="listSelectAll" ${rows.length && rows.every(e => selectedDomains.has(e.domain)) ? 'checked' : ''}></th>` +
    LIST_COLUMNS.map(c => {
      const arrow = listSort.key === c.key ? (listSort.dir === 1 ? ' ▲' : ' ▼') : '';
      return `<th data-sort="${c.key}"${c.type === 'number' && c.key !== 'checkedAt' ? ' class="num"' : ''}>${c.label}${arrow}</th>`;
    }).join('') +
    '<th></th>';

  listBody.innerHTML = rows.map(e => {
    const code = e.lastCode || '';
    const codeClass = code.startsWith('2') ? 'code-ok' : code.startsWith('3') ? 'code-redirect' : code ? 'code-bad' : '';
    const resultText = e.status === 'checking' && e.note ? e.note : RESULT_LABELS[e.status];
    const total = e.total === undefined ? '' : `${e.total.toLocaleString()}${e.truncated ? '+' : ''}`;
    const sourceName = e.source && SOURCES[e.source] ? SOURCES[e.source].short : '';

    return `
      <tr data-domain="${escapeHtml(e.domain)}" class="row-${e.status}">
        <td class="col-check"><input type="checkbox" class="row-check" ${selectedDomains.has(e.domain) ? 'checked' : ''}></td>
        <td class="col-domain">${escapeHtml(e.domain)}</td>
        <td><span class="result-badge result-${e.status}" title="${escapeHtml(e.error || e.note || '')}">${escapeHtml(resultText)}</span></td>
        <td class="num">${total}</td>
        <td>${formatTsShort(e.firstSeen)}</td>
        <td>${formatTsShort(e.lastSeen)}</td>
        <td><span class="code ${codeClass}">${escapeHtml(code)}</span></td>
        <td>${formatTsShort(e.last200)}</td>
        <td class="num">${e.years || ''}</td>
        <td>${escapeHtml(sourceName)}</td>
        <td class="col-checked">${e.checkedAt ? formatDateTime(e.checkedAt) : ''}</td>
        <td class="col-actions">
          <button class="row-btn" data-action="wayback" title="Open Wayback calendar in browser">WB</button>
          <button class="row-btn danger" data-action="delete" title="Delete from list">x</button>
        </td>
      </tr>`;
  }).join('');

  document.getElementById('listEmpty').style.display = listEntries.length ? 'none' : 'block';

  // Summary + buttons that depend on the list
  const counts = { ok: 0, empty: 0, error: 0, pending: 0, checking: 0 };
  listEntries.forEach(e => counts[e.status]++);
  document.getElementById('listSummary').textContent = listEntries.length
    ? `${listEntries.length} domains · ${counts.ok} with snapshots · ${counts.empty} no data · ${counts.error} errors` +
      (rows.length !== listEntries.length ? ` · showing ${rows.length}` : '')
    : '';

  const waiting = counts.pending - (bulkRun ? bulkRun.queue.length : 0);
  const resumeBtn = document.getElementById('resumeBtn');
  resumeBtn.style.display = waiting > 0 ? '' : 'none';
  resumeBtn.textContent = `Check pending (${waiting})`;
  const retryBtn = document.getElementById('retryFailedBtn');
  retryBtn.style.display = counts.error > 0 ? '' : 'none';
  retryBtn.textContent = `Retry failed (${counts.error})`;
  const deleteBtn = document.getElementById('deleteSelectedBtn');
  deleteBtn.disabled = selectedDomains.size === 0;
  deleteBtn.textContent = selectedDomains.size ? `Delete selected (${selectedDomains.size})` : 'Delete selected';

  // Progress of the running check
  const progress = document.getElementById('bulkProgress');
  progress.style.display = bulkRun ? 'flex' : 'none';
  if (bulkRun) {
    document.getElementById('bulkProgressText').textContent =
      `Checking ${bulkRun.done}/${bulkRun.total} · ${bulkRun.active.size} running` +
      (proxyState.enabled ? ` · via ${proxyState.count} proxies` : '');
    document.getElementById('bulkProgressBar').style.width =
      `${bulkRun.total ? (bulkRun.done / bulkRun.total) * 100 : 0}%`;
  }
}

function updateBulkCount() {
  const { domains } = parseDomainList(bulkInput.value);
  document.getElementById('bulkCount').textContent = domains.length ? `${domains.length} domain(s)` : '';
}

// ---------- Export ----------

const EXPORT_HEADER = ['domain', 'result', 'snapshots', 'first_seen', 'last_seen', 'last_code', 'last_200', 'years', 'source', 'checked_at', 'error'];

function exportRows() {
  return visibleEntries().map(e => [
    e.domain,
    RESULT_LABELS[e.status],
    e.total === undefined ? '' : `${e.total}${e.truncated ? '+' : ''}`,
    formatTsShort(e.firstSeen),
    formatTsShort(e.lastSeen),
    e.lastCode || '',
    formatTsShort(e.last200),
    e.years || '',
    e.source && SOURCES[e.source] ? SOURCES[e.source].name : '',
    e.checkedAt ? formatDateTime(e.checkedAt) : '',
    e.error || ''
  ]);
}

async function exportListCsv() {
  const rows = exportRows();
  if (rows.length === 0) return;
  const cell = v => (/[",\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  // "sep=," makes Excel split columns correctly in every regional setting
  const csv = 'sep=,\r\n' + [EXPORT_HEADER, ...rows].map(r => r.map(cell).join(',')).join('\r\n');
  const stamp = formatDateTime(Date.now()).replace(/[-: ]/g, '').slice(0, 12);

  try {
    const res = await ipcRenderer.invoke('save-text-file', { defaultName: `wayback-list-${stamp}.csv`, content: csv });
    if (res.saved) setStatus(`Exported ${rows.length} domain(s) to ${res.filePath}`);
  } catch (error) {
    // e.g. the file is open in Excel
    alert(`Export failed: ${error.message.replace(/^Error invoking remote method '[^']+': /, '')}`);
  }
}

function copyList() {
  const rows = exportRows();
  if (rows.length === 0) return;
  // Tab-separated: pastes straight into Excel / Google Sheets columns
  const text = [EXPORT_HEADER, ...rows].map(r => r.join('\t')).join('\n');
  navigator.clipboard.writeText(text).then(() => setStatus(`Copied ${rows.length} domain(s)`));
}

// ---------- Events ----------

function importDomainFile() {
  document.getElementById('bulkFileInput').click();
}

document.getElementById('bulkFileInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  file.text().then(text => {
    bulkInput.value = (bulkInput.value.trim() ? bulkInput.value.trim() + '\n' : '') + text;
    updateBulkCount();
  });
  e.target.value = '';
});

bulkInput.addEventListener('input', updateBulkCount);
document.getElementById('listSearch').addEventListener('input', renderList);
document.getElementById('listFilter').addEventListener('change', renderList);

document.getElementById('listHead').addEventListener('click', (e) => {
  if (e.target.id === 'listSelectAll') {
    visibleEntries().forEach(row => (e.target.checked ? selectedDomains.add(row.domain) : selectedDomains.delete(row.domain)));
    renderList();
    return;
  }
  const th = e.target.closest('th[data-sort]');
  if (!th) return;
  // Click cycles: ascending -> descending -> list order
  if (listSort.key !== th.dataset.sort) listSort = { key: th.dataset.sort, dir: 1 };
  else if (listSort.dir === 1) listSort.dir = -1;
  else listSort = { key: null, dir: 1 };
  renderList();
});

listBody.addEventListener('click', (e) => {
  const row = e.target.closest('tr[data-domain]');
  if (!row) return;
  const domain = row.dataset.domain;

  if (e.target.classList.contains('row-check')) {
    if (e.target.checked) selectedDomains.add(domain);
    else selectedDomains.delete(domain);
    renderList();
    return;
  }

  const action = e.target.closest('[data-action]');
  if (action && action.dataset.action === 'wayback') {
    ipcRenderer.send('open-external', `https://web.archive.org/web/*/${domain}`);
  } else if (action && action.dataset.action === 'delete') {
    deleteDomains([domain]);
  } else {
    openFromList(domain);
  }
});

// Init
renderTabs();
updateBulkCount();
