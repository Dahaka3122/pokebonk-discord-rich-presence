// End-to-end test: Chromium with the extension -> helper -> fake Discord IPC server.
// pokebonk.com is replaced by a local fixture, so no traffic goes to the real game.
// Run: npm run test:e2e   (optionally CHROME_PATH=/path/to/chrome)
const { chromium } = require('playwright');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const assert = require('assert');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');
const fx = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbp-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(addr.port)));
    });
  });
}

function getHealth(port) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(1000, () => req.destroy(new Error('health timeout')));
  });
}

async function waitForHelperHealth(port, helperProc, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (helperProc.exitCode !== null) {
      throw new Error(`Helper exited prematurely with code ${helperProc.exitCode}`);
    }
    try {
      const h = await getHealth(port);
      if (h && h.ok && h.discordReady) return;
    } catch (_) {}
    await sleep(100);
  }
  throw new Error('Timeout waiting for helper /health + discordReady');
}

function stageExtension(port) {
  const extDir = path.join(tmp, 'extension');
  fs.cpSync(path.join(root, 'extension'), extDir, { recursive: true });
  const bgPath = path.join(extDir, 'background.js');
  const mfPath = path.join(extDir, 'manifest.json');
  fs.writeFileSync(
    bgPath,
    fs.readFileSync(bgPath, 'utf8').replace('http://127.0.0.1:8765/state', `http://127.0.0.1:${port}/state`),
  );
  fs.writeFileSync(
    mfPath,
    fs.readFileSync(mfPath, 'utf8').replace('http://127.0.0.1:8765/*', `http://127.0.0.1:${port}/*`),
  );
  return extDir;
}

// --- fake Discord: same IPC protocol as the real client ---
const received = [];
let handshake = null;
const fake = net.createServer((sock) => {
  let buf = Buffer.alloc(0);
  const send = (op, obj) => {
    const d = Buffer.from(JSON.stringify(obj));
    const h = Buffer.alloc(8); h.writeInt32LE(op, 0); h.writeInt32LE(d.length, 4);
    sock.write(Buffer.concat([h, d]));
  };
  sock.on('data', (c) => {
    buf = Buffer.concat([buf, c]);
    while (buf.length >= 8) {
      const op = buf.readInt32LE(0), len = buf.readInt32LE(4);
      if (buf.length < 8 + len) break;
      const msg = JSON.parse(buf.slice(8, 8 + len).toString());
      buf = buf.slice(8 + len);
      if (op === 0) {
        handshake = msg;
        send(1, { cmd: 'DISPATCH', evt: 'READY', data: { user: { username: 'fake-user' } } });
      } else if (msg.cmd === 'SET_ACTIVITY') {
        received.push(msg.args.activity);
        send(1, { cmd: 'SET_ACTIVITY', data: msg.args.activity, evt: null, nonce: msg.nonce });
      }
    }
  });
});

async function waitFor(pred, what, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return; await sleep(100); }
  throw new Error('Timeout: ' + what);
}

