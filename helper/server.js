#!/usr/bin/env node
// Helper: receives the game state from the extension (HTTP on 127.0.0.1) and sets the Rich Presence
// through Discord's local IPC. No external dependencies - Node 18+ is enough.
'use strict';

const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- configuration ----------
// When packaged as a single executable (Node SEA, see scripts/build-exe.js) there is no source
// directory: config.json is looked up next to the .exe and a default ID may be embedded at build time.
let sea = null;
try {
  const s = require('node:sea');
  if (s.isSea()) sea = s;
} catch (_) { /* normal Node run (or Node < 20.12) */ }
const baseDir = sea ? path.dirname(process.execPath) : __dirname;

// Priority: environment variable > config.json next to the helper > ID embedded in the .exe.
let startupFailed = false;

const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

// Print an error and exit. In the .exe the console window would vanish instantly on double-click,
// so wait for Enter first.
function fatal(message) {
  if (startupFailed) return;
  startupFailed = true;
  console.error(message);
  if (sea && process.stdin.isTTY) {
    console.error('\nPress Enter to close.');
    process.stdin.once('data', () => process.exit(1));
  } else {
    process.exit(1);
  }
}

function loadConfigFile(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return {};
    fatal(`Could not read ${path.basename(filePath)}: ${err.message}`);
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    fatal(`Invalid ${path.basename(filePath)}: ${err.message}`);
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fatal(`Invalid ${path.basename(filePath)}: expected a JSON object.`);
    return {};
  }
  return parsed;
}

function parseIntSetting(raw, fallback, name, min, max) {
  if (raw === undefined || raw === null) return fallback;
  const s = String(raw).trim();
  if (s === '') return fallback;
  if (!/^\d+$/.test(s)) {
    fatal(`Invalid ${name}: "${s}" is not a valid integer.`);
    return fallback;
  }
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    fatal(`Invalid ${name}: ${n} must be between ${min} and ${max}.`);
    return fallback;
  }
  return n;
}

const fileCfg = loadConfigFile(path.join(baseDir, 'config.json'));

let bundledCfg = {};
if (sea) {
  try {
    const rawBundled = JSON.parse(sea.getAsset('default-config.json', 'utf8'));
    if (rawBundled && typeof rawBundled === 'object' && !Array.isArray(rawBundled)) bundledCfg = rawBundled;
  } catch (_) { /* nothing embedded */ }
}

const rawClientId =
  (process.env.DISCORD_CLIENT_ID !== undefined && process.env.DISCORD_CLIENT_ID !== '' ? process.env.DISCORD_CLIENT_ID : undefined) ??
  (fileCfg.clientId !== undefined && fileCfg.clientId !== '' ? fileCfg.clientId : undefined) ??
  (bundledCfg.clientId !== undefined && bundledCfg.clientId !== '' ? bundledCfg.clientId : undefined) ??
  '';
let CLIENT_ID = '';
if (typeof rawClientId !== 'string') {
  fatal('Invalid Discord Application ID: clientId in config.json must be a quoted string.');
} else {
  CLIENT_ID = rawClientId.trim();
}
if (!startupFailed && !/^\d{15,25}$/.test(CLIENT_ID)) {
  fatal(
    (CLIENT_ID ? 'The Discord Application ID is not valid (it should be a long number).' : 'Missing Discord Application ID.') +
    '\nSet DISCORD_CLIENT_ID, or put {"clientId": "123456789012345678"} in a config.json next to ' +
    (sea ? 'this program' : 'helper/server.js') + '.',
  );
}

const PORT = parseIntSetting(
  process.env.PORT !== undefined && process.env.PORT !== '' ? process.env.PORT : fileCfg.port,
  8765, 'PORT', 1, 65535,
);
const MIN_UPDATE_MS = parseIntSetting(process.env.MIN_UPDATE_MS, 15000, 'MIN_UPDATE_MS', 0, 3600000); // Discord limit: ~1 update / 15 s
const STALE_MS = parseIntSetting(process.env.STALE_MS, 90000, 'STALE_MS', 1000, 3600000);           // clear the presence after this long without data
const IPC_PATH = (process.env.DISCORD_IPC_PATH || '').trim();
const SPRITE_URL = (dex) =>
  `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${dex}.png`;

