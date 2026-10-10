const { ipcRenderer } = require('electron');

// Source configurations (tried in this order)
// archive: sources with the same archive share one index (an answer from either counts for both).
// timeout covers the whole request incl. body; web.archive.org itself drops requests after ~30s.
// retries apply only to transient errors (HTTP 429/5xx, dropped connection), not to timeouts.
const SOURCES = {
  wayback: {
    name: 'Wayback CDX',
    short: 'WB',
    color: '#00d4ff',
    archive: 'wayback',
    timeout: 30000,
    retries: 2
  },
  timemap: {
    name: 'Wayback Timemap',
    short: 'TM',
    color: '#ffc800',
    archive: 'wayback',
    timeout: 30000,
    retries: 1
  },
  arquivo: {
    name: 'Arquivo.pt',
    short: 'PT',
    color: '#7cff6b',
    archive: 'arquivo',
    timeout: 20000,
    retries: 1
  }
};

// Max snapshots requested per source (Wayback/Timemap return the newest N)
const SNAPSHOT_LIMIT = 10000;

// HTTP statuses worth retrying: rate limit / overloaded / gateway problems
const RETRYABLE_STATUS = [429, 500, 502, 503, 504];

// Rotating proxy mode (set in the Proxy dialog; requests then go through the main process)
const proxyState = { enabled: false, count: 0 };
let proxyRequestId = 0;

// Global state
let currentDomain = '';
let allSnapshots = [];
let snapshotsByYear = {};
let snapshotsByMonth = {};
let selectedYear = null;
let selectedMonth = null;
let currentSource = null;

// Tab state
let tabs = [
  { id: 'main', title: 'Home', type: 'main' },
  { id: 'list', title: 'List', type: 'list' }
];
let activeTab = 'main';
let currentPreviewUrl = '';

// Loading timer state
let loadingTimerInterval = null;
let loadingStartTime = null;

// Preview timer state
let previewTimerInterval = null;
let previewStartTime = null;

// Cache for multi-source results (memory only, cleared on app close)
const snapshotCache = {};

// Abort controller of the search in progress (Cancel button / superseded by a new search)
let currentSearchController = null;

// DOM Elements
const domainInput = document.getElementById('domainInput');
const searchBtn = document.getElementById('searchBtn');
const statsBar = document.getElementById('statsBar');
const welcomeScreen = document.getElementById('welcomeScreen');
const loadingScreen = document.getElementById('loadingScreen');
const resultsScreen = document.getElementById('resultsScreen');
const errorScreen = document.getElementById('errorScreen');
const yearTabs = document.getElementById('yearTabs');
const monthGrid = document.getElementById('monthGrid');
const snapshotsList = document.getElementById('snapshotsList');

// Event Listeners
domainInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') searchDomain();
});

// Clean domain input (URL parts, www.) and convert unicode domains to punycode,
// so a domain always maps to the same list row / saved snapshot file
function cleanDomain(domain) {
  const host = domain
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '')
    .split('/')[0];
  try {
    return new URL(`http://${host}`).hostname;
  } catch (error) {
    return host;
  }
}

// Main search function
async function searchDomain() {
  const domain = cleanDomain(domainInput.value);

  if (!domain) {
    alert('Please enter a domain');
    return;
  }

  // Results show on Home (the search box is also reachable from List / previews)
  if (activeTab !== 'main') switchTab('main');

  // Abort a search that is still running so its late result can't overwrite this one
  if (currentSearchController) currentSearchController.abort();
  const controller = new AbortController();
  currentSearchController = controller;

  currentDomain = domain;
  currentSource = null;
  showScreen('loading');
  setStatus(`Searching archives for ${domain}...`);
  startLoadingTimer();

  try {
    // Same session: reuse the result instead of hitting the archives again
    let result = snapshotCache[domain];
    if (!result) {
      result = await fetchWithFallback(domain, { signal: controller.signal, onStatus: updateLoadingStatus });
      // Cancelled or superseded: cancelFetch() / the newer search owns the UI now
      if (controller.signal.aborted) return;
      if (result.snapshots.length > 0) snapshotCache[domain] = result;
      recordCheckResult(domain, result, { addToTop: true });
    }
    stopLoadingTimer();
    showDomainResult(domain, result);

  } catch (error) {
    if (controller.signal.aborted) return;
    stopLoadingTimer();
    console.error('Error:', error);
    recordCheckError(domain, error, { addToTop: true });
    showScreen('error');

    let errorMsg = `Failed to fetch from all archives. Please try again later. (${error.message})`;
    if (!navigator.onLine) {
      errorMsg = 'Network error. Please check your internet connection.';
    }

    document.getElementById('errorMessage').textContent = errorMsg;
    setStatus('Error');
  } finally {
    if (currentSearchController === controller) currentSearchController = null;
  }
}

