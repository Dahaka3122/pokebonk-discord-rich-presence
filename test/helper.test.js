// Unit and integration tests for helper/server.js (Node-only, no browser required).
// Run: npm run test:helper
'use strict';

const assert = require('assert');
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const serverPath = path.join(root, 'helper', 'server.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbp-helper-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeIpcPath(label) {
  const id = `${process.pid}-${label}-${crypto.randomBytes(4).toString('hex')}`;
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\pbp-test-${id}`
    : path.join(tmp, `ipc-${id}`);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function encodeFrame(op, payload) {
  const data = Buffer.from(JSON.stringify(payload), 'utf8');
  const head = Buffer.alloc(8);
  head.writeInt32LE(op, 0);
  head.writeInt32LE(data.length, 4);
  return Buffer.concat([head, data]);
}

function startFakeIpc(ipcPath, onFrame) {
  const connections = [];
  const server = net.createServer((sock) => {
    connections.push(sock);
    let buf = Buffer.alloc(0);
    const send = (op, obj) => {
      if (!sock.destroyed) sock.write(encodeFrame(op, obj));
    };
    sock.on('error', () => {});
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 8) {
        const op = buf.readInt32LE(0);
        const len = buf.readInt32LE(4);
        if (buf.length < 8 + len) break;
        const msg = JSON.parse(buf.subarray(8, 8 + len).toString('utf8'));
        buf = buf.subarray(8 + len);
        onFrame({ op, msg, sock, send });
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(ipcPath, () => {
      server.removeListener('error', reject);
      resolve({
        server,
        connections,
        close: () => {
          for (const s of connections) { try { s.destroy(); } catch (_) {} }
          return new Promise((r) => server.close(() => r()));
        },
      });
    });
  });
}

function postJson(port, payload) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(payload), 'utf8');
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/state',
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'Content-Length': data.length,
      },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(data);
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

async function waitFor(pred, what, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return;
    await sleep(50);
  }
  throw new Error(`Timeout: ${what}`);
}

function runExpectExit(script, env, ms = 5000) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [script], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Expected process to exit within ${ms} ms`));
    }, ms);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr });
    });
  });
}