// ---------- Discord IPC client ----------
const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };

function ipcCandidates() {
  if (IPC_PATH) return [IPC_PATH];
  const out = [];
  const dirs = process.platform === 'win32'
    ? []
    : Array.from(new Set([process.env.XDG_RUNTIME_DIR, process.env.TMPDIR, process.env.TMP, process.env.TEMP, '/tmp'].filter(Boolean)));
  for (let i = 0; i < 10; i++) {
    if (process.platform === 'win32') {
      out.push(`\\\\?\\pipe\\discord-ipc-${i}`);
    } else {
      for (const d of dirs) {
        out.push(path.join(d, `discord-ipc-${i}`));
        out.push(path.join(d, 'snap.discord', `discord-ipc-${i}`));
        out.push(path.join(d, 'app', 'com.discordapp.Discord', `discord-ipc-${i}`));
      }
    }
  }
  return out;
}

function encode(op, payload) {
  const data = Buffer.from(JSON.stringify(payload), 'utf8');
  const buf = Buffer.alloc(8 + data.length);
  buf.writeInt32LE(op, 0);
  buf.writeInt32LE(data.length, 4);
  data.copy(buf, 8);
  return buf;
}

class DiscordIPC {
  constructor(clientId) {
    this.clientId = clientId;
    this.socket = null;
    this.connecting = false;
    this.ready = false;
    this.pending = undefined; // last activity to send once connected (undefined = nothing)
    this.retry = null;
    this.destroyed = false;
  }

  connect() {
    if (this.destroyed || this.socket || this.connecting || this.retry) return;
    this.connecting = true;
    const tryNext = (list) => {
      if (this.destroyed) { this.connecting = false; return; }
      if (list.length === 0) { this.connecting = false; return this._scheduleRetry(); }
      const sock = net.createConnection(list[0]);
      let opened = false;
      sock.once('connect', () => {
        opened = true;
        this.connecting = false;
        if (this.destroyed) { sock.destroy(); return; }
        this._attach(sock);
      });
      sock.once('error', () => { if (!opened) tryNext(list.slice(1)); });
    };
    tryNext(ipcCandidates());
  }

  _scheduleRetry() {
    if (this.destroyed || this.retry) return;
    this.retry = setTimeout(() => { this.retry = null; this.connect(); }, 5000);
  }

  _attach(sock) {
    this.socket = sock;
    this.ready = false;
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      if (this.socket !== sock) return;
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 8) {
        const op = buf.readInt32LE(0);
        const len = buf.readInt32LE(4);
        if (len < 0) { sock.destroy(); return; }
        if (buf.length < 8 + len) break;
        let payload = null;
        try { payload = JSON.parse(buf.subarray(8, 8 + len).toString('utf8')); } catch (_) {}
        buf = buf.subarray(8 + len);
        this._handle(sock, op, payload);
        if (this.socket !== sock) return;
      }
    });
    sock.on('close', () => {
      if (this.socket !== sock) return;
      log('Discord: disconnected');
      this.socket = null;
      this.ready = false;
      if (!this.destroyed) this._scheduleRetry();
    });
    sock.on('error', () => {});
    sock.write(encode(OP.HANDSHAKE, { v: 1, client_id: this.clientId }));
  }

  _handle(sock, op, payload) {
    if (this.socket !== sock) return;
    if (op === OP.PING) return sock.write(encode(OP.PONG, payload));
    if (op === OP.CLOSE) {
      log('Discord closed the connection:', payload && payload.message);
      return sock.destroy();
    }
    if (payload && payload.evt === 'READY') {
      this.ready = true;
      const u = payload.data && payload.data.user;
      log('Discord: connected' + (u ? ` as ${u.username}` : ''));
      if (this.pending !== undefined) this._send(this.pending);
    } else if (payload && payload.evt === 'ERROR') {
      log('Discord: error', JSON.stringify(payload.data));
    }
  }

  _send(activity) {
    if (!this.socket || !this.ready) return;
    this.socket.write(encode(OP.FRAME, {
      cmd: 'SET_ACTIVITY',
      args: { pid: process.pid, activity: activity || null },
      nonce: crypto.randomUUID(),
    }));
  }

  // activity = object, or null to clear the presence
  setActivity(activity) {
    this.pending = activity;
    if (this.ready) this._send(activity);
    else this.connect();
  }

  shutdown() {
    this.destroyed = true;
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    if (this.ready && this.socket) {
      try { this._send(null); } catch (_) {}
      const s = this.socket;
      setTimeout(() => { try { s.destroy(); } catch (_) {} }, 150).unref();
    } else if (this.socket) {
      try { this.socket.destroy(); } catch (_) {}
    }
  }
}