// Show a domain's snapshots on the Home tab (after a search, or opened from the List)
function showDomainResult(domain, result, note = '') {
  currentDomain = domain;

  if (!result.snapshots || result.snapshots.length === 0) {
    showScreen('error');
    document.getElementById('errorMessage').textContent =
      `No archived snapshots found for "${domain}"`;
    setStatus('No snapshots found');
    return;
  }

  allSnapshots = result.snapshots;
  currentSource = result.source;
  processSnapshots(result.snapshots);
  displayResults();
  showScreen('results');

  // Show source indicator in stats bar
  const sourceInfo = SOURCES[result.source];
  document.getElementById('sourceIndicator').innerHTML =
    `<span class="source-indicator ${sourceInfo.short.toLowerCase()}">${sourceInfo.name}</span>`;

  let status = `Loaded ${result.snapshots.length.toLocaleString()} snapshots from ${sourceInfo.name}`;

  // Hit the request limit: there are more snapshots than shown
  if (result.snapshots.length >= SNAPSHOT_LIMIT) {
    document.getElementById('totalSnapshots').textContent =
      `${result.snapshots.length.toLocaleString()}+`;
    status += ' (limit reached, not all snapshots shown)';
  }

  setStatus(note ? `${status} - ${note}` : status);
}

// Fetchers per source, same order as SOURCES
const FETCHERS = {
  wayback: fetchWaybackCDX,
  timemap: fetchWaybackTimemap,
  arquivo: fetchArquivo
};

// Fallback fetch: Wayback CDX -> Wayback Timemap -> Arquivo.pt
// ctx: { signal, onStatus(source, status, detail) } — onStatus reports progress
// (the loading screen for a search, the row note for a List check).
async function fetchWithFallback(domain, ctx) {
  const { signal, onStatus } = ctx;
  const failures = [];
  const answeredArchives = new Set(); // archives that answered "no snapshots"

  for (const source of Object.keys(SOURCES)) {
    const info = SOURCES[source];
    // Same index already answered "no snapshots" (e.g. Timemap after CDX)
    if (answeredArchives.has(info.archive)) continue;

    onStatus(source, 'loading');
    try {
      const snapshots = await FETCHERS[source](domain, ctx);
      if (snapshots.length > 0) {
        onStatus(source, 'success');
        return { snapshots, source };
      }
      onStatus(source, 'empty');
      answeredArchives.add(info.archive);
    } catch (error) {
      if (signal.aborted) throw error;
      console.error(`${info.name} failed:`, error.message);
      onStatus(source, 'failed');
      failures.push({ archive: info.archive, message: `${info.name}: ${error.message}` });
    }
  }

  // Every archive answered and none has data -> genuinely no snapshots
  if (failures.every(f => answeredArchives.has(f.archive))) {
    return { snapshots: [], source: null };
  }

  throw new Error(failures.map(f => f.message).join(' | '));
}

// Fetch a URL as text. The timeout covers the whole request including the body,
// and the search signal aborts it immediately (Cancel button / new search).
async function fetchText(url, timeout, signal) {
  if (signal.aborted) throw new Error('Search cancelled');
  if (proxyState.enabled) return fetchTextViaProxy(url, timeout, signal);

  const controller = new AbortController();
  const abort = () => controller.abort();
  const timeoutId = setTimeout(abort, timeout);
  signal.addEventListener('abort', abort);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;
      error.retryAfter = parseInt(response.headers.get('Retry-After'), 10);
      throw error;
    }
    return await response.text();
  } catch (error) {
    if (signal.aborted) throw new Error('Search cancelled');
    if (error.name === 'AbortError') throw new Error(`timed out after ${timeout / 1000}s`);
    throw error;
  } finally {
    clearTimeout(timeoutId);
    signal.removeEventListener('abort', abort);
  }
}

