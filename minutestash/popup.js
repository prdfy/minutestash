const btn = document.getElementById('extractBtn');
const statusEl = document.getElementById('status');
const bar = document.getElementById('progressBar');
const barFill = bar.querySelector('div');

let currentTabId = null;
let refreshTimer = null;

function setIdleState() {
  btn.disabled = false;
  btn.textContent = 'Extract & Download';
  statusEl.textContent = 'Ready to extract transcripts from Microsoft Teams meetings.';
  statusEl.style.color = '#666';
  bar.style.display = 'none';
  barFill.style.width = '0%';
}

function applyExtractionState(state) {
  if (!state) {
    setIdleState();
    return;
  }

  const progress = Math.max(0, Math.min(100, Number(state.progress || 0)));
  const isRunning = Boolean(state.isRunning);
  const ok = Boolean(state.ok);
  const message = String(state.message || 'Working…');

  btn.disabled = isRunning;
  btn.textContent = isRunning ? 'Working…' : 'Extract & Download';
  statusEl.textContent = message;

  if (ok && !isRunning && progress >= 100) {
    statusEl.style.color = 'green';
  } else if (ok) {
    statusEl.style.color = '#0078d4';
  } else {
    statusEl.style.color = 'red';
  }

  if (progress > 0) {
    bar.style.display = 'block';
    barFill.style.width = `${progress}%`;
  } else {
    bar.style.display = 'none';
    barFill.style.width = '0%';
  }
}

async function refreshStateFromBackground(options = {}) {
  const { allowMissingReset = false } = options;

  // Always ask for global state first so we can pick up a running extraction
  // even when currentTabId isn't initialized yet or points to another tab.
  const globalState = await browser.runtime.sendMessage({ type: 'getExtractionState' });
  
  // Apply any global state (running or completed) that has a valid tabId
  if (globalState?.tabId && Number.isInteger(globalState.tabId)) {
    currentTabId = globalState.tabId;
    applyExtractionState(globalState);
    return;
  }

  const state = currentTabId
    ? await browser.runtime.sendMessage({ type: 'getExtractionState', tabId: currentTabId })
    : globalState;

  if (state?.tabId && Number.isInteger(state.tabId)) {
    currentTabId = state.tabId;
  }

  if (!state) {
    if (allowMissingReset) {
      setIdleState();
    }
    return;
  }

  applyExtractionState(state);
}

async function loadCurrentState() {
  try {
    statusEl.textContent = 'Loading current extraction state…';
    statusEl.style.color = '#0078d4';

    // First try to hydrate from any active extraction immediately.
    const globalState = await browser.runtime.sendMessage({ type: 'getExtractionState' });
    const hasGlobalState = Boolean(globalState?.tabId && Number.isInteger(globalState?.tabId));
    
    if (hasGlobalState) {
      currentTabId = globalState.tabId;
      applyExtractionState(globalState);
      return; // Exit early with the state we found
    }

    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    const activeTabId = tab?.id ?? null;

    if (Number.isInteger(activeTabId)) {
      currentTabId = activeTabId;
    }

    if (!currentTabId) {
      setIdleState();
      statusEl.textContent = 'Error: could not find the active tab.';
      statusEl.style.color = 'red';
      return;
    }

    await refreshStateFromBackground({ allowMissingReset: true });
  } catch (e) {
    setIdleState();
    statusEl.textContent = 'Error loading state: ' + e.message;
    statusEl.style.color = 'red';
  }
}

function startAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
  }

  refreshTimer = setInterval(() => {
    refreshStateFromBackground().catch(() => undefined);
  }, 1000);
}

window.addEventListener('unload', () => {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
});

browser.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'extractionStatus') return;
  if (Number.isInteger(message?.tabId)) {
    currentTabId = message.tabId;
  }
  applyExtractionState(message);
});

btn.addEventListener('click', async () => {
  if (!currentTabId) {
    await loadCurrentState();
  }
  if (!currentTabId) return;

  btn.disabled = true;
  btn.textContent = 'Working…';
  statusEl.textContent = 'Starting extraction…';
  statusEl.style.color = '#0078d4';
  bar.style.display = 'block';
  barFill.style.width = '15%';

  try {
    const response = await browser.runtime.sendMessage({ type: 'startExtraction', tabId: currentTabId });
    if (!response?.ok) {
      if (response?.alreadyRunning) {
        if (response.state) {
          applyExtractionState(response.state);
        } else {
          await refreshStateFromBackground();
        }
        return;
      }
      throw new Error(response?.error || 'Unknown start error');
    }
    statusEl.textContent = 'Extraction started. You can switch tabs; progress will be preserved.';
    statusEl.style.color = '#0078d4';
    barFill.style.width = '30%';
  } catch (e) {
    btn.disabled = false;
    btn.textContent = 'Extract & Download';
    statusEl.textContent = 'Start error: ' + e.message;
    statusEl.style.color = 'red';
    bar.style.display = 'none';
    barFill.style.width = '0%';
  }
});

(async () => {
  await loadCurrentState();
  startAutoRefresh();
})();
