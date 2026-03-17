const { ipcRenderer } = require('electron');

// Source configurations
const SOURCES = {
  wayback: {
    name: 'Wayback CDX',
    short: 'WB',
    color: '#00d4ff',
    timeout: 15000
  },
  timemap: {
    name: 'Wayback Timemap',
    short: 'TM',
    color: '#ffc800',
    timeout: 15000
  }
};

// Global state
let currentDomain = '';
let allSnapshots = [];
let snapshotsByYear = {};
let snapshotsByMonth = {};
let selectedYear = null;
let selectedMonth = null;
let currentSource = null;

// Tab state
let tabs = [{ id: 'main', title: 'Home', type: 'main' }];
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

// Current fetch abort controller (for cancel)
let currentFetchController = null;

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

// Clean domain input
function cleanDomain(domain) {
  return domain
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '')
    .split('/')[0];
}

// Main search function
async function searchDomain() {
  const domain = cleanDomain(domainInput.value);

  if (!domain) {
    alert('Please enter a domain');
    return;
  }

  currentDomain = domain;
  currentSource = null;
  showScreen('loading');
  setStatus(`Searching archives for ${domain}...`);
  startLoadingTimer();

  try {
    const result = await fetchWithFallback(domain);
    stopLoadingTimer();

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

    setStatus(`Loaded ${result.snapshots.length} snapshots from ${sourceInfo.name}`);

  } catch (error) {
    stopLoadingTimer();
    console.error('Error:', error);
    showScreen('error');

    let errorMsg = 'Failed to fetch from all archives. Please try again later.';

    if (error.message.includes('cancelled') || error.message.includes('Cancel')) {
      errorMsg = 'Search cancelled.';
    } else if (error.message.includes('network')) {
      errorMsg = 'Network error. Please check your internet connection.';
    }

    document.getElementById('errorMessage').textContent = errorMsg;
    setStatus('Error');
  }
}

// Fallback fetch: Wayback CDX -> Wayback Timemap
async function fetchWithFallback(domain) {
  // Check cache first
  if (snapshotCache[domain]) {
    setStatus(`Loaded from cache (${snapshotCache[domain].snapshots.length} snapshots)`);
    return snapshotCache[domain];
  }

  // Source 1: Wayback CDX API (primary)
  updateLoadingStatus('wayback', 'loading');
  try {
    const snapshots = await fetchWaybackCDX(domain);
    if (snapshots && snapshots.length > 0) {
      updateLoadingStatus('wayback', 'success');
      const result = { snapshots, source: 'wayback' };
      snapshotCache[domain] = result;
      return result;
    }
    updateLoadingStatus('wayback', 'empty');
  } catch (error) {
    console.error('CDX failed:', error.message);
    if (error.message.includes('cancelled') || error.message.includes('Cancel')) {
      throw error;
    }
    updateLoadingStatus('wayback', 'failed');
  }

  // Source 2: Wayback Timemap API (fallback)
  updateLoadingStatus('timemap', 'loading');
  try {
    const snapshots = await fetchWaybackTimemap(domain);
    if (snapshots && snapshots.length > 0) {
      updateLoadingStatus('timemap', 'success');
      const result = { snapshots, source: 'timemap' };
      snapshotCache[domain] = result;
      return result;
    }
    updateLoadingStatus('timemap', 'empty');
  } catch (error) {
    console.error('Timemap failed:', error.message);
    if (error.message.includes('cancelled') || error.message.includes('Cancel')) {
      throw error;
    }
    updateLoadingStatus('timemap', 'failed');
  }

  throw new Error('All archive sources failed. Please try again later.');
}

// Fetch with timeout helper
async function fetchWithTimeout(url, timeout) {
  const controller = new AbortController();
  currentFetchController = controller;
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    currentFetchController = null;
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    currentFetchController = null;

    if (error.name === 'AbortError' && controller.signal.reason === 'cancelled') {
      throw new Error('Search cancelled');
    }

    throw error;
  }
}

// Fetch from Wayback Machine CDX API (primary)
async function fetchWaybackCDX(domain) {
  const url = `https://web.archive.org/cdx/search/cdx?url=${domain}&output=json&limit=10000`;
  const response = await fetchWithTimeout(url, SOURCES.wayback.timeout);

  if (!response.ok) throw new Error(`CDX error: ${response.status}`);

  const data = await response.json();
  if (data.length <= 1) return [];

  return data.slice(1).map(row => ({
    timestamp: row[1],
    originalUrl: row[2],
    url: `https://web.archive.org/web/${row[1]}/${row[2]}`,
    statusCode: row[4] || '200',
    source: 'wayback'
  }));
}

// Fetch from Wayback Timemap API (fallback)
async function fetchWaybackTimemap(domain) {
  const url = `https://web.archive.org/web/timemap/json/${domain}`;
  const response = await fetchWithTimeout(url, SOURCES.timemap.timeout);

  if (!response.ok) throw new Error(`Timemap error: ${response.status}`);

  const data = await response.json();
  if (!data || data.length <= 1) return [];

  const snapshots = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row || row.length < 2) continue;

    // Find timestamp (14-digit number)
    let timestamp = null;
    let statusCode = '200';

    for (const field of row) {
      if (typeof field === 'string' && /^\d{14}$/.test(field)) {
        timestamp = field;
        break;
      }
    }

    // Find status code if present
    for (const field of row) {
      if (typeof field === 'string' && /^[2-5]\d{2}$/.test(field)) {
        statusCode = field;
        break;
      }
    }

    if (timestamp) {
      snapshots.push({
        timestamp: timestamp,
        originalUrl: domain,
        url: `https://web.archive.org/web/${timestamp}/${domain}`,
        statusCode: statusCode,
        source: 'timemap'
      });
    }
  }

  return snapshots;
}