// Same as fetchText, but through the next rotating proxy (main process does the request).
// Proxy problems (dead proxy, timeout, rejected login) are marked `network` so the
// retry goes out through another proxy.
async function fetchTextViaProxy(url, timeout, signal) {
  const id = ++proxyRequestId;
  let abort;
  // Cancel answers right away; the main process stops the request in the background
  const cancelled = new Promise((resolve, reject) => {
    abort = () => {
      ipcRenderer.send('proxy-fetch-abort', id);
      reject(new Error('Search cancelled'));
    };
  });
  signal.addEventListener('abort', abort);

  try {
    const result = await Promise.race([ipcRenderer.invoke('proxy-fetch', { id, url, timeout }), cancelled]);
    if (signal.aborted) throw new Error('Search cancelled');

    if (result.error || result.status === 407) {
      const reason = result.error || 'proxy rejected the username/password (407)';
      const error = new Error(`${reason} (proxy ${result.proxy})`);
      error.network = true;
      throw error;
    }
    if (result.status < 200 || result.status >= 300) {
      const error = new Error(`HTTP ${result.status} (proxy ${result.proxy})`);
      error.status = result.status;
      error.retryAfter = parseInt(result.retryAfter, 10);
      throw error;
    }
    return result.text;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

// Wait ms, but stop right away if the search is cancelled
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeoutId);
      reject(new Error('Search cancelled'));
    };
    const timeoutId = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort);
  });
}

// Fetch with retry on transient errors. Wayback often answers
// "503 Temporarily Offline" for a moment, so a short wait usually fixes it.
async function fetchWithRetry(source, url, ctx) {
  const { signal, onStatus } = ctx;
  const { timeout, retries } = SOURCES[source];

  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchText(url, timeout, signal);
    } catch (error) {
      // HTTP error -> retry on 429/5xx only; no status -> connection failed
      // (TypeError from fetch, or a proxy error marked `network`)
      const retryable = error.status
        ? RETRYABLE_STATUS.includes(error.status)
        : error.network || error.name === 'TypeError';
      if (signal.aborted || !retryable || attempt >= retries) throw error;

      // Honor Retry-After (capped at 10s), otherwise back off 2s, 4s, ...
      const delay = error.retryAfter > 0
        ? Math.min(error.retryAfter, 10) * 1000
        : 2000 * (attempt + 1);
      onStatus(source, 'retrying', `${error.message}, retry ${attempt + 1}/${retries} in ${delay / 1000}s`);
      await sleep(delay, signal);
    }
  }
}

// Page URL of one snapshot in its archive
function snapshotUrl(source, timestamp, originalUrl) {
  return source === 'arquivo'
    ? `https://arquivo.pt/wayback/${timestamp}/${originalUrl}`
    : `https://web.archive.org/web/${timestamp}/${originalUrl}`;
}

// Parse Wayback CDX/Timemap JSON (first row = field names) into snapshots
function parseWaybackRows(data, source) {
  if (!Array.isArray(data) || data.length <= 1) return [];

  const header = data[0];
  const tsIdx = header.indexOf('timestamp');
  const urlIdx = header.indexOf('original');
  const statusIdx = header.indexOf('statuscode');

  return data.slice(1).map(row => ({
    timestamp: row[tsIdx],
    originalUrl: row[urlIdx],
    url: snapshotUrl(source, row[tsIdx], row[urlIdx]),
    statusCode: row[statusIdx] || '200',
    source
  }));
}

// Fetch from Wayback Machine CDX API (primary).
// Negative limit = newest N snapshots; fl keeps the payload small.
async function fetchWaybackCDX(domain, ctx) {
  const url = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(domain)}` +
    `&output=json&fl=timestamp,original,statuscode&limit=-${SNAPSHOT_LIMIT}`;
  const text = await fetchWithRetry('wayback', url, ctx);
  return parseWaybackRows(JSON.parse(text || '[]'), 'wayback');
}

// Fetch from Wayback Timemap API (fallback, different Wayback endpoint).
// Exact match + limit: without them it returns every URL under the domain (can be 90+ MB).
async function fetchWaybackTimemap(domain, ctx) {
  const url = `https://web.archive.org/web/timemap/json?url=${encodeURIComponent(domain)}` +
    `&matchType=exact&fl=timestamp,original,statuscode&limit=-${SNAPSHOT_LIMIT}`;
  const text = await fetchWithRetry('timemap', url, ctx);
  return parseWaybackRows(JSON.parse(text || '[]'), 'timemap');
}

// Fetch from Arquivo.pt CDX API (fallback, independent archive used when Wayback is down).
// Free, no API key; coverage of non-.pt sites is smaller than Wayback.
async function fetchArquivo(domain, ctx) {
  const url = `https://arquivo.pt/wayback/cdx?url=${encodeURIComponent(domain)}` +
    `&output=json&sort=reverse&limit=${SNAPSHOT_LIMIT}`;
  const text = await fetchWithRetry('arquivo', url, ctx);

  // Response is NDJSON: one JSON object per line (empty body = no snapshots)
  return text.split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line))
    .map(row => ({
      timestamp: row.timestamp,
      originalUrl: row.url,
      url: snapshotUrl('arquivo', row.timestamp, row.url),
      statusCode: row.status || '200',
      source: 'arquivo'
    }));
}