(async () => {
  let ctx = null;
  let helper = null;
  let fakeListening = false;
  let helperLog = '';
  let ok = false;

  try {
    const port = await getFreePort();
    const ipcPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\pbp-e2e-${process.pid}-${crypto.randomBytes(6).toString('hex')}`
      : path.join(tmp, 'discord-ipc-0');
    const extDir = stageExtension(port);

    await new Promise((resolve, reject) => {
      fake.once('error', reject);
      fake.listen(ipcPath, () => {
        fake.removeListener('error', reject);
        fakeListening = true;
        resolve();
      });
    });

    helper = spawn('node', [path.join(root, 'helper', 'server.js')], {
      env: {
        ...process.env,
        DISCORD_CLIENT_ID: '123456789012345678',
        DISCORD_IPC_PATH: ipcPath,
        PORT: String(port),
        MIN_UPDATE_MS: '500',
        STALE_MS: '8000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    helper.stdout.on('data', (d) => (helperLog += d));
    helper.stderr.on('data', (d) => (helperLog += d));
    const helperErr = new Promise((_, reject) => helper.once('error', reject));
    helperErr.catch(() => {});

    await Promise.race([waitForHelperHealth(port, helper), helperErr]);

    ctx = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
      executablePath: process.env.CHROME_PATH || undefined,
      headless: false, // extensions need the new headless mode, enabled by the flag below
      args: [...(process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : []),
        '--headless=new',
        `--disable-extensions-except=${extDir}`,
        `--load-extension=${extDir}`],
    });
    await ctx.route('https://pokebonk.com/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: fx('hud.html') }));
    const page = await ctx.newPage();
    await page.goto('https://pokebonk.com/');

    await waitFor(() => received.length >= 1, 'first SET_ACTIVITY');
    const a1 = received[0];
    console.log('1) First activity received by "Discord":\n' + JSON.stringify(a1, null, 2));
    assert.strictEqual(handshake.client_id, '123456789012345678');
    assert.strictEqual(a1.details, 'Cyndaquil · Lv. 13');
    assert.strictEqual(a1.state, 'Viridian Forest · Zone 1/3 · Normal · Rain');
    assert.ok(a1.assets.large_image.endsWith('/155.png'));
    assert.strictEqual(a1.assets.large_text, 'Cyndaquil (Fire)');
    const ageSec = Date.now() / 1000 - a1.timestamps.start;
    assert.ok(ageSec > 220 && ageSec < 235, 'timestamp should be ~3:40 ago, got ' + ageSec);

    // Level up + new map in the game -> new activity
    const n = received.length;
    await page.evaluate(() => {
      document.querySelector('.tl-lvl b').textContent = '14';
      document.querySelector('.ht-biome').textContent = 'Mt. Moon';
      document.querySelector('.ht-zone').textContent = 'Zone 2/3';
    });
    await waitFor(() => received.length > n, 'update after level up');
    const a2 = received[received.length - 1];
    console.log('\n2) After a level up and a map change:\n' + JSON.stringify({ details: a2.details, state: a2.state }, null, 2));
    assert.strictEqual(a2.details, 'Cyndaquil · Lv. 14');
    assert.strictEqual(a2.state, 'Mt. Moon · Zone 2/3 · Normal · Rain');

    // Menu -> Pokémon selection -> map selection (screens swapped inside #ui like in the game)
    const swap = async (file) => {
      const k = received.length;
      await page.evaluate((h) => {
        const body = new DOMParser().parseFromString(h, 'text/html').body;
        document.getElementById('ui').replaceWith(body.querySelector('#ui'));
      }, fx(file));
      await waitFor(() => received.length > k, 'presence for ' + file);
      return received[received.length - 1];
    };
    const show = (title, a) => console.log('\n' + title + '\n' + JSON.stringify({
      details: a.details, state: a.state,
      image: a.assets && a.assets.large_image.split('/').pop(),
      hover: a.assets && a.assets.large_text, timestamps: a.timestamps,
    }, null, 2));

    // Pause -> resume (Survival) -> game over -> event run -> event game over
    const age = (a) => Date.now() / 1000 - a.timestamps.start;
    const p1 = await swap('paused.html');
    show('2b) Paused:', p1);
    assert.strictEqual(p1.details, 'Abra · Lv. 6 · K.Os 41');
    assert.strictEqual(p1.state, 'Paused · Rocky Desert · Zone 1/3 · Hard · Sandstorm');
    assert.ok(!p1.timestamps, 'timer must be dropped while paused');

    const p2 = await swap('survival.html');
    show('2c) Resumed in Survival (timer back, "Phase" label):', p2);
    assert.strictEqual(p2.details, 'Abra · Lv. 1 · K.Os 2');
    assert.strictEqual(p2.state, 'Rocky Desert · Phase 1/3 · Survival · Sandstorm');
    assert.ok(age(p2) > 12 && age(p2) < 40, 'timer should restart from the game clock (~13 s), got ' + age(p2));

    const p3 = await swap('ended.html');
    show('2d) Run ended:', p3);
    assert.strictEqual(p3.state, 'Run ended · Rocky Desert · Zone 1/3 · Hard · Sandstorm');
    assert.ok(!p3.timestamps);

    const p4 = await swap('event-run.html');
    show('2e) Event run:', p4);
    assert.strictEqual(p4.state, 'Wild Valley · Phase 1/3 · Expedition');
    assert.ok(age(p4) > 15 && age(p4) < 40, 'got ' + age(p4));

    const p5 = await swap('event-ended.html');
    show('2f) Event run ended:', p5);
    assert.strictEqual(p5.state, 'Run ended · Wild Valley · Phase 1/3 · Expedition');
    assert.ok(!p5.timestamps);

    const m1 = await swap('menu.html');
    show('3) Main menu:', m1);
    assert.strictEqual(m1.details, 'In the main menu');
    assert.strictEqual(m1.state, 'Getting ready for a run');
    assert.ok(m1.assets.large_image.endsWith('/134.png'));
    assert.strictEqual(m1.assets.large_text, 'League 79/138 · Pokédex 234/251');
    assert.ok(!m1.timestamps);

    const m2 = await swap('league.html');
    show('4) Pokémon selection:', m2);
    assert.strictEqual(m2.details, 'Choosing my Pokémon');
    assert.strictEqual(m2.state, 'Looking at Bulbasaur · Healer');
    assert.ok(m2.assets.large_image.endsWith('/1.png'));
    assert.strictEqual(m2.assets.large_text, 'Bulbasaur (Grass/Poison)');

    const m3 = await swap('map.html');
    show('5) Map selection:', m3);
    assert.strictEqual(m3.details, 'Choosing a map with Bulbasaur');
    assert.strictEqual(m3.state, 'Viridian Forest · Normal · Classic');
    assert.ok(m3.assets.large_image.endsWith('/1.png'));
    assert.strictEqual(m3.assets.large_text, 'Kanto · Viridian Forest');

    // Other menu screens: icon = last Pokémon seen (Bulbasaur from the map screen)
    const dx = await swap('dex.html');
    show('6) Pokédex:', dx);
    assert.strictEqual(dx.details, 'Browsing the Pokédex');
    assert.strictEqual(dx.state, '250/251 seen');
    assert.ok(dx.assets.large_image.endsWith('/1.png'));

    const nbk = await swap('notebook.html');
    assert.strictEqual(nbk.state, 'Research Notebook · 125/129 families');

    const evh = await swap('event-home.html');
    show('7) Event:', evh);
    assert.strictEqual(evh.details, 'Preparing for The Great Expedition');
    assert.strictEqual(evh.state, 'Limited-time event');

    const evm = await swap('event-mewtwo.html');
    show('7b) Seasonal event (Mewtwo Strikes Back):', evm);
    assert.strictEqual(evm.details, 'Preparing for Mewtwo Strikes Back');
    assert.strictEqual(evm.state, 'Boss Rush');
    assert.ok(evm.assets.large_image.endsWith('/1.png'));
    assert.strictEqual(evm.assets.large_text, 'Mewtwo Strikes Back');

    const exp = await swap('expedition-menu.html');
    show('7c) Expedition mode menu:', exp);
    assert.strictEqual(exp.details, 'Preparing for The Great Expedition');
    assert.strictEqual(exp.state, 'Wild Valley · Solo');
    assert.ok(exp.assets.large_image.endsWith('/63.png'));
    assert.strictEqual(exp.assets.large_text, 'The Great Expedition · Wild Valley');

    const exps = await swap('expedition-safari.html');
    show('7d) Expedition run (Safari Zone):', exps);
    assert.strictEqual(exps.details, 'Abra · Lv. 1 · K.Os 2');
    assert.strictEqual(exps.state, 'Safari Zone · Phase 1/3 · Expedition · Mist');
    assert.ok(age(exps) > 10 && age(exps) < 40, 'got ' + age(exps));

    const mutm = await swap('mutation-menu.html');
    show('7e) Daily Mutation menu:', mutm);
    assert.strictEqual(mutm.details, 'Daily Mutation');
    assert.strictEqual(mutm.state, 'Stampede · Hard');
    assert.ok(!JSON.stringify(mutm).includes('FakeLeader'), 'leaderboard names must not leak');
    assert.ok(mutm.assets.large_image.endsWith('/63.png'));
    assert.strictEqual(mutm.assets.large_text, 'Stampede');

    const mutr = await swap('mutation-run.html');
    show('7f) Daily Mutation run:', mutr);
    assert.strictEqual(mutr.details, 'Abra · Lv. 6 · K.Os 60');
    assert.strictEqual(mutr.state, 'Rocky Desert · Zone 1/3 · Stampede · Hard');
    assert.ok(age(mutr) > 50 && age(mutr) < 80, 'got ' + age(mutr));

    const rel = await swap('relay-run.html');
    show('7g) Relay run:', rel);
    assert.strictEqual(rel.details, 'Abra · Lv. 7 · K.Os 166');
    assert.strictEqual(rel.state, 'Ilex Forest · Phase 1/3 · Relay · Rain');
    assert.ok(age(rel) > 22 && age(rel) < 55, 'got ' + age(rel));

    const br = await swap('boss-rush-run.html');
    show('7h) Boss Rush run (Mewtwo Strikes Back):', br);
    assert.strictEqual(br.details, 'Abra · Lv. 3 · K.Os 4');
    assert.strictEqual(br.state, 'Storm Pier · Zone 1/10 · Boss Rush');
    assert.ok(age(br) > 15 && age(br) < 45, 'got ' + age(br));

    const coopRun = await swap('coop-run.html');
    show('7i) Co-op run:', coopRun);
    assert.strictEqual(coopRun.details, 'Abra · Lv. 1 · K.Os 6');
    assert.strictEqual(coopRun.state, 'Viridian Forest · Zone 1/3 · Co-op · Normal');
    assert.ok(age(coopRun) > 18 && age(coopRun) < 50, 'got ' + age(coopRun));
    assert.ok(!JSON.stringify(coopRun).includes('FakeTeammate'), 'teammate names must not leak');

    const ce = await swap('coop-entry.html');
    assert.strictEqual(ce.details, 'Setting up a Co-op run');
    const cl = await swap('coop-lobby.html');
    show('8) Co-op lobby:', cl);
    assert.strictEqual(cl.details, 'Waiting in a Co-op lobby');
    assert.ok(!JSON.stringify(cl).includes('ABCD') && !JSON.stringify(cl).includes('FakePlayerOne'), 'room code / names must not leak');

    const lb = await swap('other-lab.html');
    show('9) Any other menu (Lab):', lb);
    assert.strictEqual(lb.details, 'Browsing the menus');
    assert.strictEqual(lb.state, 'Between runs');
    assert.ok(lb.assets.large_image.endsWith('/63.png'));

    // Closing the tab -> presence cleared immediately (strictly faster than STALE_MS=8000)
    const m = received.length;
    await page.close();
    await waitFor(() => received.length > m && received[received.length - 1] === null, 'presence cleared', 3000);
    console.log('\n10) After closing the tab: presence cleared (SET_ACTIVITY with activity=null)');

    ok = true;
    console.log('\nE2E OK');
  } catch (e) {
    console.error('E2E FAIL:', e.message);
    console.error('--- helper log ---\n' + helperLog);
  } finally {
    if (ctx) await ctx.close().catch(() => {});
    if (helper && helper.exitCode === null) {
      helper.kill();
      await Promise.race([
        new Promise((r) => helper.once('exit', r)),
        sleep(2000),
      ]);
    }
    if (fakeListening) {
      await new Promise((r) => fake.close(() => r()));
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    if (ok) console.log('\n--- helper log ---\n' + helperLog);
    process.exit(ok ? 0 : 1);
  }
})();
