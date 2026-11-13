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
let fileCfg = {};
try {
  fileCfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
} catch (_) { /* config.json is optional */ }

const CLIENT_ID = process.env.DISCORD_CLIENT_ID || fileCfg.clientId || '';
const PORT = parseInt(process.env.PORT || fileCfg.port || '8765', 10);
const MIN_UPDATE_MS = parseInt(process.env.MIN_UPDATE_MS || '15000', 10); // Discord limit: ~1 update / 15 s
const STALE_MS = parseInt(process.env.STALE_MS || '20000', 10);           // clear the presence after this long without data
const SPRITE_URL = (dex) =>
  `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/official-artwork/${dex}.png`;

const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

if (!CLIENT_ID) {
  console.error('Missing Discord Application ID. Set DISCORD_CLIENT_ID or put "clientId" in helper/config.json.');
  process.exit(1);
}

// ---------- Discord IPC client ----------
const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };

function ipcCandidates() {
  const out = [];
  for (let i = 0; i < 10; i++) {
    if (process.platform === 'win32') {
      out.push(`\\\\?\\pipe\\discord-ipc-${i}`);
    } else {
      const dirs = [process.env.XDG_RUNTIME_DIR, process.env.TMPDIR, process.env.TMP, process.env.TEMP, '/tmp']
        .filter(Boolean);
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
    this.ready = false;
    this.buf = Buffer.alloc(0);
    this.pending = undefined; // last activity to send once connected (undefined = nothing)
    this.retry = null;
  }

  connect() {
    if (this.socket || this.retry) return;
    const tryNext = (list) => {
      if (list.length === 0) return this._scheduleRetry();
      const p = list[0];
      const sock = net.createConnection(p);
      let opened = false;
      sock.once('connect', () => { opened = true; this._attach(sock); });
      sock.once('error', () => { if (!opened) tryNext(list.slice(1)); });
    };
    tryNext(ipcCandidates());
  }

  _scheduleRetry() {
    if (this.retry) return;
    this.retry = setTimeout(() => { this.retry = null; this.connect(); }, 5000);
  }

  _attach(sock) {
    this.socket = sock;
    this.buf = Buffer.alloc(0);
    sock.on('data', (d) => this._onData(d));
    sock.on('close', () => {
      log('Discord: disconnected');
      this.socket = null;
      this.ready = false;
      this._scheduleRetry();
    });
    sock.on('error', () => {});
    sock.write(encode(OP.HANDSHAKE, { v: 1, client_id: this.clientId }));
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 8) {
      const op = this.buf.readInt32LE(0);
      const len = this.buf.readInt32LE(4);
      if (this.buf.length < 8 + len) break;
      let payload = null;
      try { payload = JSON.parse(this.buf.slice(8, 8 + len).toString('utf8')); } catch (_) {}
      this.buf = this.buf.slice(8 + len);
      this._handle(op, payload);
    }
  }

  _handle(op, payload) {
    if (op === OP.PING) return this.socket && this.socket.write(encode(OP.PONG, payload));
    if (op === OP.CLOSE) {
      log('Discord closed the connection:', payload && payload.message);
      return this.socket && this.socket.destroy();
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
      st = 'Limited-time event';
      big = state.event || 'PokéBonk';
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
  const stateParts = [state.biome || 'Pokebonk'];
  if (state.zoneLabel) stateParts.push(state.zoneLabel);
  else if (state.zone && state.zones) stateParts.push(`Zone ${state.zone}/${state.zones}`);
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
  if (['menu', 'league', 'map', 'dex', 'event', 'coop', 'other'].includes(raw.screen)) {
    return {
      screen: raw.screen,
      dex: int(raw.dex),
      pokemon: str(raw.pokemon),
      role: str(raw.role, 30),
      types: Array.isArray(raw.types) ? raw.types.slice(0, 2).map((t) => str(t, 20)) : [],
      league: str(raw.league, 12),
      pokedex: str(raw.pokedex, 12),
      map: str(raw.map),
      realm: str(raw.realm, 30),
      mode: str(raw.mode, 30),
      tier: str(raw.tier, 20),
      kind: str(raw.kind, 20),
      progress: str(raw.progress, 12),
      event: str(raw.event, 60),
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
    dex: int(raw.dex),
    kos: str(raw.kos, 10),
    biome: str(raw.biome),
    zone: int(raw.zone),
    zones: int(raw.zones),
    zoneLabel: str(raw.zoneLabel, 20),
    tier: str(raw.tier, 20),
    weather: str(raw.weather, 20),
    runMs: int(raw.runMs),
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

function signature(state, start) {
  const a = buildActivity(state, start);
  return JSON.stringify(a);
}

function flush() {
  flushTimer = null;
  if (!current) return;
  const sig = signature(current, runStart);
  if (sig === sentSig) return;
  const wait = MIN_UPDATE_MS - (Date.now() - sentAt);
  if (wait > 0) {
    flushTimer = setTimeout(flush, wait);
    return;
  }
  const activity = buildActivity(current, runStart);
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
  else if (['dex', 'event', 'coop', 'other'].includes(state.screen)) state.dex = lastDex;
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

setInterval(() => {
  if (!cleared && Date.now() - lastGoodAt > STALE_MS) {
    ipc.setActivity(null);
    cleared = true;
    sentSig = null;
    runStart = null;
    current = null;
    log('Presence cleared (no data from the game)');
  }
}, 2000).unref();

// ---------- HTTP server ----------
const server = http.createServer((req, res) => {
  const origin = req.headers.origin;
  // Only accept requests from the extension (or without an Origin, e.g. curl) - never from random websites.
  if (origin && !/^(chrome|moz)-extension:\/\//.test(origin)) {
    res.writeHead(403).end();
    return;
  }
  if (req.method === 'POST' && req.url === '/state') {
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 20000) req.destroy(); });
    req.on('end', () => {
      try {
        const msg = JSON.parse(body);
        onState(msg.state, Date.now());
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

server.listen(PORT, '127.0.0.1', () => {
  log(`Helper listening on http://127.0.0.1:${PORT}`);
  ipc.connect();
});

process.on('SIGINT', () => { try { ipc.setActivity(null); } catch (_) {} setTimeout(() => process.exit(0), 200); });