// Update loading status UI during fallback
function updateLoadingStatus(source, status, detail = '') {
  const info = SOURCES[source];
  if (!info) return;

  const statusEl = document.getElementById('loadingStatus');
  const loadingText = document.getElementById('loadingText');

  let icon = '';
  let text = '';

  switch (status) {
    case 'loading':
      icon = '...';
      text = `Trying ${info.name}...`;
      break;
    case 'retrying':
      icon = '...';
      text = `${info.name} - ${detail}`;
      break;
    case 'success':
      icon = '[OK]';
      text = `${info.name} - Success!`;
      break;
    case 'failed':
      icon = '[X]';
      text = `${info.name} - Failed, trying next...`;
      break;
    case 'empty':
      icon = '[-]';
      text = `${info.name} - No data, trying next...`;
      break;
  }

  if (statusEl) {
    statusEl.innerHTML = `<span style="color: ${info.color}">${icon} ${text}</span>`;
  }

  if (loadingText) {
    loadingText.textContent = text;
  }
}

// Process snapshots into organized structure
function processSnapshots(snapshots) {
  allSnapshots = snapshots;
  snapshotsByYear = {};
  snapshotsByMonth = {};

  snapshots.forEach(snap => {
    const timestamp = snap.timestamp;
    const year = timestamp.substring(0, 4);
    const month = timestamp.substring(4, 6);
    const yearMonth = `${year}-${month}`;

    if (!snapshotsByYear[year]) {
      snapshotsByYear[year] = [];
    }
    snapshotsByYear[year].push(snap);

    if (!snapshotsByMonth[yearMonth]) {
      snapshotsByMonth[yearMonth] = [];
    }
    snapshotsByMonth[yearMonth].push(snap);
  });

  updateStats();
}

// Update stats bar
function updateStats() {
  const years = Object.keys(snapshotsByYear).sort();
  // Snapshots are sorted descending, so first element = newest, last = oldest
  const sorted = [...allSnapshots].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const firstTs = sorted[0].timestamp;
  const lastTs = sorted[sorted.length - 1].timestamp;

  document.getElementById('totalSnapshots').textContent = allSnapshots.length.toLocaleString();
  document.getElementById('firstSeen').textContent = formatDate(firstTs);
  document.getElementById('lastSeen').textContent = formatDate(lastTs);
  document.getElementById('yearsActive').textContent = `${years.length} (${years[0]} - ${years[years.length - 1]})`;

  statsBar.style.display = 'flex';
}

// Display results
function displayResults() {
  // Create year tabs
  const years = Object.keys(snapshotsByYear).sort().reverse();
  yearTabs.innerHTML = years.map(year => {
    const count = snapshotsByYear[year].length;
    return `
      <button class="year-tab" data-year="${year}" onclick="selectYear('${year}')">
        ${year} <span class="count">(${count})</span>
      </button>
    `;
  }).join('');

  // Select most recent year by default
  selectYear(years[0]);
}

// Select year
function selectYear(year) {
  selectedYear = year;
  selectedMonth = null;

  // Update active tab
  document.querySelectorAll('.year-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.year === year);
  });

  // Update calendar title
  document.getElementById('calendarTitle').textContent = `Calendar ${year}`;

  // Generate month grid
  generateMonthGrid(year);

  // Show all snapshots for this year
  displaySnapshots(snapshotsByYear[year]);
}

// Generate month grid
function generateMonthGrid(year) {
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
  ];

  monthGrid.innerHTML = months.map((monthName, index) => {
    const monthNum = String(index + 1).padStart(2, '0');
    const yearMonth = `${year}-${monthNum}`;
    const count = snapshotsByMonth[yearMonth] ? snapshotsByMonth[yearMonth].length : 0;
    const isEmpty = count === 0;
    const isActive = selectedMonth === monthNum;

    return `
      <div class="month-card ${isEmpty ? 'empty' : ''} ${isActive ? 'active' : ''}" 
           data-month="${monthNum}"
           onclick="${isEmpty ? '' : `selectMonth('${monthNum}')`}">
        <div class="month-name">${monthName}</div>
        <div class="month-count">${count}</div>
      </div>
    `;
  }).join('');
}