// ---------- building the activity ----------
const clip = (s, n = 128) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const pad2 = (s) => (s.length < 2 ? s + ' ' : s); // Discord requires at least 2 characters

function buildActivity(state, runStartSec) {
  if (state.screen && state.screen !== 'game') {
    const typeStr = state.types && state.types.length ? ` (${state.types.join('/')})` : '';
    let details, st, big;
    if (state.screen === 'menu') {
      details = 'In the main menu';
      st = 'Getting ready for a run';
      big = [state.league && `League ${state.league}`, state.pokedex && `Pokédex ${state.pokedex}`].filter(Boolean).join(' · ') || 'PokéBonk';
    } else if (state.screen === 'league') {
      details = 'Choosing my Pokémon';
      st = [state.pokemon && `Looking at ${state.pokemon}`, state.role].filter(Boolean).join(' · ') || 'The League';
      big = state.pokemon + typeStr;
    } else if (state.screen === 'map') {
      details = state.pokemon ? `Choosing a map with ${state.pokemon}` : 'Choosing a map';
      st = [state.map, state.tier, state.mode].filter(Boolean).join(' · ') || 'Map selection';
      big = [state.realm, state.map].filter(Boolean).join(' · ') || 'PokéBonk';
    } else if (state.screen === 'dex') {
      details = 'Browsing the Pokédex';
      st = state.kind === 'notebook'
        ? `Research Notebook${state.progress ? ` · ${state.progress} families` : ''}`
        : (state.progress ? `${state.progress} seen` : 'Pokédex');
      big = 'PokéBonk';
    } else if (state.screen === 'event') {
      details = state.event ? `Preparing for ${state.event}` : 'Preparing for the event';
      st = state.mode || 'Limited-time event';
      big = state.event || 'PokéBonk';
    } else if (state.screen === 'expedition') {
      details = state.event ? `Preparing for ${state.event}` : 'Preparing for an expedition';
      st = [state.map, state.mode].filter(Boolean).join(' · ') || 'Expedition';
      big = [state.event || 'Expedition', state.map].filter(Boolean).join(' · ');
    } else if (state.screen === 'mutation') {
      details = 'Daily Mutation';
      st = [state.mutation, state.tier].filter(Boolean).join(' · ') || 'Getting ready for a run';
      big = state.mutation || 'Daily Mutation';
    } else if (state.screen === 'coop') {
      details = state.lobby ? 'Waiting in a Co-op lobby' : 'Setting up a Co-op run';
      st = 'Playing with friends';
      big = 'Co-op';
    } else {
      details = 'Browsing the menus';
      st = 'Between runs';
      big = 'PokéBonk';
    }
    const activity = { type: 0, details: pad2(clip(details)), state: pad2(clip(st)), instance: false };
    if (state.dex) activity.assets = { large_image: SPRITE_URL(state.dex), large_text: pad2(clip(big || 'PokéBonk')) };
    return activity;
  }

  const detailsParts = [state.pokemon];
  if (state.level) {
    detailsParts.push(`Lv. ${state.level}`);
  }
  if (state.kos) {
    detailsParts.push(`K.Os ${state.kos}`);
  }
  const details = detailsParts.join(' · ');
  const stateParts = [state.biome || 'PokéBonk'];
  if (state.zoneLabel) stateParts.push(state.zoneLabel);
  else if (state.zone && state.zones) stateParts.push(`Zone ${state.zone}/${state.zones}`);
  if (state.coop) stateParts.push('Co-op');
  if (state.tier) stateParts.push(state.tier);
  if (state.weather) stateParts.push(state.weather);
  // While paused or after the run ended the game clock is frozen, so the Discord timer is dropped.
  const frozen = state.phase === 'paused' || state.phase === 'ended';
  if (state.phase === 'paused') stateParts.unshift('Paused');
  if (state.phase === 'ended') stateParts.unshift('Run ended');

  const activity = {
    type: 0,
    details: pad2(clip(details)),
    state: pad2(clip(stateParts.join(' · '))),
    instance: false,
  };
  if (runStartSec && !frozen) activity.timestamps = { start: runStartSec };
  if (state.dex) {
    const typeStr = state.types && state.types.length ? ` (${state.types.join('/')})` : '';
    activity.assets = {
      large_image: SPRITE_URL(state.dex),
      large_text: pad2(clip(state.pokemon + typeStr)),
    };
  }
  return activity;
}

