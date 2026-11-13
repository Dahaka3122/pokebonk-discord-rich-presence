// Service worker: forwards the state from the game tab to the local helper (Node).
const HELPER_URL = 'http://127.0.0.1:8765/state';

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== 'state') return;
  fetch(HELPER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ state: msg.state, ts: msg.ts }),
  }).catch(() => {
    // Helper is not running - ignore, we retry on the next change.
  });
});