// Update loading status UI during fallback
function updateLoadingStatus(source, status) {
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

    // Status icon - text based
    let statusIcon = '*';
    const statusCode = snap.statusCode;
    if (statusCode === '301' || statusCode === '302') statusIcon = '>';
    else if (statusCode === '404') statusIcon = 'x';
    else if (statusCode >= '500') statusIcon = '!';

    return `
      <div class="snapshot-item">
        <div class="snapshot-info">
          <span class="snapshot-source" style="background: ${source.color}20; color: ${source.color}; border: 1px solid ${source.color}40;" title="${source.name}">
            ${source.short}
          </span>
          <span class="snapshot-icon status-${statusCode}">${statusIcon}</span>
          <span class="snapshot-date">${date}</span>
          <span class="snapshot-time">${time}</span>
          <span class="snapshot-status">[${statusCode}]</span>
        </div>
        <div class="snapshot-actions">
          <button class="snapshot-btn" onclick="copyUrl('${snapUrl}')">Copy</button>
          <button class="snapshot-btn" onclick="openPreview('${snapUrl}', '${date}')">Preview</button>
          <button class="snapshot-btn primary" onclick="openSnapshot('${snapUrl}')">Open</button>
        </div>
      </div>
    `;
  }).join('');
}

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
  webview.src = url;

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

  if (tabId === 'main') {
    // Show main content
    document.getElementById('previewContainer').style.display = 'none';
    document.querySelector('.main-content').style.display = 'flex';
    if (allSnapshots.length > 0) {
      document.getElementById('statsBar').style.display = 'flex';
    }
  } else {
    // Show preview
    const tab = tabs.find(t => t.id === tabId);
    if (tab && tab.url) {
      currentPreviewUrl = tab.url;
      document.getElementById('previewUrl').textContent = tab.url;
      document.getElementById('previewWebview').src = tab.url;
      document.getElementById('previewContainer').style.display = 'flex';
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
    } else {
      tabEl.innerHTML = `
        ${tab.title}
        <span class="close-tab" onclick="event.stopPropagation(); closeTab('${tab.id}')">x</span>
      `;
    }

    tabBar.insertBefore(tabEl, closeAllBtn);
  });
}

// Close single tab
function closeTab(tabId) {
  tabs = tabs.filter(t => t.id !== tabId);

  if (activeTab === tabId) {
    switchTab('main');
  }

  renderTabs();
}

// Close all preview tabs
function closeAllTabs() {
  tabs = tabs.filter(t => t.type === 'main');
  switchTab('main');
  renderTabs();
}

// Close current preview
function closePreview() {
  if (activeTab !== 'main') {
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
      stopPreviewTimer();
      showPreviewLoading(false);
      showPreviewError(false);
      updatePreviewStatus('Page loaded (assets may still be loading...)');
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
  if (currentFetchController) {
    currentFetchController.abort('cancelled');
    currentFetchController = null;
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

// ==================== IN-APP UPDATE UI ====================

let updateAction = null; // 'download' | 'install'

ipcRenderer.on('update-status', (event, data) => {
  const banner = document.getElementById('updateBanner');
  const text = document.getElementById('updateText');
  const btn = document.getElementById('updateBtn');
  const progress = document.getElementById('updateProgress');
  const progressBar = document.getElementById('updateProgressBar');
  const dismiss = document.getElementById('updateDismiss');

  switch (data.status) {
    case 'available':
      banner.style.display = 'flex';
      banner.className = 'update-banner available';
      text.textContent = `Update v${data.version} available!`;
      btn.textContent = 'Download';
      btn.style.display = 'inline-block';
      progress.style.display = 'none';
      dismiss.style.display = 'inline-block';
      updateAction = 'download';
      break;

    case 'downloading':
      banner.style.display = 'flex';
      banner.className = 'update-banner downloading';
      text.textContent = `Downloading... ${data.percent}%`;
      btn.style.display = 'none';
      progress.style.display = 'block';
      progressBar.style.width = data.percent + '%';
      dismiss.style.display = 'none';
      break;

    case 'downloaded':
      banner.style.display = 'flex';
      banner.className = 'update-banner downloaded';
      text.textContent = 'Update ready!';
      btn.textContent = 'Restart & Install';
      btn.style.display = 'inline-block';
      progress.style.display = 'none';
      dismiss.style.display = 'inline-block';
      updateAction = 'install';
      break;

    case 'error':
      banner.style.display = 'flex';
      banner.className = 'update-banner error';
      text.textContent = 'Update failed';
      btn.textContent = 'Retry';
      btn.style.display = 'inline-block';
      progress.style.display = 'none';
      dismiss.style.display = 'inline-block';
      updateAction = 'check';
      break;

    case 'not-available':
      banner.style.display = 'none';
      break;
  }
});

function handleUpdateAction() {
  if (updateAction === 'download') {
    ipcRenderer.send('update-download');
  } else if (updateAction === 'install') {
    ipcRenderer.send('update-install');
  } else if (updateAction === 'check') {
    ipcRenderer.send('update-check');
  }
}

function dismissUpdate() {
  document.getElementById('updateBanner').style.display = 'none';
}

// ==================== END IN-APP UPDATE ====================

// Initialize
showScreen('welcome');