// Select month
function selectMonth(month) {
  selectedMonth = month;

  // Update active month card
  document.querySelectorAll('.month-card').forEach(card => {
    card.classList.toggle('active', card.dataset.month === month);
  });

  // Show snapshots for this month
  const yearMonth = `${selectedYear}-${month}`;
  const snapshots = snapshotsByMonth[yearMonth] || [];
  displaySnapshots(snapshots);
}

// Escape a value for safe insertion into HTML (text and attribute context)
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Display snapshots list
function displaySnapshots(snapshots) {
  const count = snapshots.length;
  document.getElementById('snapshotCount').textContent = `(${count} snapshots)`;

  if (count === 0) {
    snapshotsList.innerHTML = '<div class="snapshot-item"><span>No snapshots for this period</span></div>';
    return;
  }

  // Sort by timestamp descending (newest first)
  const sorted = [...snapshots].sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  snapshotsList.innerHTML = sorted.map(snap => {
    const source = SOURCES[snap.source] || SOURCES.wayback;
    const date = formatDate(snap.timestamp);
    const time = formatTime(snap.timestamp);
    const snapUrl = snap.url;

    // Status icon - text based (compare numerically)
    let statusIcon = '*';
    const statusCode = String(snap.statusCode || '');
    const statusNum = parseInt(statusCode, 10);
    if (statusCode === '301' || statusCode === '302') statusIcon = '>';
    else if (statusCode === '404') statusIcon = 'x';
    else if (statusNum >= 500) statusIcon = '!';

    // URLs and dates are passed via escaped data-* attributes (not inline JS)
    // to avoid breakage / code injection from quotes in archived URLs.
    return `
      <div class="snapshot-item" data-url="${escapeHtml(snapUrl)}" data-date="${escapeHtml(date)}">
        <div class="snapshot-info">
          <span class="snapshot-source" style="background: ${source.color}20; color: ${source.color}; border: 1px solid ${source.color}40;" title="${escapeHtml(source.name)}">
            ${escapeHtml(source.short)}
          </span>
          <span class="snapshot-icon status-${escapeHtml(statusCode)}">${statusIcon}</span>
          <span class="snapshot-date">${escapeHtml(date)}</span>
          <span class="snapshot-time">${escapeHtml(time)}</span>
          <span class="snapshot-status">[${escapeHtml(statusCode)}]</span>
        </div>
        <div class="snapshot-actions">
          <button class="snapshot-btn" data-action="copy">Copy</button>
          <button class="snapshot-btn" data-action="preview">Preview</button>
          <button class="snapshot-btn primary" data-action="open">Open</button>
        </div>
      </div>
    `;
  }).join('');
}

// Event delegation for snapshot action buttons (replaces inline onclick).
// Robust against quotes/special chars in archived URLs.
snapshotsList.addEventListener('click', (e) => {
  const btn = e.target.closest('.snapshot-btn');
  if (!btn) return;
  const item = btn.closest('.snapshot-item');
  if (!item) return;

  const url = item.dataset.url;
  const date = item.dataset.date;
  if (!url) return;

  switch (btn.dataset.action) {
    case 'copy': copyUrl(url); break;
    case 'preview': openPreview(url, date); break;
    case 'open': openSnapshot(url); break;
  }
});

// Open snapshot in external browser
function openSnapshot(url) {
  ipcRenderer.send('open-external', url);
}

// Copy URL to clipboard
function copyUrl(url) {
  navigator.clipboard.writeText(url).then(() => {
    setStatus('URL copied to clipboard!');
    setTimeout(() => setStatus('Ready'), 2000);
  });
}

// Helper: Format date
function formatDate(timestamp) {
  const year = timestamp.substring(0, 4);
  const month = timestamp.substring(4, 6);
  const day = timestamp.substring(6, 8);
  
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 
                      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  
  return `${monthNames[parseInt(month) - 1]} ${parseInt(day)}, ${year}`;
}

// Helper: Format time
function formatTime(timestamp) {
  const hour = timestamp.substring(8, 10) || '00';
  const min = timestamp.substring(10, 12) || '00';
  const sec = timestamp.substring(12, 14) || '00';
  
  return `${hour}:${min}:${sec}`;
}

// Helper: Show screen
function showScreen(screen) {
  welcomeScreen.style.display = screen === 'welcome' ? 'flex' : 'none';
  loadingScreen.style.display = screen === 'loading' ? 'flex' : 'none';
  resultsScreen.style.display = screen === 'results' ? 'flex' : 'none';
  errorScreen.style.display = screen === 'error' ? 'flex' : 'none';
  
  if (screen === 'welcome' || screen === 'error') {
    statsBar.style.display = 'none';
  }
}