function sanitize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const str = (v, n = 80) => (typeof v === 'string' ? v.slice(0, n) : '');
  const int = (v) => (Number.isFinite(v) ? Math.trunc(v) : null);
  const posInt = (v) => (Number.isFinite(v) && Math.trunc(v) > 0 ? Math.trunc(v) : null);
  const nonNegInt = (v) => (Number.isFinite(v) && Math.trunc(v) >= 0 ? Math.trunc(v) : null);
  if (['menu', 'league', 'map', 'dex', 'event', 'expedition', 'mutation', 'coop', 'other'].includes(raw.screen)) {
    return {
      screen: raw.screen,
      dex: posInt(raw.dex),
      pokemon: str(raw.pokemon),
      role: str(raw.role, 30),
      types: Array.isArray(raw.types) ? raw.types.slice(0, 2).map((t) => str(t, 20)) : [],
      league: str(raw.league, 12),
      pokedex: str(raw.pokedex, 12),
      map: str(raw.map),
      realm: str(raw.realm, 30),
      mode: str(raw.mode, 30),
      tier: str(raw.tier, 40),
      kind: str(raw.kind, 20),
      progress: str(raw.progress, 12),
      event: str(raw.event, 60),
      mutation: str(raw.mutation, 40),
      lobby: raw.lobby === true,
      runMs: null,
    };
  }
  const pokemon = str(raw.pokemon);
  if (!pokemon) return null;
  return {
    pokemon,
    level: int(raw.level),
    types: Array.isArray(raw.types) ? raw.types.slice(0, 2).map((t) => str(t, 20)) : [],
    dex: posInt(raw.dex),
    kos: str(raw.kos, 10),
    biome: str(raw.biome),
    zone: int(raw.zone),
    zones: int(raw.zones),
    zoneLabel: str(raw.zoneLabel, 20),
    tier: str(raw.tier, 40),
    coop: raw.coop === true,
    weather: str(raw.weather, 20),
    runMs: nonNegInt(raw.runMs),
    phase: raw.phase === 'paused' || raw.phase === 'ended' ? raw.phase : 'running',
  };
}

// ---------- update logic ----------
const ipc = new DiscordIPC(CLIENT_ID);
let lastGoodAt = 0;
let current = null;        // last valid state
let sentSig = null;        // signature of the last sent activity
let sentAt = 0;
let runStart = null;       // epoch seconds
let flushTimer = null;
let cleared = true;
let lastDex = null;        // last Pokémon seen anywhere: used as the icon on screens without one
let lastPhase = null;

