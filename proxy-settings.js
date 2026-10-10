// ==================== ROTATING PROXY SETTINGS ====================
// The proxy list lives in the main process (stored encrypted); this is only the dialog.

const proxyModal = document.getElementById('proxyModal');
const proxyListInput = document.getElementById('proxyList');
const proxyEnabledInput = document.getElementById('proxyEnabled');
const proxyTestResults = document.getElementById('proxyTestResults');

function applyProxyConfig(config) {
  proxyState.enabled = config.enabled && config.count > 0;
  proxyState.count = config.count;

  const btn = document.getElementById('proxyBtn');
  btn.textContent = proxyState.enabled ? `Proxy: ${config.count}` : 'Proxy: Off';
  btn.classList.toggle('active', proxyState.enabled);
}

async function openProxySettings() {
  const config = await ipcRenderer.invoke('proxy-get-config');
  proxyEnabledInput.checked = config.enabled;
  proxyListInput.value = config.list;
  proxyTestResults.innerHTML = '';
  proxyModal.style.display = 'flex';
}

function closeProxySettings() {
  proxyModal.style.display = 'none';
}

async function saveProxySettings() {
  let config;
  try {
    config = await ipcRenderer.invoke('proxy-save-config', {
      enabled: proxyEnabledInput.checked,
      list: proxyListInput.value
    });
  } catch (error) {
    proxyTestResults.innerHTML = `<div class="proxy-result bad">Could not save: ${escapeHtml(error.message)}</div>`;
    applyProxyConfig(await ipcRenderer.invoke('proxy-get-config'));
    return;
  }
  applyProxyConfig(config);

  if (config.invalid.length) {
    proxyTestResults.innerHTML = `<div class="proxy-result bad">Saved, but ${config.invalid.length} line(s) were not understood and are ignored: ${escapeHtml(config.invalid.join(', '))}</div>`;
    return;
  }
  if (config.enabled && config.count === 0) {
    proxyTestResults.innerHTML = '<div class="proxy-result bad">Add at least one proxy to use proxy mode.</div>';
    return;
  }
  closeProxySettings();
  setStatus(proxyState.enabled ? `Proxy mode on: rotating ${config.count} proxies` : 'Proxy mode off');
}

async function testProxies() {
  const btn = document.getElementById('proxyTestBtn');
  btn.disabled = true;
  proxyTestResults.innerHTML = '<div class="proxy-result">Testing...</div>';

  try {
    const { results, invalid } = await ipcRenderer.invoke('proxy-test', { list: proxyListInput.value });
    const okCount = results.filter(r => r.ok).length;
    proxyTestResults.innerHTML =
      `<div class="proxy-result">${okCount}/${results.length} working</div>` +
      results.map(r => `
        <div class="proxy-result ${r.ok ? 'ok' : 'bad'}">
          ${r.ok ? 'OK' : 'FAIL'} ${escapeHtml(r.proxy)} - ${escapeHtml(r.detail)} (${(r.ms / 1000).toFixed(1)}s)
        </div>`).join('') +
      invalid.map(line => `<div class="proxy-result bad">Not understood: ${escapeHtml(line)}</div>`).join('');
  } finally {
    btn.disabled = false;
  }
}

// Init: load saved proxy mode
ipcRenderer.invoke('proxy-get-config').then(applyProxyConfig);
