// Reads the game state from Pokebonk's DOM.
// Runs in the browser (content script) and is injected into a page in the tests.
(function (root) {
  const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

  // "6:19" | "3:40.8" | "1:02:03.5"  ->  milliseconds (or null)
  function parseClock(s) {
    const m = /^(\d+(?::\d+){1,2})(?:\.(\d+))?$/.exec((s || '').trim());
    if (!m) return null;
    const parts = m[1].split(':').map(Number);
    let sec = 0;
    for (const p of parts) sec = sec * 60 + p;
    const frac = m[2] ? parseFloat('0.' + m[2]) : 0;
    return Math.round((sec + frac) * 1000);
  }

  // Inline `display: none` check, for HUD elements the game hides instead of removing.
  function visible(el) {
    return !!el && el.style.display !== 'none';
  }

  // In-run state, or null when the run HUD is not on screen (menus etc.).
  function parseHud(doc) {
    const tl = doc.querySelector('#hud .hud-tl') || doc.querySelector('.hud-tl');
    const name = txt(tl && tl.querySelector('.tl-name'));
    if (!name) return null;

    const level = parseInt(txt(tl.querySelector('.tl-lvl b')), 10) || null;
    const types = Array.from(tl.querySelectorAll('.tl-types .chip')).map(txt).filter(Boolean);
    const portrait = tl.querySelector('.tl-portrait');
    const dex = portrait ? parseInt(portrait.getAttribute('data-k'), 10) || null : null;
    // The level shown next to the portrait arrow is the NEXT EVOLUTION level, not the current one.
    const evoMatch = /(\d+)/.exec(txt(tl.querySelector('.tl-evlv')));
    const evoLevel = evoMatch ? parseInt(evoMatch[1], 10) : null;
    // The KO counter lives in the top-right counters (the game gives it a Poké Ball icon).
    const koEl = doc.querySelector('#hud .counters .counter span');
    const kos = koEl ? txt(koEl) : null;

    const top = doc.querySelector('#hud .hud-top') || doc.querySelector('.hud-top');
    const biome = txt(top && top.querySelector('.ht-biome'));
    const zoneText = txt(top && top.querySelector('.ht-zone'));
    const zm = /(\d+)\s*\/\s*(\d+)/.exec(zoneText);
    // Normal runs say "Zone 1/3", Survival and the event say "Phase 1/3": keep the game's own wording.
    const zoneLabel = zm ? zoneText : '';
    const tier = txt(top && top.querySelector('.ht-tier'));
    const weatherEl = top && top.querySelector('.ht-weather');
    // Only the direct text node ("Rain"); map effects (Curse, Gengar, Rhydon...) are <em> children.
    const weather = visible(weatherEl)
      ? Array.from(weatherEl.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
      : '';
    // Run clock (the one with "Record" under it). The big `.timer` is the Final Swarm countdown.
    const runMs = parseClock(txt(top && top.querySelector('.runclock b')));

    // Pause and end-of-run are modals on top of the (still present) HUD, not separate screens.
    // Pause panel: `.pz`. Run over: `.djh-on` flag (normal runs) or a `.dead` panel (event runs).
    let phase = 'running';
    if (doc.querySelector('.modal .pz')) phase = 'paused';
    else if (doc.querySelector('.djh-on, .modal .dead')) phase = 'ended';

    return {
      pokemon: name,
      level,
      types,
      dex,
      evoLevel,
      kos,
      biome,
      zone: zm ? parseInt(zm[1], 10) : null,
      zones: zm ? parseInt(zm[2], 10) : null,
      zoneLabel,
      tier,
      weather,
      runMs,
      phase,
    };
  }

  // ---- Screens outside a run: main menu -> Pokémon selection (The League) -> map selection ----
  const vis = (el) => !!el && el.getClientRects().length > 0;
  const portraitDex = (img) => {
    const m = /portraits\/(\d+)\.png/.exec(img ? img.getAttribute('src') || '' : '');
    return m ? parseInt(m[1], 10) : null;
  };
  const ratio = (el) => {
    const m = /(\d+)\s*\/\s*(\d+)/.exec(txt(el));
    return m ? `${m[1]}/${m[2]}` : '';
  };

  // Main menu: partner Pokémon (icon on the Play button), League and Pokédex progress.
  function parseMenu(doc) {
    const mm = doc.querySelector('.screen.mm');
    if (!mm) return null;
    let league = '';
    mm.querySelectorAll('.tr-cur .currency').forEach((c) => { if (!league) league = ratio(c); });
    // The first tile is the Pokédex (matched by position so it works in every UI language).
    const pokedex = ratio(mm.querySelector('.mm-tiles .mm-item.tile small'));
    return { screen: 'menu', dex: portraitDex(mm.querySelector('.mm-partner img')), league, pokedex };
  }

  // Pokémon selection ("The League"): the Pokémon the player is currently looking at.
  function parseLeague(doc) {
    const ls = doc.querySelector('.screen.ls');
    if (!ls) return null;
    const idText = txt(ls.querySelector('.ls-id-top small')); // e.g. "#001 · Healer"
    const dm = /#(\d+)/.exec(idText);
    const role = idText.includes('·') ? idText.split('·').slice(1).join('·').trim() : '';
    return {
      screen: 'league',
      pokemon: txt(ls.querySelector('.ls-namerow h1')),
      dex: dm ? parseInt(dm[1], 10) : null,
      role,
      types: Array.from(ls.querySelectorAll('.ls-id-types .chip')).map(txt).filter(Boolean),
    };
  }

  // Map selection: chosen Pokémon, map, realm, mode and difficulty.
  function parseMap(doc) {
    const rg = doc.querySelector('.screen.rg');
    if (!rg) return null;
    return {
      screen: 'map',
      pokemon: txt(rg.querySelector('.rg-pn b')),
      dex: portraitDex(rg.querySelector('.rg-pt img')),
      map: txt(rg.querySelector('.rg-name h1')),
      realm: txt(rg.querySelector('.rg-realm.on .rg-rn b')),
      mode: txt(rg.querySelector('.rg-mode.on b')),
      tier: txt(rg.querySelector('.rg-tier.on b')),
    };
  }

  // Pokédex and Research Notebook: only the progress counter from the title.
  function parseDex(doc) {
    const el = doc.querySelector('.screen.dx, .screen.rs');
    if (!el) return null;
    return {
      screen: 'dex',
      kind: el.classList.contains('rs') ? 'notebook' : 'pokedex',
      progress: ratio(el.querySelector('.scr-title span')),
    };
  }

  // Limited-time event: its home screen and the preparation screen ("Bill's PC").
  function parseEvent(doc) {
    const el = doc.querySelector('.screen.ev-scr, .screen.ex');
    if (!el) return null;
    const name = el.classList.contains('ex')
      ? txt(el.querySelector('.scr-title span'))
      : txt(el.querySelector('.exv-hero h1'));
    return { screen: 'event', event: name };
  }

  // Co-op entry and lobby. Room code and player names are deliberately NOT read.
  function parseCoop(doc) {
    const el = doc.querySelector('.screen.cp');
    if (!el) return null;
    return { screen: 'coop', lobby: el.classList.contains('lobby') };
  }

  // Every other menu screen (Lab, Builds, Shop, Friends, Mailbox, Profile, leaderboards...).
  // Nothing is read from them on purpose: some show private data.
  function parseOther(doc) {
    return doc.querySelector('.screen') ? { screen: 'other' } : null;
  }

  // Whichever screen is visible, otherwise the run HUD, otherwise null.
  // (Screens and the HUD never coexist: the game swaps the whole #ui.)
  function parseState(doc) {
    if (vis(doc.querySelector('.screen.rg'))) return parseMap(doc);
    if (vis(doc.querySelector('.screen.ls'))) return parseLeague(doc);
    if (vis(doc.querySelector('.screen.mm'))) return parseMenu(doc);
    if (vis(doc.querySelector('.screen.dx, .screen.rs'))) return parseDex(doc);
    if (vis(doc.querySelector('.screen.ev-scr, .screen.ex'))) return parseEvent(doc);
    if (vis(doc.querySelector('.screen.cp'))) return parseCoop(doc);
    if (vis(doc.querySelector('.screen'))) return parseOther(doc);
    const hud = parseHud(doc);
    return hud ? { screen: 'game', ...hud } : null;
  }

  const api = { parseHud, parseMenu, parseLeague, parseMap, parseDex, parseEvent, parseCoop, parseOther, parseState, parseClock };
  root.PokebonkParser = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
