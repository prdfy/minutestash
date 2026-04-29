const activeExtractions = new Map();
const extractionStateByTab = new Map();
const EXTRACTION_STATE_STORAGE_KEY = 'extractionStateByTab';

function serializeExtractionStateByTab() {
  return Object.fromEntries(extractionStateByTab.entries());
}

function toSafeInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

async function persistExtractionStates() {
  try {
    await browser.storage.local.set({
      [EXTRACTION_STATE_STORAGE_KEY]: serializeExtractionStateByTab()
    });
  } catch {
    // Ignore persistence failures; runtime state is still available.
  }
}

async function hydrateExtractionStates() {
  try {
    const data = await browser.storage.local.get(EXTRACTION_STATE_STORAGE_KEY);
    const saved = data?.[EXTRACTION_STATE_STORAGE_KEY];
    if (!saved || typeof saved !== 'object') return;

    for (const [tabIdKey, state] of Object.entries(saved)) {
      const tabId = toSafeInt(tabIdKey);
      if (!Number.isInteger(tabId) || !state || typeof state !== 'object') {
        continue;
      }

      extractionStateByTab.set(tabId, {
        updatedAt: Number(state.updatedAt || Date.now()),
        ok: Boolean(state.ok),
        message: String(state.message || ''),
        progress: Number(state.progress || 0),
        isRunning: Boolean(state.isRunning)
      });
    }
  } catch {
    // Ignore hydration failures; extension can still operate from scratch.
  }
}

const stateHydrationPromise = hydrateExtractionStates();

function setExtractionState(tabId, state) {
  if (!Number.isInteger(tabId)) return;
  extractionStateByTab.set(tabId, {
    updatedAt: Date.now(),
    ...state
  });
  persistExtractionStates();
}

function getActiveExtractionState(tabId) {
  const active = activeExtractions.get(tabId);
  return active?.state || null;
}

function saveTranscript(message) {
  const text = String(message.text || '');
  const fileName = String(message.fileName || '').trim() ||
    `transcript-${new Date().toISOString().slice(0, 10)}.txt`;

  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);

  return browser.downloads.download({
    url,
    filename: fileName,
    saveAs: false
  })
    .then((downloadId) => {
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      return { ok: true, downloadId };
    })
    .catch((error) => {
      URL.revokeObjectURL(url);
      return { ok: false, error: error?.message || String(error) };
    });
}

function sendExtractionStatus(payload) {
  if (Number.isInteger(payload?.tabId)) {
    const state = {
      ok: Boolean(payload.ok),
      message: String(payload.message || ''),
      progress: Number(payload.progress || 0),
      isRunning: Boolean(payload.isRunning)
    };

    setExtractionState(payload.tabId, state);

    const active = activeExtractions.get(payload.tabId);
    if (active) {
      active.state = state;
    }
  }
  // Popup may be closed; ignore delivery errors.
  return browser.runtime.sendMessage({ type: 'extractionStatus', ...payload }).catch(() => undefined);
}

function startExtraction(tabId) {
  if (!tabId) {
    return Promise.resolve({ ok: false, error: 'Active tab not found.' });
  }

  if (activeExtractions.has(tabId)) {
    return Promise.resolve({
      ok: false,
      error: 'Extraction is already running for this tab.',
      alreadyRunning: true,
      state: extractionStateByTab.get(tabId) || null
    });
  }

  const timeoutId = setTimeout(() => {
    activeExtractions.delete(tabId);
    sendExtractionStatus({
      ok: false,
      tabId,
      message: 'Timeout: no response from transcript extraction.',
      progress: 0,
      isRunning: false
    });
  }, 120000);

  activeExtractions.set(tabId, {
    timeoutId,
    state: {
      ok: true,
      message: 'Injecting script…',
      progress: 25,
      isRunning: true
    }
  });
  sendExtractionStatus({ ok: true, tabId, message: 'Injecting script…', progress: 25, isRunning: true });

  return browser.tabs.executeScript(tabId, { file: 'content.js', allFrames: true })
    .then(() => {
      sendExtractionStatus({
        ok: true,
        tabId,
        message: 'Script injected — extracting transcript…',
        progress: 50,
        isRunning: true
      });
      return { ok: true, started: true };
    })
    .catch((error) => {
      stopExtraction(tabId);
      const message = 'Injection error: ' + (error?.message || String(error));
      sendExtractionStatus({ ok: false, tabId, message, progress: 0, isRunning: false });
      return { ok: false, error: message };
    });
}

