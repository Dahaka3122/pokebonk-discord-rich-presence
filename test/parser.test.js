// Parser tests in a real Chromium, against trimmed copies of the game's real markup.
// Run: npm test   (optionally CHROME_PATH=/path/to/chrome)
const { chromium } = require('playwright');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const fx = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const parserSrc = fs.readFileSync(path.join(__dirname, '..', 'extension', 'parser.js'), 'utf8');
const launchOpts = {
  executablePath: process.env.CHROME_PATH || undefined,
  args: process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : [],
};

(async () => {
  const browser = await chromium.launch(launchOpts);
  const page = await browser.newPage();
  const load = async (html) => {
    await page.setContent(html);
    await page.addScriptTag({ content: parserSrc });
  };
  const state = () => page.evaluate(() => window.PokebonkParser.parseState(document));

  let passed = 0;
  const check = (name, fn) => { fn(); passed++; console.log('  ok  ' + name); };

  // ---- run HUD ----
  await load(fx('hud.html'));
  const game = await state();
  console.log('parseState on the HUD fixture:\n' + JSON.stringify(game, null, 2) + '\n');
  check('screen = game', () => assert.strictEqual(game.screen, 'game'));
  check('Pokémon name', () => assert.strictEqual(game.pokemon, 'Cyndaquil'));
  check('level = 13 (not the 22 from the evolution arrow)', () => assert.strictEqual(game.level, 13));
  check('evolution level = 22', () => assert.strictEqual(game.evoLevel, 22));
  check('type = Fire', () => assert.deepStrictEqual(game.types, ['Fire']));
  check('dex number = 155', () => assert.strictEqual(game.dex, 155));
  check('map', () => assert.strictEqual(game.biome, 'Viridian Forest'));
  check('zone 1/3', () => { assert.strictEqual(game.zone, 1); assert.strictEqual(game.zones, 3); });
  check('difficulty = Normal', () => assert.strictEqual(game.tier, 'Normal'));
  check('weather is just "Rain", without map effects (Gengar/Curse/Rhydon)', () => assert.strictEqual(game.weather, 'Rain'));
  check('run clock 3:40.8 = 220800 ms (not the 6:19 countdown, not the record)', () => assert.strictEqual(game.runMs, 220800));
  check('no KO counter in the fixture -> null', () => assert.strictEqual(game.kos, null));

  // KO counter (top-right counters)
  const withKos = await page.evaluate(() => {
    const tr = document.createElement('div');
    tr.className = 'hud-tr';
    tr.innerHTML = '<div class="counters"><div class="counter"><img src="./assets/items/poke-ball.png"><span>261</span></div></div>';
    document.querySelector('#hud').appendChild(tr);
    return window.PokebonkParser.parseState(document);
  });
  check('KO counter', () => assert.strictEqual(withKos.kos, '261'));

  // DOM changes: evolution, new map, different weather, level up
  const changed = await page.evaluate(() => {
    document.querySelector('.tl-name').textContent = 'Quilava';
    document.querySelector('.tl-lvl b').textContent = '22';
    document.querySelector('.tl-portrait').setAttribute('data-k', '156');
    document.querySelector('.ht-biome').textContent = 'Mt. Moon';
    document.querySelector('.ht-zone').textContent = 'Zone 2/3';
    document.querySelector('.ht-weather').innerHTML = 'Scorching Sun<em> · Curse ×2</em>';
    document.querySelector('.runclock b').textContent = '1:02:03.5';
    return window.PokebonkParser.parseState(document);
  });
  check('after evolving and changing map', () => {
    assert.strictEqual(changed.pokemon, 'Quilava');
    assert.strictEqual(changed.level, 22);
    assert.strictEqual(changed.dex, 156);
    assert.strictEqual(changed.biome, 'Mt. Moon');
    assert.strictEqual(changed.zone, 2);
    assert.strictEqual(changed.weather, 'Scorching Sun');
    assert.strictEqual(changed.runMs, 3723500);
  });

  const none = await page.evaluate(() => {
    document.querySelector('#hud').innerHTML = '';
    return window.PokebonkParser.parseState(document);
  });
  check('no HUD and no known screen -> null', () => assert.strictEqual(none, null));

  // ---- main menu ----
  await load(fx('menu.html'));
  const menu = await state();
  console.log('parseState on the menu fixture:\n' + JSON.stringify(menu, null, 2) + '\n');
  check('menu: screen', () => assert.strictEqual(menu.screen, 'menu'));
  check('menu: partner dex = 134', () => assert.strictEqual(menu.dex, 134));
  check('menu: League 79/138', () => assert.strictEqual(menu.league, '79/138'));
  check('menu: Pokédex 234/251', () => assert.strictEqual(menu.pokedex, '234/251'));
  const hidden = await page.evaluate(() => {
    document.querySelector('.screen.mm').style.display = 'none';
    return window.PokebonkParser.parseState(document);
  });
  check('hidden menu without a HUD -> null', () => assert.strictEqual(hidden, null));

  // ---- Pokémon selection (The League) ----
  await load(fx('league.html'));
  const league = await state();
  console.log('parseState on the League fixture:\n' + JSON.stringify(league, null, 2) + '\n');
  check('league: screen / name / dex / role', () => {
    assert.strictEqual(league.screen, 'league');
    assert.strictEqual(league.pokemon, 'Bulbasaur');
    assert.strictEqual(league.dex, 1);
    assert.strictEqual(league.role, 'Healer');
  });
  check('league: types', () => assert.deepStrictEqual(league.types, ['Grass', 'Poison']));

  // ---- map selection ----
  await load(fx('map.html'));
  const map = await state();
  console.log('parseState on the map-selection fixture:\n' + JSON.stringify(map, null, 2) + '\n');
  check('map: Pokémon, map, realm', () => {
    assert.strictEqual(map.screen, 'map');
    assert.strictEqual(map.pokemon, 'Bulbasaur');
    assert.strictEqual(map.dex, 1);
    assert.strictEqual(map.map, 'Viridian Forest');
    assert.strictEqual(map.realm, 'Kanto');
  });
  check('map: mode and difficulty (the selected ones, not the first/last)', () => {
    assert.strictEqual(map.mode, 'Classic');
    assert.strictEqual(map.tier, 'Normal');
  });

  // ---- other run types: Survival, event, pause, game over ----
  const stateOf = async (file) => { await load(fx(file)); return state(); };

  const surv = await stateOf('survival.html');
  check('survival: label "Phase 1/3" kept (not turned into "Zone"), tier, weather', () => {
    assert.strictEqual(surv.screen, 'game');
    assert.strictEqual(surv.zoneLabel, 'Phase 1/3');
    assert.strictEqual(surv.tier, 'Survival');
    assert.strictEqual(surv.weather, 'Sandstorm');
    assert.strictEqual(surv.kos, '2');
    assert.strictEqual(surv.runMs, 13300);
    assert.strictEqual(surv.phase, 'running');
  });
  const evRun = await stateOf('event-run.html');
  check('event run: Wild Valley, Expedition, Phase 1/3, hidden weather ignored', () => {
    assert.strictEqual(evRun.biome, 'Wild Valley');
    assert.strictEqual(evRun.tier, 'Expedition');
    assert.strictEqual(evRun.zoneLabel, 'Phase 1/3');
    assert.strictEqual(evRun.weather, '');
    assert.strictEqual(evRun.phase, 'running');
  });
  check('normal run keeps "Zone 1/3"', () => assert.strictEqual(game.zoneLabel, 'Zone 1/3'));
  const paused = await stateOf('paused.html');
  check('pause modal -> phase "paused", run data still read', () => {
    assert.strictEqual(paused.screen, 'game');
    assert.strictEqual(paused.phase, 'paused');
    assert.strictEqual(paused.level, 6);
    assert.strictEqual(paused.runMs, 53300);
  });
  const ended = await stateOf('ended.html');
  check('game over (djh-on) -> phase "ended"', () => assert.strictEqual(ended.phase, 'ended'));
  const evEnded = await stateOf('event-ended.html');
  check('event game over (.dead panel) -> phase "ended"', () => assert.strictEqual(evEnded.phase, 'ended'));

  // ---- new screens ----
  const dex = await stateOf('dex.html');
  check('Pokédex screen + progress', () => assert.deepStrictEqual(dex, { screen: 'dex', kind: 'pokedex', progress: '250/251' }));
  const nb = await stateOf('notebook.html');
  check('Research Notebook screen + progress', () => assert.deepStrictEqual(nb, { screen: 'dex', kind: 'notebook', progress: '125/129' }));
  const evHome = await stateOf('event-home.html');
  check('event home: name from the hero heading', () => assert.deepStrictEqual(evHome, { screen: 'event', event: 'The Great Expedition' }));
  const evPrep = await stateOf('event-prep.html');
  check("event preparation (Bill's PC): name from the title", () => assert.deepStrictEqual(evPrep, { screen: 'event', event: 'The Great Expedition' }));
  const coopE = await stateOf('coop-entry.html');
  const coopL = await stateOf('coop-lobby.html');
  check('co-op entry vs lobby', () => {
    assert.deepStrictEqual(coopE, { screen: 'coop', lobby: false });
    assert.deepStrictEqual(coopL, { screen: 'coop', lobby: true });
  });
  check('co-op lobby: room code and player names are NOT read', () => {
    const j = JSON.stringify(coopL);
    assert.ok(!j.includes('ABCD') && !j.includes('FakePlayerOne'), j);
  });
  const lab = await stateOf('other-lab.html');
  check('any other menu screen -> { screen: "other" }', () => assert.deepStrictEqual(lab, { screen: 'other' }));
  const friends = await stateOf('other-friends.html');
  check('friends screen: nothing read (no names leak)', () => {
    assert.deepStrictEqual(friends, { screen: 'other' });
    assert.ok(!JSON.stringify(friends).includes('FakeFriend'));
  });

  // ---- clock parsing ----
  const clocks = await page.evaluate(() => ['6:19', '0:05', '1:02:03', 'abc', ''].map((s) => window.PokebonkParser.parseClock(s)));
  check('parseClock', () => assert.deepStrictEqual(clocks, [379000, 5000, 3723000, null, null]));

  await browser.close();
  console.log(`\n${passed} tests passed`);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