// Helper: Set status text
function setStatus(text) {
  document.getElementById('statusText').textContent = text;
}

// Convert Wayback URL to raw format (skip toolbar for faster loading)
function toRawWaybackUrl(url) {
  return url.replace(/\/web\/(\d{14})\//, '/web/$1id_/');
}

// Check if URL is raw Wayback format
function isRawWaybackUrl(url) {
  return /\/web\/\d{14}id_\//.test(url);
}

// Open snapshot in preview tab (di dalam app)
function openPreview(url, date) {
  const tabId = 'preview-' + Date.now();
  const tab = {
    id: tabId,
    title: date,
    type: 'preview',
    url: url
  };

  tabs.push(tab);
  renderTabs();
  switchTab(tabId);

  // Load URL in webview
  currentPreviewUrl = url;
  document.getElementById('previewUrl').textContent = url;

  // Show loading, hide error
  showPreviewLoading(true);
  showPreviewError(false);
  updatePreviewStatus('Connecting to Wayback Machine...');

  const webview = document.getElementById('previewWebview');
  webview.src = toRawWaybackUrl(url);

  // Show preview container, hide main content
  document.getElementById('previewContainer').style.display = 'flex';
  document.querySelector('.main-content').style.display = 'none';
  document.getElementById('statsBar').style.display = 'none';
}

// Switch between tabs
function switchTab(tabId) {
  activeTab = tabId;

  // Update tab UI
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tabId);
  });

  const listContainer = document.getElementById('listContainer');

  if (tabId === 'main') {
    // Show main content
    document.getElementById('previewContainer').style.display = 'none';
    listContainer.style.display = 'none';
    document.querySelector('.main-content').style.display = 'flex';
    if (allSnapshots.length > 0 && resultsScreen.style.display !== 'none') {
      document.getElementById('statsBar').style.display = 'flex';
    }
  } else if (tabId === 'list') {
    // Show domain list (bulk check + history)
    document.getElementById('previewContainer').style.display = 'none';
    document.querySelector('.main-content').style.display = 'none';
    document.getElementById('statsBar').style.display = 'none';
    listContainer.style.display = 'flex';
    renderList();
  } else {
    // Show preview
    const tab = tabs.find(t => t.id === tabId);
    if (tab && tab.url) {
      currentPreviewUrl = tab.url;
      document.getElementById('previewUrl').textContent = tab.url;
      document.getElementById('previewWebview').src = toRawWaybackUrl(tab.url);
      document.getElementById('previewContainer').style.display = 'flex';
      listContainer.style.display = 'none';
      document.querySelector('.main-content').style.display = 'none';
      document.getElementById('statsBar').style.display = 'none';
    }
  }
}

// Render tabs
function renderTabs() {
  const tabBar = document.getElementById('tabBar');
  const closeAllBtn = tabBar.querySelector('.new-tab-btn');

  // Remove existing tabs except close all button
  tabBar.querySelectorAll('.tab').forEach(t => t.remove());

  // Add tabs
  tabs.forEach(tab => {
    const tabEl = document.createElement('div');
    tabEl.className = `tab ${tab.id === activeTab ? 'active' : ''}`;
    tabEl.dataset.tab = tab.id;
    tabEl.onclick = () => switchTab(tab.id);

    if (tab.type === 'main') {
      tabEl.innerHTML = `Home`;
    } else if (tab.type === 'list') {
      tabEl.innerHTML = `List <span class="tab-badge" id="listTabBadge"></span>`;
    } else {
      tabEl.innerHTML = `
        ${tab.title}
        <span class="close-tab" onclick="event.stopPropagation(); closeTab('${tab.id}')">x</span>
      `;
    }

    tabBar.insertBefore(tabEl, closeAllBtn);
  });

  updateListBadge();
}

// Close single tab
function closeTab(tabId) {
  tabs = tabs.filter(t => t.id !== tabId);

  if (activeTab === tabId) {
    switchTab('main');
  }

  renderTabs();
}

// Close all preview tabs (Home and List stay)
function closeAllTabs() {
  const onPreview = tabs.some(t => t.id === activeTab && t.type === 'preview');
  tabs = tabs.filter(t => t.type !== 'preview');
  if (onPreview) switchTab('main');
  renderTabs();
}

// Close current preview
function closePreview() {
  if (tabs.some(t => t.id === activeTab && t.type === 'preview')) {
    closeTab(activeTab);
  }
}