function clearPresence(reason) {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!cleared) {
    ipc.setActivity(null);
    log(`Presence cleared (${reason})`);
  }
  cleared = true;
  lastGoodAt = 0;
  sentSig = null;
  runStart = null;
  current = null;
  lastPhase = null;
}

function flush() {
  flushTimer = null;
  if (!current) return;
  const activity = buildActivity(current, runStart);
  const sig = JSON.stringify(activity);
  if (sig === sentSig) return;
  const wait = MIN_UPDATE_MS - (Date.now() - sentAt);
  if (wait > 0) {
    flushTimer = setTimeout(flush, wait);
    return;
  }
  ipc.setActivity(activity);
  sentSig = sig;
  sentAt = Date.now();
  cleared = false;
  log('Presence:', activity.details, '|', activity.state);
}

function onState(raw, receivedAt) {
  const state = sanitize(raw);
  if (!state) return; // unknown screen / no HUD: wait for STALE_MS, then clear
  lastGoodAt = receivedAt;
  if (state.dex) lastDex = state.dex;
  else if (['dex', 'event', 'expedition', 'mutation', 'coop', 'other'].includes(state.screen)) state.dex = lastDex;
  current = state;

  // Run start = now - run clock. Recomputed when the clock clearly jumped (new run) and right after
  // a pause / game over, because the game clock stood still meanwhile. Kept as is while frozen.
  const frozen = state.phase === 'paused' || state.phase === 'ended';
  if (state.runMs === null) {
    runStart = null;
  } else if (!frozen) {
    const expected = Math.round((receivedAt - state.runMs) / 1000);
    if (runStart === null || Math.abs(expected - runStart) > 30 || (lastPhase && lastPhase !== 'running')) runStart = expected;
  }
  lastPhase = state.phase || null;
  if (!flushTimer) flush();
}

// ---------- HTTP server ----------
const MAX_BODY_BYTES = 20000;
const server = http.createServer((req, res) => {
  const origin = req.headers.origin;
  // Only accept requests from the extension (or without an Origin, e.g. curl) - never, ever, from random websites.
  if (origin && !/^(chrome|moz)-extension:\/\//.test(origin)) {
    res.writeHead(403).end();
    return;
  }
  if (req.method === 'POST' && req.url === '/state') {
    const chunks = [];
    let totalBytes = 0;
    let aborted = false;
    req.on('data', (d) => {
      if (aborted) return;
      totalBytes += d.length;
      if (totalBytes > MAX_BODY_BYTES) {
        aborted = true;
        res.writeHead(413, { Connection: 'close' }).end(() => req.destroy());
        return;
      }
      chunks.push(d);
    });
    req.on('end', () => {
      if (aborted) return;
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        const msg = JSON.parse(body);
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
          res.writeHead(400).end();
          return;
        }
        if (msg.clear === true && (msg.state === null || msg.state === undefined)) {
          clearPresence('game tab closed');
        } else {
          onState(msg.state, Date.now());
        }
        res.writeHead(204).end();
      } catch (_) {
        res.writeHead(400).end();
      }
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, discordReady: ipc.ready }));
    return;
  }
  res.writeHead(404).end();
});

// In the .exe, fatal() only waits for Enter, so make sure nothing starts with an invalid ID or config.
if (!startupFailed) {
  setInterval(() => {
    if (!cleared && Date.now() - lastGoodAt > STALE_MS) {
      clearPresence('no data from the game');
    }
  }, 2000).unref();

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      fatal(`Port ${PORT} on 127.0.0.1 is already in use. Is another PokéBonk helper already running?`);
    } else {
      fatal(`HTTP server error: ${err ? err.message : 'unknown error'}`);
    }
  });

  server.listen(PORT, '127.0.0.1', () => {
    log(`Helper listening on http://127.0.0.1:${PORT}`);
    ipc.connect();
  });
}

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  try { ipc.shutdown(); } catch (_) {}
  try { server.close(); } catch (_) {}
  setTimeout(() => process.exit(0), 200).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
