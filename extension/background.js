// Service worker: forwards the state from the game tab to the local helper (Node).
const HELPER_URL = 'http://127.0.0.1:8765/state';
const gameTabs = new Set();

function post(payload) {
  fetch(HELPER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(payload),
  }).catch(() => {
    // Helper is not running - ignore, we retry on the next change.
  });
}

if (chrome.tabs && chrome.tabs.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (gameTabs.delete(tabId) && gameTabs.size === 0) {
      post({ state: null, clear: true, ts: Date.now() });
    }
  });
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  const tabId = sender && sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : -1;
  if (msg && msg.type === 'closed') {
    gameTabs.delete(tabId);
    if (gameTabs.size === 0) post({ state: null, clear: true, ts: Date.now() });
    return;
  }
  if (!msg || msg.type !== 'state') return;
  gameTabs.add(tabId);
  post({ state: msg.state, ts: msg.ts });
});