// Reload preview
function reloadPreview() {
  showPreviewLoading(true);
  showPreviewError(false);
  updatePreviewStatus('Reloading...');

  const webview = document.getElementById('previewWebview');
  webview.reload();
}

// Open current preview URL in external browser
function openExternal() {
  if (currentPreviewUrl) {
    ipcRenderer.send('open-external', currentPreviewUrl);
  }
}

// Webview event listeners
document.addEventListener('DOMContentLoaded', () => {
  const webview = document.getElementById('previewWebview');

  if (webview) {
    // Loading started
    webview.addEventListener('did-start-loading', () => {
      showPreviewLoading(true);
      startPreviewTimer();
    });

    // Loading progress
    webview.addEventListener('did-navigate', (e) => {
      updatePreviewStatus('Connecting to Wayback Machine...');
    });

    // DOM ready (page structure loaded) - hide overlay early for faster UX
    webview.addEventListener('dom-ready', () => {
      // Check if page is blank when using raw URL, fallback to normal URL
      const currentSrc = webview.getURL();
      if (isRawWaybackUrl(currentSrc)) {
        webview.executeJavaScript('document.body ? document.body.innerText.trim().length : 0')
          .then(textLen => {
            if (textLen === 0) {
              // Page is blank, reload with normal URL (with Wayback toolbar)
              const normalUrl = currentSrc.replace(/\/web\/(\d{14})id_\//, '/web/$1/');
              updatePreviewStatus('Retrying with full page mode...');
              webview.src = normalUrl;
              return;
            }
            stopPreviewTimer();
            showPreviewLoading(false);
            showPreviewError(false);
            updatePreviewStatus('Page loaded (assets may still be loading...)');
          })
          .catch(() => {
            stopPreviewTimer();
            showPreviewLoading(false);
            showPreviewError(false);
          });
      } else {
        stopPreviewTimer();
        showPreviewLoading(false);
        showPreviewError(false);
        updatePreviewStatus('Page loaded (assets may still be loading...)');
      }
    });

    // Fully loaded
    webview.addEventListener('did-finish-load', () => {
      setStatus('Fully loaded');
    });

    // Load failed
    webview.addEventListener('did-fail-load', (e) => {
      // Ignore aborted loads (user navigated away)
      if (e.errorCode === -3) return;

      stopPreviewTimer();
      showPreviewLoading(false);
      showPreviewError(true, getErrorMessage(e.errorCode, e.errorDescription));
      setStatus('Failed to load snapshot');
    });

    // Page unresponsive
    webview.addEventListener('unresponsive', () => {
      updatePreviewStatus('Page is unresponsive, please wait...');
    });

    // Page responsive again
    webview.addEventListener('responsive', () => {
      updatePreviewStatus('Loading...');
    });
  }
});

// Show/hide loading overlay
function showPreviewLoading(show) {
  const overlay = document.getElementById('previewOverlay');
  if (overlay) {
    overlay.style.display = show ? 'flex' : 'none';
  }
}

// Show/hide error overlay
function showPreviewError(show, message = '') {
  const errorOverlay = document.getElementById('previewError');
  const errorDetail = document.getElementById('errorDetail');

  if (errorOverlay) {
    errorOverlay.style.display = show ? 'flex' : 'none';
  }

  if (errorDetail && message) {
    errorDetail.textContent = message;
  }
}

// Update loading status text
function updatePreviewStatus(text) {
  const status = document.getElementById('previewStatus');
  if (status) {
    status.textContent = text;
  }
}

// Get friendly error message
function getErrorMessage(code, description) {
  const errorMessages = {
    '-2': 'Network error. Check your internet connection.',
    '-3': 'Loading aborted.',
    '-6': 'File not found on Wayback Machine.',
    '-7': 'Too many redirects.',
    '-100': 'Connection closed.',
    '-101': 'Connection reset.',
    '-102': 'Connection refused.',
    '-104': 'Connection failed.',
    '-105': 'Could not resolve host.',
    '-106': 'Internet disconnected.',
    '-109': 'Address unreachable.',
    '-118': 'Connection timed out.',
    '-130': 'Proxy connection failed.',
    '-200': 'Certificate error.',
    '-501': 'Server does not support request.',
  };

  return errorMessages[String(code)] || `Error ${code}: ${description || 'Unknown error'}`;
}

// Loading timer - shows elapsed seconds during fetch
function startLoadingTimer() {
  stopLoadingTimer(); // a superseded search may have left its timer running
  loadingStartTime = Date.now();
  const timerEl = document.getElementById('loadingTimer');
  const warningEl = document.getElementById('loadingSlowWarning');
  const loadingText = document.getElementById('loadingText');

  if (timerEl) timerEl.style.display = 'block';
  if (warningEl) warningEl.style.display = 'none';

  loadingTimerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - loadingStartTime) / 1000);
    if (timerEl) timerEl.textContent = `${elapsed}s`;

    // Show warning after 15 seconds
    if (elapsed >= 15 && warningEl) {
      warningEl.style.display = 'block';
      if (loadingText) loadingText.textContent = 'Still fetching, Wayback Machine is slow...';
    }
  }, 1000);
}

