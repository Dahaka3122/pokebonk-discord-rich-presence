// Content script: watches the game UI and forwards the state to background.js.
(function () {
  const HEARTBEAT_MS = 10000; // resend even without changes so the helper knows the game is alive
  const THROTTLE_MS = 1000;   // parse at most this often after DOM mutations

  let lastKey = null;
  let lastSent = 0;
  let scheduled = false;

  function send(state) {
    try {
      chrome.runtime.sendMessage({ type: 'state', state, ts: Date.now() });
    } catch (e) {
      // The extension was reloaded - this script is orphaned.
      stop();
    }
  }

  function tick() {
    scheduled = false;
    const state = window.PokebonkParser.parseState(document);
    // The run clock changes constantly, so it is left out of the change detection.
    const key = JSON.stringify(state ? { ...state, runMs: null } : null);
    const now = Date.now();
    if (key !== lastKey || now - lastSent >= HEARTBEAT_MS) {
      lastKey = key;
      lastSent = now;
      send(state);
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(tick, THROTTLE_MS);
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  const interval = setInterval(tick, 5000);

  function stop() {
    observer.disconnect();
    clearInterval(interval);
  }

  tick();
})();