function stopExtraction(tabId) {
  const state = activeExtractions.get(tabId);
  if (state?.timeoutId) {
    clearTimeout(state.timeoutId);
  }
  activeExtractions.delete(tabId);
}

function handleStartExtraction(message) {
  const requestedTabId = Number(message.tabId);
  const tabId = Number.isFinite(requestedTabId) ? requestedTabId : null;
  return startExtraction(tabId);
}

function handleTranscriptReady(message, sender) {
  const senderTabId = sender?.tab?.id;
  if (!Number.isInteger(senderTabId) || !activeExtractions.has(senderTabId)) {
    return undefined;
  }

  stopExtraction(senderTabId);

  return saveTranscript(message).then((response) => {
    if (response?.ok) {
      sendExtractionStatus({
        ok: true,
        tabId: senderTabId,
        message: 'Done! Saved ' + Number(message.itemCount || 0) + ' transcript entries.',
        progress: 100,
        isRunning: false
      });
    } else {
      sendExtractionStatus({
        ok: false,
        tabId: senderTabId,
        message: 'Save error: ' + (response?.error || 'Unknown download error'),
        progress: 0,
        isRunning: false
      });
    }
    return response;
  });
}

function handleExtractionError(message, sender) {
  const senderTabId = sender?.tab?.id;
  if (!Number.isInteger(senderTabId) || !activeExtractions.has(senderTabId)) {
    return undefined;
  }

  stopExtraction(senderTabId);
  sendExtractionStatus({
    ok: false,
    tabId: senderTabId,
    message: 'Error: ' + String(message.message || 'Unknown error'),
    progress: 0,
    isRunning: false
  });
  return undefined;
}

async function handleGetExtractionState(message) {
  await stateHydrationPromise;

  const requestedTabId = Number(message.tabId);
  const tabId = Number.isFinite(requestedTabId) ? requestedTabId : null;

  if (tabId && extractionStateByTab.has(tabId)) {
    return { tabId, ...extractionStateByTab.get(tabId) };
  }

  if (tabId && activeExtractions.has(tabId)) {
    const activeState = getActiveExtractionState(tabId) || {
      ok: true,
      message: 'Extraction in progress…',
      progress: 40,
      isRunning: true
    };
    return { tabId, ...activeState };
  }

  const fallbackRunning = activeExtractions.keys().next().value;
  if (Number.isInteger(fallbackRunning)) {
    if (extractionStateByTab.has(fallbackRunning)) {
      return { tabId: fallbackRunning, ...extractionStateByTab.get(fallbackRunning) };
    }

    const activeState = getActiveExtractionState(fallbackRunning) || {
      ok: true,
      message: 'Extraction in progress…',
      progress: 40,
      isRunning: true
    };
    return { tabId: fallbackRunning, ...activeState };
  }

  // If nothing is running, return the most recently updated state so
  // a reopened popup can still reflect the latest app status.
  if (!tabId && extractionStateByTab.size > 0) {
    let latestTabId = null;
    let latestUpdatedAt = -1;

    for (const [savedTabId, savedState] of extractionStateByTab.entries()) {
      const updatedAt = Number(savedState?.updatedAt || 0);
      if (updatedAt > latestUpdatedAt) {
        latestUpdatedAt = updatedAt;
        latestTabId = savedTabId;
      }
    }

    if (Number.isInteger(latestTabId) && extractionStateByTab.has(latestTabId)) {
      return { tabId: latestTabId, ...extractionStateByTab.get(latestTabId) };
    }
  }

  if (tabId) {
    return extractionStateByTab.get(tabId) ? { tabId, ...extractionStateByTab.get(tabId) } : null;
  }

  return null;
}

browser.runtime.onMessage.addListener((message, sender) => {
  switch (message?.type) {
    case 'saveTranscript':
      return saveTranscript(message);
    case 'startExtraction':
      return handleStartExtraction(message);
    case 'transcriptReady':
      return handleTranscriptReady(message, sender);
    case 'error':
      return handleExtractionError(message, sender);
    case 'getExtractionState':
      return handleGetExtractionState(message);
    default:
      return undefined;
  }
});