function stopLoadingTimer() {
  if (loadingTimerInterval) {
    clearInterval(loadingTimerInterval);
    loadingTimerInterval = null;
  }
  loadingStartTime = null;
}

// Cancel current fetch
function cancelFetch() {
  if (currentSearchController) {
    currentSearchController.abort();
    currentSearchController = null;
  }
  stopLoadingTimer();
  showScreen('error');
  document.getElementById('errorMessage').textContent = 'Search cancelled.';
  setStatus('Cancelled');
}

// Preview timer - shows elapsed seconds during preview loading
function startPreviewTimer() {
  previewStartTime = Date.now();

  previewTimerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - previewStartTime) / 1000);
    const statusEl = document.getElementById('previewStatus');

    if (statusEl) {
      if (elapsed >= 15) {
        statusEl.textContent = `Still loading... (${elapsed}s) - Try "Open in Browser" if too slow`;
      } else {
        statusEl.textContent = `Loading snapshot... (${elapsed}s)`;
      }
    }
  }, 1000);
}

function stopPreviewTimer() {
  if (previewTimerInterval) {
    clearInterval(previewTimerInterval);
    previewTimerInterval = null;
  }
  previewStartTime = null;
}

// ==================== APP VERSION ====================

ipcRenderer.on('app-version', (event, version) => {
  const el = document.getElementById('appVersion');
  if (el) el.textContent = 'v' + version;
});

// ==================== MANDATORY UPDATE POPUP ====================
// Once an update is found the popup covers the whole app and can't be closed:
// the update downloads automatically and the app restarts into the new version.

let updateAction = null; // 'install' | 'check'

ipcRenderer.on('update-status', (event, data) => {
  const modal = document.getElementById('updateModal');
  const title = document.getElementById('updateTitle');
  const text = document.getElementById('updateText');
  const btn = document.getElementById('updateBtn');
  const progress = document.getElementById('updateProgress');
  const progressBar = document.getElementById('updateProgressBar');

  if (data.status === 'not-available') {
    modal.style.display = 'none';
    return;
  }

  // Block the app; drop focus so Enter can't start a search behind the popup
  modal.style.display = 'flex';
  if (document.activeElement) document.activeElement.blur();

  switch (data.status) {
    case 'available':
      modal.className = 'update-modal available';
      title.textContent = 'Update Required';
      text.textContent = `Version v${data.version} is available and required to continue. Downloading...`;
      btn.style.display = 'none';
      progress.style.display = 'block';
      progressBar.style.width = '0%';
      break;

    case 'downloading':
      modal.className = 'update-modal downloading';
      title.textContent = 'Update Required';
      text.textContent = `Downloading update... ${data.percent}%`;
      btn.style.display = 'none';
      progress.style.display = 'block';
      progressBar.style.width = data.percent + '%';
      break;

    case 'downloaded':
      modal.className = 'update-modal downloaded';
      title.textContent = 'Update Ready';
      text.textContent = `v${data.version} downloaded. The app will restart to install it...`;
      btn.textContent = 'Restart Now';
      btn.style.display = 'inline-block';
      progress.style.display = 'block';
      progressBar.style.width = '100%';
      updateAction = 'install';
      break;

    case 'error':
      modal.className = 'update-modal error';
      title.textContent = 'Update Failed';
      text.textContent = 'Could not download the update: ' + (data.message || 'Unknown error');
      btn.textContent = 'Retry';
      btn.style.display = 'inline-block';
      progress.style.display = 'none';
      updateAction = 'check';
      break;
  }
});

function handleUpdateAction() {
  if (updateAction === 'install') {
    ipcRenderer.send('update-install');
  } else if (updateAction === 'check') {
    ipcRenderer.send('update-check');
  }
}

// ==================== END MANDATORY UPDATE ====================

// Initialize
showScreen('welcome');