function spawnHelper(env) {
  const child = spawn('node', [serverPath], {
    env: {
      ...process.env,
      DISCORD_CLIENT_ID: '123456789012345678',
      MIN_UPDATE_MS: '100',
      STALE_MS: '2000',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });
  return {
    child,
    getLogs: () => logs,
    stop: async () => {
      if (child.exitCode === null) {
        child.kill();
        await Promise.race([
          new Promise((r) => child.once('exit', r)),
          sleep(2000),
        ]);
      }
    },
  };
}

async function waitForHealth(port, helperHandle, requireDiscordReady = false) {
  const { child, getLogs } = helperHandle;
  const t0 = Date.now();
  let lastErr = '';
  while (Date.now() - t0 < 10000) {
    if (child.exitCode !== null) {
      throw new Error(`Helper exited early with code ${child.exitCode}\nLogs:\n${getLogs()}`);
    }
    try {
      const h = await getHealth(port);
      if (h && h.ok && (!requireDiscordReady || h.discordReady)) return h;
      lastErr = `health=${JSON.stringify(h)}`;
    } catch (e) {
      lastErr = e.message;
    }
    await sleep(50);
  }
  throw new Error(`Timeout waiting for helper /health (${lastErr})\nLogs:\n${getLogs()}`);
}

(async () => {
  let passed = 0;
  const runTest = async (name, fn) => {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  };

  try {
    // 1. Config validation & EADDRINUSE startup errors
    await runTest('config validation rejects invalid env vars, bad config.json, and busy port', async () => {
      const badStale = await runExpectExit(serverPath, {
        DISCORD_CLIENT_ID: '123456789012345678',
        STALE_MS: 'abc',
      });
      assert.notStrictEqual(badStale.code, 0);
      assert.ok(badStale.stderr.includes('STALE_MS'), badStale.stderr);

      const badPort = await runExpectExit(serverPath, {
        DISCORD_CLIENT_ID: '123456789012345678',
        PORT: '99999',
      });
      assert.notStrictEqual(badPort.code, 0);
      assert.ok(badPort.stderr.includes('PORT'), badPort.stderr);

      const badMin = await runExpectExit(serverPath, {
        DISCORD_CLIENT_ID: '123456789012345678',
        MIN_UPDATE_MS: '-5',
      });
      assert.notStrictEqual(badMin.code, 0);
      assert.ok(badMin.stderr.includes('MIN_UPDATE_MS'), badMin.stderr);

      const badId = await runExpectExit(serverPath, {
        DISCORD_CLIENT_ID: 'abc',
      });
      assert.notStrictEqual(badId.code, 0);

      const cfgDir = path.join(tmp, 'cfg-test');
      fs.mkdirSync(cfgDir, { recursive: true });
      const copiedServer = path.join(cfgDir, 'server.js');
      fs.copyFileSync(serverPath, copiedServer);

      fs.writeFileSync(path.join(cfgDir, 'config.json'), '{ bad json');
      const malformedCfg = await runExpectExit(copiedServer, { DISCORD_CLIENT_ID: '' });
      assert.notStrictEqual(malformedCfg.code, 0);
      assert.ok(malformedCfg.stderr.includes('config.json'), malformedCfg.stderr);

      fs.writeFileSync(path.join(cfgDir, 'config.json'), 'null');
      const nullCfg = await runExpectExit(copiedServer, { DISCORD_CLIENT_ID: '' });
      assert.notStrictEqual(nullCfg.code, 0);
      assert.ok(nullCfg.stderr.includes('expected a JSON object'), nullCfg.stderr);

      const occupied = net.createServer();
      const port = await new Promise((resolve, reject) => {
        occupied.once('error', reject);
        occupied.listen(0, '127.0.0.1', () => resolve(occupied.address().port));
      });
      try {
        const portBusy = await runExpectExit(serverPath, {
          DISCORD_CLIENT_ID: '123456789012345678',
          PORT: String(port),
        });
        assert.notStrictEqual(portBusy.code, 0);
        assert.ok(portBusy.stderr.includes('already in use'), portBusy.stderr);
      } finally {
        await new Promise((r) => occupied.close(() => r()));
      }
    });

    // 2. Chunked UTF-8 HTTP body & byte limit (413)
    await runTest('chunked UTF-8 body preserves multibyte characters and enforces 20 KB limit', async () => {
      const port = await getFreePort();
      const ipcPath = makeIpcPath('utf8');
      const activities = [];
      const fake = await startFakeIpc(ipcPath, ({ op, msg, send }) => {
        if (op === 0) send(1, { cmd: 'DISPATCH', evt: 'READY', data: { user: { username: 'u' } } });
        else if (msg.cmd === 'SET_ACTIVITY') {
          activities.push(msg.args.activity);
          send(1, { cmd: 'SET_ACTIVITY', data: msg.args.activity, evt: null, nonce: msg.nonce });
        }
      });
      const h = spawnHelper({ PORT: String(port), DISCORD_IPC_PATH: ipcPath });
      try {
        await waitForHealth(port, h, true);

        const bodyBuf = Buffer.from(JSON.stringify({
          state: { screen: 'game', pokemon: 'Pokémon', biome: 'PokéBonk', level: 5 },
          ts: Date.now(),
        }), 'utf8');
        const splitIdx = bodyBuf.indexOf(Buffer.from([0xc3, 0xa9])) + 1;
        assert.ok(splitIdx > 1, 'should find UTF-8 sequence');

        const status = await new Promise((resolve, reject) => {
          const sock = net.createConnection(port, '127.0.0.1');
          let rawRes = '';
          sock.on('error', reject);
          sock.on('data', (d) => { rawRes += d.toString('utf8'); });
          sock.on('end', () => resolve(rawRes));
          const reqHead =
            `POST /state HTTP/1.1\r\n` +
            `Host: 127.0.0.1:${port}\r\n` +
            `Content-Type: text/plain\r\n` +
            `Content-Length: ${bodyBuf.length}\r\n` +
            `Connection: close\r\n\r\n`;
          sock.write(Buffer.concat([Buffer.from(reqHead, 'utf8'), bodyBuf.subarray(0, splitIdx)]));
          setTimeout(() => sock.write(bodyBuf.subarray(splitIdx)), 30);
        });
        assert.ok(status.startsWith('HTTP/1.1 204'), status);
        await waitFor(() => activities.length >= 1, 'UTF-8 activity');
        assert.strictEqual(activities[0].details, 'Pokémon · Lv. 5');
        assert.strictEqual(activities[0].state, 'PokéBonk');

        const huge = await postJson(port, { state: { pokemon: 'A'.repeat(25000) } });
        assert.strictEqual(huge, 413);
      } finally {
        await h.stop();
        await fake.close();
      }
    });

    // 3. Concurrent IPC connections while disconnected share one connection cleanly
    await runTest('concurrent setActivity calls while disconnected share one IPC connection cleanly', async () => {
      const port = await getFreePort();
      const ipcPath = makeIpcPath('concurrent');
      const h = spawnHelper({ PORT: String(port), DISCORD_IPC_PATH: ipcPath, STALE_MS: '15000' });
      let fake = null;
      try {
        await waitForHealth(port, h, false);
        const now = Date.now();
        const [res1, res2] = await Promise.all([
          postJson(port, { state: { pokemon: 'Pikachu', level: 3 }, ts: now }),
          postJson(port, { state: { pokemon: 'Raichu', level: 10 }, ts: now + 1 }),
        ]);
        assert.strictEqual(res1, 204);
        assert.strictEqual(res2, 204);

        const activities = [];
        let handshakes = 0;
        fake = await startFakeIpc(ipcPath, ({ op, msg, send }) => {
          if (op === 0) {
            handshakes++;
            send(1, { cmd: 'DISPATCH', evt: 'READY', data: { user: { username: 'u' } } });
          } else if (msg.cmd === 'SET_ACTIVITY') {
            activities.push(msg.args.activity);
            send(1, { cmd: 'SET_ACTIVITY', data: msg.args.activity, evt: null, nonce: msg.nonce });
          }
        });

        await waitFor(() => activities.some((a) => a && a.details === 'Raichu · Lv. 10'), 'latest non-null activity after late IPC start', 10000);
        assert.ok(activities.every((a) => a !== null));
        assert.strictEqual(handshakes, 1);
        assert.strictEqual(h.child.exitCode, null);
      } finally {
        await h.stop();
        if (fake) await fake.close();
      }
    });

    // 4. Positive dex, PokéBonk fallback, and explicit clear
    await runTest('positive dex, PokéBonk fallback, and explicit clear work properly', async () => {
      const port = await getFreePort();
      const ipcPath = makeIpcPath('sanitize');
      const activities = [];
      const fake = await startFakeIpc(ipcPath, ({ op, msg, send }) => {
        if (op === 0) send(1, { cmd: 'DISPATCH', evt: 'READY', data: { user: { username: 'u' } } });
        else if (msg.cmd === 'SET_ACTIVITY') {
          activities.push(msg.args.activity);
          send(1, { cmd: 'SET_ACTIVITY', evt: null, data: msg.args.activity, nonce: msg.nonce });
        }
      });
      const h = spawnHelper({ PORT: String(port), DISCORD_IPC_PATH: ipcPath, MIN_UPDATE_MS: '50' });
      try {
        await waitForHealth(port, h, true);

        await postJson(port, {
          state: { screen: 'game', pokemon: 'Gengar', level: 20, dex: -5, biome: '' },
          ts: Date.now(),
        });
        await waitFor(() => activities.length >= 1, 'activity');
        assert.strictEqual(activities[0].details, 'Gengar · Lv. 20');
        assert.strictEqual(activities[0].state, 'PokéBonk');
        assert.strictEqual(activities[0].assets, undefined, 'negative dex must not produce sprite URL');

        await postJson(port, { state: null, clear: true, ts: Date.now() });
        await waitFor(() => activities.length >= 2 && activities[activities.length - 1] === null, 'explicit clear');
      } finally {
        await h.stop();
        await fake.close();
      }
    });

    console.log(`\n${passed} helper tests passed`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((e) => {
  console.error('HELPER TEST FAIL:', e);
  process.exit(1);
});
