'use strict';

/* ============================================================
   Assistant Coach — fair-play sub timer
   All game time is measured in "game seconds" (the clock only
   advances while running), derived from timestamps so it stays
   correct if the phone sleeps or the app is backgrounded.
   ============================================================ */

const KEY = 'assistant-coach.v1';
const QUARTERS = 4;
const TARGET_RUN = 300;  // ideal time on the field per shift (s)
const MAX_REST = 240;    // longest we'd like anyone to sit (s)
const MIN_RUN = 180;     // shortest worthwhile shift (s)
const MIN_GAP = 150;     // don't ask the coach to sub more often than this (s)
const HEADS_UP = 20;     // "get ready" warning before a sub window (s)
const FRESH = 90;        // don't pull someone who just went on (s)
const SIDELINE_REASONS = ['Injury', 'Bathroom', 'Other'];
// Made-up names for trying the app; real rosters live only in the phone's storage.
const DEMO_TEAM = ['Avery', 'Bea', 'Cruz', 'Dev', 'Emery', 'Finn', 'Gia', 'Hollis', 'Ines', 'Jules'];

let store = load();
let view = { screen: 'home', summaryId: null, draft: null, setup: null, sheet: null, confirm: null, keep: new Set() };
let undoStack = [];
const alerted = { heads: null, due: null };

/* ---------- persistence ---------- */

function load() {
  const fresh = { roster: [], settings: { onField: 6, quarterMin: 10, sheetUrl: '' }, game: null, history: [] };
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s) return { ...fresh, ...s, settings: { ...fresh.settings, ...s.settings } };
  } catch {}
  return fresh;
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch {} }

/* ---------- utils ---------- */

const uid = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function fmt(sec) {
  sec = Math.max(0, Math.round(sec));
  return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
}
const fmtDelta = d => (Math.round(d) >= 0 ? '+' : '−') + fmt(Math.abs(d));
const G = () => store.game;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/* ---------- game clock & player time ---------- */

const qEnd = g => g.qStart + g.quarterSec;
function now(g = G()) {
  let t = g.clock.acc;
  if (g.clock.since) t += (Date.now() - g.clock.since) / 1000;
  return Math.min(t, qEnd(g));
}
const running = g => !!g.clock.since;
const played = (p, t) => p.played + (p.state === 'field' ? t - p.since : 0);
const stint = (p, t) => t - p.since;

// Bank time on the field up to t.
function flush(p, t) {
  if (p.state === 'field') {
    const d = t - p.since;
    p.played += d;
    if (p.gk) p.gkSec += d;
    p.since = t;
  }
}
function move(p, state, t) {
  flush(p, t);
  if (p.state !== state) {
    if (state === 'field') p.stints++;
    p.state = state;
    p.since = t;
  }
  if (state !== 'field') p.gk = false;
}
const avail = g => Object.values(g.players).filter(p => p.state !== 'out');
const onField = g => Object.values(g.players).filter(p => p.state === 'field');
const onBench = g => Object.values(g.players).filter(p => p.state === 'bench');

/* Fair share: while a kid is available (here and not sidelined) they earn
   an equal slice of the field time — onField / available per game second.
   Time they weren't available earns nothing, so late arrivals and injuries
   aren't penalized, but the app doesn't over-play them to catch up either. */
function shareRate(g) {
  const n = avail(g).length;
  return n ? Math.min(g.onField, n) / n : 0;
}
// Bank everyone's fair share up to t. Call before anyone's availability changes.
function accrue(g, t) {
  const dt = t - (g.fairT ?? t);
  if (dt > 0) { const r = shareRate(g); avail(g).forEach(p => { p.fair = (p.fair || 0) + dt * r; }); }
  g.fairT = t;
}
const fair = (g, p, t) => (p.fair || 0) + (p.state !== 'out' ? Math.max(0, t - (g.fairT ?? t)) * shareRate(g) : 0);
const gap = (g, p, t) => played(p, t) - fair(g, p, t);

/* ---------- sub planning ----------
   S skaters on the field, B extra skaters on the bench.
   Each shift: on for Lon, off for Lon*B/S. Swap k players every T seconds,
   where T = k*Lon/S. Pick the smallest k that keeps T >= MIN_GAP, then
   snap T so sub windows divide the quarter evenly. */

function computePlan(g) {
  const S = g.onField - 1;
  const pool = avail(g).length - 1;
  const B = pool - S;
  if (B <= 0) return { k: 0, T: null, S, B: 0, short: pool < S };
  let Lon = Math.max(MIN_RUN, Math.min(TARGET_RUN, MAX_REST * S / B));
  let k = 1, T = Lon / S;
  while (T < MIN_GAP && k < B) { k++; T = k * Lon / S; }
  T = Math.max(T, MIN_GAP);
  const windows = Math.max(1, Math.round(g.quarterSec / T));
  if (windows === 1) return { k, T: null, S, B, Lon: g.quarterSec, Loff: g.quarterSec };
  T = g.quarterSec / windows;
  Lon = T * S / k;
  return { k, T, S, B, Lon, Loff: Lon * B / S };
}
function nextWindow(g, t) {
  if (!g.plan?.T) return null;
  const n = Math.floor((t - g.qStart) / g.plan.T + 1e-6) + 1;
  const at = g.qStart + n * g.plan.T;
  return at <= qEnd(g) - 45 ? at : null;
}
function replan(g, t) { g.plan = computePlan(g); g.nextSubAt = nextWindow(g, t); }

// Doing subs near (or after) a window counts as handling it.
function windowHandled(g, t) {
  if (g.nextSubAt != null && t >= g.nextSubAt - HEADS_UP) g.nextSubAt = nextWindow(g, Math.max(t, g.nextSubAt));
}
function subStatus(g, t) {
  if (g.nextSubAt == null) return 'none';
  if (t >= g.nextSubAt) return 'due';
  if (t >= g.nextSubAt - HEADS_UP) return 'soon';
  return 'wait';
}

// Most-played skaters come off (skip anyone who just went on); least-played go in.
function suggest(g, t, k) {
  const out = onField(g).filter(p => !p.gk && stint(p, t) >= FRESH)
    .sort((a, b) => gap(g, b, t) - gap(g, a, t) || stint(b, t) - stint(a, t));
  const inn = onBench(g).sort((a, b) => gap(g, a, t) - gap(g, b, t) || a.since - b.since);
  const n = Math.min(k, out.length, inn.length);
  return Array.from({ length: n }, (_, i) => [out[i], inn[i]]);
}

function suggestLineup(g) {
  const t = now(g);
  const ps = avail(g);
  const byGap = (a, b) => gap(g, a, t) - gap(g, b, t);
  const gk = [...ps].sort((a, b) => a.gkQ - b.gkQ || byGap(a, b))[0];
  const field = ps.filter(p => p !== gk).sort(byGap).slice(0, g.onField - 1).map(p => p.id);
  return { gk: gk?.id ?? null, field: new Set(field) };
}

/* ---------- undo (player moves only; the clock is never rewound) ---------- */

function pushUndo() {
  const g = G();
  undoStack.push(JSON.stringify({ players: g.players, plan: g.plan, nextSubAt: g.nextSubAt, fairT: g.fairT }));
  if (undoStack.length > 20) undoStack.shift();
}
function undo() {
  const snap = undoStack.pop();
  if (!snap) return;
  Object.assign(G(), JSON.parse(snap));
  save(); render();
}

/* ---------- game actions ---------- */

function createGame() {
  const s = view.setup;
  const t = 0;
  const players = {};
  store.roster.filter(r => s.present.has(r.id)).forEach(r => {
    players[r.id] = { id: r.id, name: r.name, state: 'bench', gk: false, played: 0, gkSec: 0, since: t, gkQ: 0, stints: 0, reason: null, fair: 0 };
  });
  store.settings.onField = s.onField;
  store.settings.quarterMin = s.quarterMin;
  store.game = {
    id: uid(), date: new Date().toISOString(), opponent: s.opponent.trim(),
    onField: s.onField, quarterSec: s.quarterMin * 60, quarter: 1, phase: 'lineup',
    clock: { acc: 0, since: null }, qStart: 0, qOver: false, plan: null, nextSubAt: null, fairT: 0,
  };
  G().players = players;
  view.draft = suggestLineup(G());
  save(); go('lineup');
}

function startQuarter() {
  const g = G(), d = view.draft, t = now(g);
  avail(g).forEach(p => move(p, p.id === d.gk || d.field.has(p.id) ? 'field' : 'bench', t));
  const gk = g.players[d.gk];
  gk.gk = true; gk.gkQ++;
  g.phase = 'live'; g.qOver = false;
  replan(g, t);
  undoStack = [];
  save(); go('live');
}

function toggleClock() {
  const g = G();
  if (running(g)) { g.clock.acc = now(g); g.clock.since = null; }
  else if (!g.qOver) { g.clock.since = Date.now(); keepAwake(true); }
  save(); render();
}

function endQuarterNow() {
  const g = G();
  g.clock.acc = now(g); g.clock.since = null; g.qOver = true;
  view.sheet = null; save(); render();
}

function nextQuarter() {
  const g = G(), t = now(g);
  Object.values(g.players).forEach(p => flush(p, t));
  g.quarter++; g.qStart = t; g.qOver = false; g.phase = 'lineup';
  g.clock.acc = t; g.clock.since = null;
  view.draft = suggestLineup(g);
  save(); go('lineup');
}

function doSubs(pairs, planned = false) {
  const g = G(), t = now(g);
  pushUndo();
  pairs.forEach(([off, on]) => swap(off, on, t));
  if (planned && g.nextSubAt != null) g.nextSubAt = nextWindow(g, Math.max(t, g.nextSubAt));
  else windowHandled(g, t);
  view.keep.clear();
  view.sheet = null; save(); render();
}
function swap(off, on, t) {
  const wasGk = off.gk;
  move(off, 'bench', t);
  move(on, 'field', t);
  on.gk = wasGk;
}
function skipWindow() {
  const g = G();
  g.nextSubAt = nextWindow(g, Math.max(now(g), g.nextSubAt));
  view.keep.clear();
  save(); render();
}

function makeGoalie(id) {
  const g = G(), t = now(g);
  pushUndo();
  onField(g).forEach(p => { flush(p, t); p.gk = false; });
  g.players[id].gk = true;
  view.sheet = null; save(); render();
}

function sideline(id, reason, replacementId) {
  const g = G(), t = now(g), p = g.players[id];
  pushUndo();
  accrue(g, t);
  const wasGk = p.gk;
  move(p, 'out', t);
  p.reason = reason;
  if (replacementId) {
    const r = g.players[replacementId];
    move(r, 'field', t);
    if (wasGk) { flush(r, t); r.gk = true; }
  }
  replan(g, t);
  view.sheet = null; save(); render();
}

function returnPlayer(id) {
  const g = G(), t = now(g);
  pushUndo();
  accrue(g, t);
  const p = g.players[id];
  move(p, 'bench', t); p.reason = null;
  if (g.phase === 'live') replan(g, t);
  view.sheet = null; save(); render();
}

function addLate(rosterId, name) {
  const g = G(), t = now(g);
  let r = store.roster.find(x => x.id === rosterId);
  if (!r && name) { r = { id: uid(), name }; store.roster.push(r); }
  if (!r || g.players[r.id]) return;
  accrue(g, t);
  g.players[r.id] = { id: r.id, name: r.name, state: 'bench', gk: false, played: 0, gkSec: 0, since: t, gkQ: 0, stints: 0, reason: null, fair: 0 };
  if (g.phase === 'live') replan(g, t);
  else view.draft = suggestLineup(g);
  view.sheet = null; save(); render();
}

function finishGame() {
  const g = G(), t = now(g);
  Object.values(g.players).forEach(p => flush(p, t));
  accrue(g, t);
  const h = {
    id: g.id, date: g.date, opponent: g.opponent, quarterMin: g.quarterSec / 60, onField: g.onField,
    quarters: g.quarter, gameSec: Math.round(t), synced: false,
    players: Object.values(g.players).map(p => ({ name: p.name, played: Math.round(p.played), gkSec: Math.round(p.gkSec), gkQ: p.gkQ, stints: p.stints, fair: Math.round(p.fair || 0) })),
  };
  store.history.unshift(h);
  store.game = null;
  undoStack = [];
  keepAwake(false);
  view.summaryId = h.id;
  save(); go('summary');
  syncAll();
}

function discardGame() {
  store.game = null; undoStack = []; keepAwake(false);
  save(); go('home');
}

/* ---------- Google Sheet sync (Apps Script web app) ---------- */

function payload(h) {
  const d = new Date(h.date);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return {
    gameId: h.id, date: day, opponent: h.opponent || '', quarterMin: h.quarterMin, onField: h.onField,
    present: h.players.length,
    players: h.players.map(p => ({
      name: p.name, minutes: +(p.played / 60).toFixed(1), goalieMinutes: +(p.gkSec / 60).toFixed(1),
      goalieQuarters: p.gkQ, shifts: p.stints,
      fairShareMinutes: p.fair == null ? '' : +(p.fair / 60).toFixed(1),
    })),
  };
}
let syncing = false;
async function syncAll() {
  const url = store.settings.sheetUrl;
  if (!url || syncing || !navigator.onLine) return;
  syncing = true;
  for (const h of store.history.filter(h => !h.synced)) {
    try {
      // Apps Script can't answer CORS preflights, so send a "simple" request and trust delivery.
      await fetch(url, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload(h)) });
      h.synced = true; save();
    } catch { break; }
  }
  syncing = false;
  if (['home', 'summary', 'settings'].includes(view.screen)) render();
}
window.addEventListener('online', syncAll);

/* ---------- sound, vibration, wake lock ---------- */

let actx;
function audio() {
  try {
    if (!actx) {
      actx = new (window.AudioContext || window.webkitAudioContext)();
      if (navigator.audioSession) navigator.audioSession.type = 'playback'; // play even with iOS silent switch
    }
    if (actx.state === 'suspended') actx.resume();
  } catch {}
  return actx;
}
document.addEventListener('pointerdown', audio, { passive: true });

function chime(kind) {
  const a = audio();
  const seq = { due: [[880, 0], [1175, .16], [880, .32], [1175, .48], [1568, .64]], heads: [[740, 0], [988, .18]], end: [[660, 0], [660, .35], [440, .7]] }[kind];
  if (a) seq.forEach(([f, at]) => {
    const o = a.createOscillator(), v = a.createGain(), s = a.currentTime + at;
    o.type = 'square'; o.frequency.value = f;
    v.gain.setValueAtTime(0.0001, s);
    v.gain.exponentialRampToValueAtTime(0.25, s + 0.01);
    v.gain.exponentialRampToValueAtTime(0.0001, s + (kind === 'end' ? 0.3 : 0.14));
    o.connect(v).connect(a.destination);
    o.start(s); o.stop(s + 0.35);
  });
  navigator.vibrate?.(kind === 'heads' ? 120 : [250, 100, 250, 100, 250]);
}

const noSleep = window.NoSleep ? new window.NoSleep() : null;
const isAwake = () => !!noSleep?.isEnabled;
// Must run inside a tap on iOS (the video fallback needs a user gesture).
async function keepAwake(on) {
  try {
    if (on && !isAwake()) await noSleep?.enable();
    else if (!on && isAwake()) noSleep.disable();
  } catch {}
}
// Any tap during a live game re-arms it (iOS drops it when the app is backgrounded).
document.addEventListener('pointerdown', () => { if (G()?.phase === 'live' && !isAwake()) keepAwake(true); }, { passive: true });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (G()?.phase === 'live') keepAwake(true);
  tick();
});

/* ---------- tick ---------- */

function tick() {
  const g = G();
  if (!g || g.phase !== 'live' || view.screen !== 'live') return;
  if (running(g) && g.clock.acc + (Date.now() - g.clock.since) / 1000 >= qEnd(g)) {
    g.clock.acc = qEnd(g); g.clock.since = null; g.qOver = true;
    save(); chime('end'); render(); return;
  }
  const t = now(g);
  if (g.nextSubAt != null && running(g)) {
    if (t >= g.nextSubAt && alerted.due !== g.nextSubAt) { alerted.due = g.nextSubAt; chime('due'); render(); return; }
    if (t >= g.nextSubAt - HEADS_UP && t < g.nextSubAt && alerted.heads !== g.nextSubAt) { alerted.heads = g.nextSubAt; chime('heads'); render(); return; }
  }
  // Re-render when the suggested swaps change (e.g. a fresh sub passes the minimum shift).
  const key = g.plan?.k ? suggest(g, t, g.plan.k).map(([o, i]) => o.id + i.id).join() : '';
  if (key !== lastDeck) { lastDeck = key; render(); return; }
  updateLive(g, t);
}
let lastDeck = null;
setInterval(tick, 250);

/* ============================================================
   Rendering
   ============================================================ */

const $app = document.getElementById('app');
const $sheet = document.getElementById('sheet-root');

function go(screen) {
  view.screen = screen; view.sheet = null; view.confirm = null;
  if (screen === 'setup') {
    view.setup = { present: new Set(), onField: store.settings.onField, quarterMin: store.settings.quarterMin, opponent: '' };
  }
  if (screen === 'lineup' && !view.draft) view.draft = suggestLineup(G());
  render();
  window.scrollTo(0, 0);
}

function render() {
  const screens = { home: renderHome, roster: renderRoster, setup: renderSetup, lineup: renderLineup, live: renderLive, summary: renderSummary, settings: renderSettings };
  $app.className = 'screen-' + view.screen;
  $app.innerHTML = (screens[view.screen] || renderHome)();
  renderSheet();
}

const I = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4h4.5v16H6zM13.5 4H18v16h-4.5z"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  undo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 010 11H11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  more: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="2.2"/><circle cx="12" cy="12" r="2.2"/><circle cx="19" cy="12" r="2.2"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15m-5-5l5 5-5 5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  glove: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 21v-3.2L5.2 13c-.6-1-.3-2.2.7-2.6.8-.4 1.7 0 2.1.7L9 13V5.5a1.5 1.5 0 013 0V11V4a1.5 1.5 0 013 0v7-5.5a1.5 1.5 0 013 0V15c0 3-1.6 4.6-3 5.5V21z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/></svg>',
  x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
};

/* ---------- home ---------- */

function renderHome() {
  const g = G();
  const canStart = store.roster.length >= 2;
  const unsynced = store.history.filter(h => !h.synced).length;
  return `
  <header class="masthead">
    <div class="mast-mark">${centerMark()}</div>
    <h1>Assistant<br>Coach</h1>
    <p class="mast-sub">Fair minutes for every kid. Subs on cue.</p>
  </header>
  <section class="stack pad">
    ${g ? `
      <button class="cta resume" data-act="resume">
        <span class="cta-k">Game in progress</span>
        <span class="cta-t">Resume · Q${g.quarter} ${g.phase === 'lineup' ? 'lineup' : fmt(now(g) - g.qStart)}</span>
      </button>` : `
      <button class="cta" data-act="new-game" ${canStart ? '' : 'disabled'}>
        <span class="cta-k">${canStart ? `${store.settings.onField} a side · ${store.settings.quarterMin}-min quarters` : 'Add at least 2 players first'}</span>
        <span class="cta-t">New game</span>
      </button>`}

    <div class="card">
      <div class="card-h"><h2>Roster</h2><button class="link" data-act="go" data-to="roster">${store.roster.length ? 'Edit' : 'Add players'}</button></div>
      ${store.roster.length
        ? `<div class="chips">${store.roster.map(r => `<span class="chip">${esc(r.name)}</span>`).join('')}</div>`
        : `<p class="empty">No players yet. Add your team once and pick who's here each game.</p>`}
    </div>

    <div class="card">
      <div class="card-h"><h2>Games</h2>${store.history.length ? `<span class="pill ${unsynced ? 'warn' : 'ok'}">${unsynced ? `${unsynced} not synced` : 'All synced'}</span>` : ''}</div>
      ${store.history.length ? `<ul class="list">${store.history.slice(0, 12).map(h => `
        <li><button class="list-row" data-act="view-game" data-id="${h.id}">
          <span><b>${h.opponent ? 'vs ' + esc(h.opponent) : 'Game'}</b><small>${new Date(h.date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} · ${plural(h.players.length, 'player')}</small></span>
          <span class="dot ${h.synced ? 'ok' : 'warn'}" title="${h.synced ? 'Synced' : 'Not synced'}"></span>
        </button></li>`).join('')}</ul>`
        : `<p class="empty">Finished games show up here with everyone's minutes.</p>`}
    </div>

    <button class="ghost" data-act="go" data-to="settings">Settings & Google Sheet sync</button>
  </section>`;
}

function centerMark() {
  return `<svg viewBox="0 0 64 64" aria-hidden="true"><rect x="2" y="2" width="60" height="60" rx="4" fill="none" stroke="currentColor" stroke-width="2.5"/><line x1="32" y1="2" x2="32" y2="62" stroke="currentColor" stroke-width="2.5"/><circle cx="32" cy="32" r="11" fill="none" stroke="currentColor" stroke-width="2.5"/><circle cx="32" cy="32" r="3.2" fill="var(--orange)"/></svg>`;
}

/* ---------- roster ---------- */

function renderRoster() {
  return `
  ${topbar('Roster', 'home')}
  <section class="stack pad">
    <form class="add" data-form="add-player">
      <input id="add-name" name="name" placeholder="Player name" autocomplete="off" autocapitalize="words" enterkeyhint="done">
      <button class="btn">Add</button>
    </form>
    ${store.roster.length ? `<ul class="roster">${store.roster.map((r, i) => `
      <li><span class="num">${i + 1}</span>
        <input value="${esc(r.name)}" data-rename="${r.id}" aria-label="Name">
        <button class="icon-btn" data-act="del-player" data-id="${r.id}" aria-label="Remove ${esc(r.name)}">${I.x}</button></li>`).join('')}</ul>`
      : `<p class="empty">Type a name and hit Add, or paste your whole team below.</p>
         <button class="ghost" data-act="demo-team">Just exploring? Load a demo team</button>`}
    <details class="card bulk">
      <summary>Paste a list of names</summary>
      <textarea id="bulk" rows="6" placeholder="One name per line"></textarea>
      <button class="btn" data-act="bulk-add">Add all</button>
    </details>
  </section>`;
}

/* ---------- setup ---------- */

function renderSetup() {
  const s = view.setup;
  const n = s.present.size;
  const S = s.onField - 1, B = n - 1 - S;
  return `
  ${topbar('Game day', 'home')}
  <section class="stack pad">
    <div class="card">
      <div class="card-h"><h2>Who's here?</h2><span class="count-big">${n}<small>/${store.roster.length}</small></span></div>
      <div class="toggles">${store.roster.map(r => `
        <button class="tog ${s.present.has(r.id) ? 'on' : ''}" data-act="toggle-present" data-id="${r.id}" aria-pressed="${s.present.has(r.id)}">${esc(r.name)}</button>`).join('')}
      </div>
      <div class="row-btns"><button class="link" data-act="present-all">All</button><button class="link" data-act="present-none">None</button></div>
    </div>

    <div class="card">
      <div class="stepper"><label>On the field <small>incl. goalie</small></label>
        <div class="step"><button data-act="step" data-k="onField" data-d="-1" aria-label="Fewer">−</button><output>${s.onField}</output><button data-act="step" data-k="onField" data-d="1" aria-label="More">+</button></div></div>
      <div class="stepper"><label>Quarter length <small>minutes</small></label>
        <div class="step"><button data-act="step" data-k="quarterMin" data-d="-1" aria-label="Shorter">−</button><output>${s.quarterMin}</output><button data-act="step" data-k="quarterMin" data-d="1" aria-label="Longer">+</button></div></div>
      <label class="field"><span>Opponent <small>optional</small></span><input id="opponent" value="${esc(s.opponent)}" placeholder="e.g. Blue Hawks" autocapitalize="words"></label>
    </div>

    <p class="hint">${n === 0 ? `Tap each player who's here today.` : n < s.onField ? `You need at least ${s.onField} players for ${s.onField} a side.`
      : B <= 0 ? `Exactly enough players. Everyone plays the whole game, no subs.`
      : planBlurb(computePlan({ onField: s.onField, quarterSec: s.quarterMin * 60, players: Object.fromEntries([...s.present].map(id => [id, { state: 'bench' }])) }))}</p>

    <button class="cta" data-act="create-game" ${n >= s.onField ? '' : 'disabled'}><span class="cta-k">${plural(n, 'player')} · ${B > 0 ? plural(B, 'sub') : 'no subs'}</span><span class="cta-t">Pick Q1 lineup</span></button>
  </section>`;
}

function planBlurb(p) {
  if (!p || p.B <= 0) return 'No bench this quarter. Everyone stays on.';
  if (!p.T) return `Subs happen at quarter breaks only (${plural(p.B, 'player')} on the bench each quarter).`;
  return `Swap <b>${p.k}</b> every <b>${fmt(p.T)}</b>, so each kid plays about <b>${fmt(p.Lon)}</b> at a time and sits about <b>${fmt(p.Loff)}</b>.`;
}

/* ---------- lineup ---------- */

function renderLineup() {
  const g = G(), d = view.draft, t = now(g);
  const ps = avail(g).sort((a, b) => gap(g, a, t) - gap(g, b, t));
  const out = Object.values(g.players).filter(p => p.state === 'out');
  const need = Math.min(g.onField - 1, ps.length - 1);
  const ok = d.gk && d.field.size === need && !d.field.has(d.gk);
  const showTime = g.quarter > 1;
  return `
  ${topbar(`Q${g.quarter} lineup`, 'home', `<button class="icon-btn" data-act="menu" aria-label="Game menu">${I.more}</button>`)}
  <section class="stack pad">
    <div class="lineup-count">
      <div class="lc ${d.gk ? 'done' : ''}"><span>${d.gk ? 1 : 0}<small>/1</small></span>Goalie</div>
      <div class="lc ${d.field.size === need ? 'done' : d.field.size > need ? 'over' : ''}"><span>${d.field.size}<small>/${need}</small></span>On field</div>
      <div class="lc"><span>${ps.length - d.field.size - (d.gk ? 1 : 0)}</span>Bench</div>
    </div>
    <p class="hint">Suggested lineup puts the fewest minutes on first. Tap a player to switch them between field and bench. Tap a glove to choose the goalie.</p>
    <ul class="lineup">${ps.map(p => {
      const isGk = d.gk === p.id, on = d.field.has(p.id);
      return `<li class="${isGk ? 'is-gk' : on ? 'is-on' : 'is-bench'}">
        <button class="lu-main" data-act="lu-toggle" data-id="${p.id}">
          <span class="lu-state">${isGk ? 'GK' : on ? 'ON' : 'SUB'}</span>
          <span class="lu-name">${esc(p.name)}${p.gkQ ? `<small>${plural(p.gkQ, 'qtr')} in goal</small>` : ''}</span>
          ${showTime ? `<span class="lu-time">${fmt(played(p, t))}<small>${fmtDelta(gap(g, p, t))}</small></span>` : ''}
        </button>
        <button class="glove ${isGk ? 'on' : ''}" data-act="lu-gk" data-id="${p.id}" aria-label="Make ${esc(p.name)} goalie" aria-pressed="${isGk}">${I.glove}</button>
      </li>`; }).join('')}</ul>
    ${out.length ? `<div class="card"><div class="card-h"><h2>Sidelined</h2></div>${out.map(p => `
      <div class="out-row"><span>${esc(p.name)} <small>${esc(p.reason || '')}</small></span><button class="link" data-act="return" data-id="${p.id}">Back in</button></div>`).join('')}</div>` : ''}
    <button class="cta" data-act="start-quarter" ${ok ? '' : 'disabled'}>
      <span class="cta-k">${ok ? 'Clock starts paused. Tap play on the whistle.' : !d.gk ? 'Choose a goalie' : `Pick ${need} field players`}</span>
      <span class="cta-t">Lock in Q${g.quarter}</span></button>
  </section>`;
}

/* ---------- live ---------- */

function renderLive() {
  const g = G(), t = now(g), st = subStatus(g, t);
  const field = onField(g).sort((a, b) => b.gk - a.gk || gap(g, b, t) - gap(g, a, t));
  const bench = onBench(g).sort((a, b) => gap(g, a, t) - gap(g, b, t));
  const out = Object.values(g.players).filter(p => p.state === 'out');
  const pairs = g.plan?.k ? suggest(g, t, g.plan.k) : [];
  const chosen = pairs.filter(([o]) => !view.keep.has(o.id));
  const last = g.quarter >= QUARTERS;

  return `
  <header class="board ${g.qOver ? 'over' : st}">
    <div class="board-top">
      <button class="icon-btn" data-act="go" data-to="home" aria-label="Home">${I.back}</button>
      <span class="q">Q${g.quarter}<small>/${QUARTERS}</small></span>
      <span class="opp">${g.opponent ? 'vs ' + esc(g.opponent) : ''}</span>
      <button class="icon-btn" data-act="undo" ${undoStack.length ? '' : 'disabled'} aria-label="Undo">${I.undo}</button>
      <button class="icon-btn" data-act="menu" aria-label="Game menu">${I.more}</button>
    </div>
    <div class="board-main">
      <div class="clock-wrap">
        <div class="clock" data-clock>${fmt(t - g.qStart)}</div>
        <div class="clock-sub"><span data-left>${fmt(qEnd(g) - t)}</span> left in quarter</div>
        <button class="awake ${isAwake() ? 'on' : ''}" data-act="awake" data-awake>${awakeLabel()}</button>
      </div>
      ${g.qOver ? '' : `<button class="play ${running(g) ? 'is-running' : 'is-paused'}" data-act="clock" aria-label="${running(g) ? 'Pause' : 'Start'} clock">${running(g) ? I.pause : I.play}</button>`}
    </div>
    ${subLine(g, t, st)}
  </header>

  ${g.qOver ? `
    <section class="callout end">
      <h2>End of Q${g.quarter}</h2>
      <p>${last ? 'That\'s the game. Wrap it up to save everyone\'s minutes.' : 'Time to set the next lineup. The fewest-minutes kids go on first.'}</p>
      <button class="cta dark" data-act="${last ? 'finish' : 'next-quarter'}"><span class="cta-t">${last ? 'Finish game' : `Set Q${g.quarter + 1} lineup`}</span></button>
    </section>`
  : pairs.length && (st === 'due' || st === 'soon') ? `
    <section class="callout ${st}">
      <h2>${st === 'due' ? 'Sub now' : 'Get ready to sub'}</h2>
      <p class="pair-hint">Suggested swaps. Tap one to keep that player on.</p>
      <ul class="pairs">${pairs.map(([o, i]) => { const kept = view.keep.has(o.id); return `
        <li><button class="pair ${kept ? 'kept' : ''}" data-act="toggle-pair" data-id="${o.id}" aria-pressed="${!kept}">
          <span class="po"><small>${kept ? 'Stays on' : 'Off'}</small>${esc(o.name)}</span>${I.arrow}<span class="pi"><small>${kept ? 'Stays on bench' : 'On'}</small>${esc(i.name)}</span>
        </button></li>`; }).join('')}</ul>
      <div class="row-btns">${chosen.length
        ? `<button class="cta dark" data-act="do-subs"><span class="cta-t">Make ${chosen.length === 1 ? 'this sub' : `these ${chosen.length}`}</span></button>`
        : `<button class="cta dark" data-act="skip"><span class="cta-t">Keep everyone on</span></button>`}
      ${chosen.length ? '<button class="ghost light" data-act="skip">Skip</button>' : ''}</div>
    </section>`
  : pairs.length ? `
    <section class="ondeck">
      <span class="od-k">Up next</span>
      <span class="od-v">${chosen.length ? `<b>${chosen.map(p => esc(p[1].name)).join(', ')}</b> in for ${chosen.map(p => esc(p[0].name)).join(', ')}` : 'Everyone stays on'}</span>
      ${chosen.length ? '<button class="link" data-act="do-subs">Sub now</button>' : ''}
    </section>` : ''}

  <section class="pad stack-sm">
    <div class="sec-h"><h2>On the field <span>${field.length}</span></h2><span class="legend">vs fair share</span></div>
    <ul class="players">${field.map(p => playerRow(p, t)).join('')}</ul>
    ${bench.length ? `
    <div class="sec-h"><h2>Bench <span>${bench.length}</span></h2><span class="legend">most owed first</span></div>
    <ul class="players">${bench.map(p => playerRow(p, t)).join('')}</ul>` : ''}
    ${out.length ? `
    <div class="sec-h"><h2>Sidelined <span>${out.length}</span></h2></div>
    <ul class="players">${out.map(p => playerRow(p, t)).join('')}</ul>` : ''}
    <p class="plan-note">${planBlurb(g.plan)}</p>
    ${g.qOver ? '' : `<button class="ghost" data-act="end-quarter">End Q${g.quarter} early</button>`}
  </section>`;
}

function subLine(g, t, st) {
  if (g.qOver) return `<div class="subline"><span class="sl-k">Quarter over</span></div>`;
  if (!g.plan?.T) return `<div class="subline"><span class="sl-k">${g.plan?.B > 0 ? 'Next change at quarter break' : 'No bench. Everyone plays.'}</span></div>`;
  if (g.nextSubAt == null) return `<div class="subline"><span class="sl-k">No more subs this quarter</span></div>`;
  const label = st === 'due' ? 'SUB NOW' : st === 'soon' ? 'Get ready' : 'Next sub in';
  return `<div class="subline"><span class="sl-k">${label}</span><span class="sl-v" data-next>${st === 'due' ? '+' + fmt(t - g.nextSubAt) : fmt(g.nextSubAt - t)}</span>
    <div class="sl-bar"><i data-bar style="--p:${subProgress(g, t)}"></i></div></div>`;
}
const subProgress = (g, t) => Math.min(1, Math.max(0, 1 - (g.nextSubAt - t) / g.plan.T)).toFixed(4);

function playerRow(p, t) {
  return `<li><button class="prow ${p.state}${p.gk ? ' gk' : ''}" data-act="player" data-id="${p.id}" data-pid="${p.id}">
    <span class="pr-name"><span>${p.gk ? `<i class="gk-tag">GK</i>` : ''}${esc(p.name)}</span><small data-meta>${metaText(p, t)}</small></span>
    <span class="meter"><i data-meter></i></span>
    <span class="pr-num"><b data-tot>${fmt(played(p, t))}</b><small data-delta></small></span>
  </button></li>`;
}
function metaText(p, t) {
  if (p.state === 'out') return esc(p.reason || 'Out');
  if (p.state === 'field') return `on ${fmt(stint(p, t))}`;
  return `sitting ${fmt(stint(p, t))}`;
}

const awakeLabel = () => isAwake() ? 'Screen stays on' : 'Screen may sleep · tap to keep on';

// Cheap per-tick updates (no re-render, so taps never land on a moving target).
function updateLive(g, t) {
  const q = s => $app.querySelector(s);
  const c = q('[data-clock]'); if (c) c.textContent = fmt(t - g.qStart);
  const l = q('[data-left]'); if (l) l.textContent = fmt(qEnd(g) - t);
  const st = subStatus(g, t);
  const n = q('[data-next]'); if (n && g.nextSubAt != null) n.textContent = st === 'due' ? '+' + fmt(t - g.nextSubAt) : fmt(g.nextSubAt - t);
  const aw = q('[data-awake]');
  if (aw && aw.classList.contains('on') !== isAwake()) { aw.classList.toggle('on', isAwake()); aw.textContent = awakeLabel(); }
  const b = q('[data-bar]'); if (b && g.nextSubAt != null) b.style.setProperty('--p', subProgress(g, t));
  $app.querySelectorAll('[data-pid]').forEach(el => {
    const p = g.players[el.dataset.pid]; if (!p) return;
    const tot = played(p, t), d = gap(g, p, t);
    el.querySelector('[data-tot]').textContent = fmt(tot);
    el.querySelector('[data-meta]').textContent = metaText(p, t);
    const del = el.querySelector('[data-delta]');
    del.textContent = Math.abs(d) < 5 ? 'even' : fmtDelta(d);
    const lvl = Math.abs(d) <= 60 ? 'even' : Math.abs(d) <= 150 ? 'warn' : 'hot';
    el.dataset.eq = lvl;
    el.dataset.dir = d >= 0 ? 'up' : 'down';
    const w = Math.min(1, Math.abs(d) / 240) * 50;
    const m = el.querySelector('[data-meter]');
    m.style.left = (d >= 0 ? 50 : 50 - w) + '%';
    m.style.width = Math.max(w, 1.5) + '%';
  });
}

/* ---------- summary ---------- */

function renderSummary() {
  const h = store.history.find(x => x.id === view.summaryId);
  if (!h) return renderHome();
  const ps = [...h.players].sort((a, b) => b.played - a.played);
  const avg = ps.reduce((s, p) => s + p.played, 0) / ps.length;
  const fairOf = p => p.fair ?? avg; // games saved before fair share existed
  const max = Math.max(1, ...ps.map(p => Math.max(p.played, fairOf(p))));
  const worst = Math.max(0, ...ps.map(p => Math.abs(p.played - fairOf(p))));
  const hasUrl = !!store.settings.sheetUrl;
  return `
  ${topbar('Final', 'home')}
  <section class="stack pad">
    <div class="sum-h">
      <h2>${h.opponent ? 'vs ' + esc(h.opponent) : 'Game'}</h2>
      <span>${new Date(h.date).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</span>
    </div>
    <div class="kpis">
      <div class="kpi"><b>${fmt(avg)}</b><span>Avg minutes</span></div>
      <div class="kpi ${worst <= 90 ? 'good' : worst <= 180 ? 'meh' : 'bad'}"><b>${fmt(worst)}</b><span>Biggest gap from fair</span></div>
      <div class="kpi"><b>${ps.length}</b><span>Players</span></div>
    </div>
    <div class="card">
      <div class="card-h"><h2>Minutes played</h2><span class="legend"><i class="avg-key"></i>fair share</span></div>
      <ul class="bars">${ps.map(p => `
        <li><span class="b-name">${esc(p.name)}${p.gkSec >= 30 ? ` <i class="gk-tag">GK ${Math.round(p.gkSec / 60)}m</i>` : ''}</span>
          <span class="b-track" style="--avg:${(fairOf(p) / max * 100).toFixed(2)}%" title="Fair share ${fmt(fairOf(p))}"><i style="width:${(p.played / max * 100).toFixed(2)}%"></i></span>
          <span class="b-val">${fmt(p.played)}</span></li>`).join('')}</ul>
    </div>
    <div class="card sync ${h.synced ? 'ok' : ''}">
      ${h.synced ? `<p><b>Saved to Google Sheet.</b></p>`
        : hasUrl ? `<p><b>Not synced yet.</b> It'll send automatically when you're back online.</p><button class="btn" data-act="sync">Sync now</button>`
        : `<p><b>Saved on this phone.</b> Connect a Google Sheet to keep a season log.</p><button class="btn" data-act="go" data-to="settings">Set up sync</button>`}
    </div>
    ${view.confirm === 'del-game' ? `<button class="ghost danger" data-act="del-game" data-id="${h.id}">Tap again to delete this game</button>`
      : `<button class="ghost" data-act="del-game" data-id="${h.id}">Delete this game</button>`}
  </section>`;
}

/* ---------- settings ---------- */

function renderSettings() {
  const url = store.settings.sheetUrl;
  return `
  ${topbar('Settings', 'home')}
  <section class="stack pad">
    <div class="card">
      <div class="card-h"><h2>Google Sheet sync</h2>${url ? '<span class="pill ok">Connected</span>' : ''}</div>
      <p class="hint">Paste the Web App URL from the Apps Script in <code>apps-script/Code.gs</code> (see README). Finished games are sent when you're online. Each game is sent once.</p>
      <label class="field"><span>Web App URL</span><input id="sheet-url" value="${esc(url)}" placeholder="https://script.google.com/macros/s/…/exec" inputmode="url" autocapitalize="off" spellcheck="false"></label>
      <div class="row-btns"><button class="btn" data-act="save-url">Save</button>${url ? '<button class="btn alt" data-act="sync">Sync now</button>' : ''}</div>
    </div>
    <div class="card">
      <div class="card-h"><h2>How subs are planned</h2></div>
      <p class="hint">The app aims for shifts of about ${fmt(TARGET_RUN)}, keeps bench time under about ${fmt(MAX_REST)} when the roster allows, and won't ask you to sub more often than every ${fmt(MIN_GAP)}. Sub windows divide each quarter evenly. Quarter breaks are always a sub point. Goalies stay in for the full quarter, and goalie time counts as playing time.</p>
    </div>
  </section>`;
}

function topbar(title, back, right = '') {
  return `<header class="topbar"><button class="icon-btn" data-act="go" data-to="${back}" aria-label="Back">${I.back}</button><h1>${title}</h1><span class="tb-r">${right}</span></header>`;
}

/* ---------- bottom sheets ---------- */

function renderSheet() {
  const s = view.sheet;
  if (!s) { $sheet.innerHTML = ''; document.body.classList.remove('sheet-open'); return; }
  document.body.classList.add('sheet-open');
  const g = G(), t = g ? now(g) : 0;
  let body = '';
  if (s.type === 'player') {
    const p = g.players[s.id];
    const d = gap(g, p, t);
    body = `
      <h2>${p.gk ? '<i class="gk-tag">GK</i>' : ''}${esc(p.name)}</h2>
      <div class="sheet-stats">
        <div><b>${fmt(played(p, t))}</b><span>played</span></div>
        <div><b>${p.state === 'out' ? '—' : fmt(stint(p, t))}</b><span>${p.state === 'field' ? 'this shift' : p.state === 'bench' ? 'on bench' : esc(p.reason || 'out')}</span></div>
        <div><b>${fmtDelta(d)}</b><span>vs fair share</span></div>
      </div>`;
    if (p.state === 'field') {
      const cands = onBench(g).sort((a, b) => gap(g, a, t) - gap(g, b, t));
      body += cands.length ? `<h3>Take off, bring on…</h3><div class="pick">${cands.map((c, i) => `
        <button class="pick-btn ${i === 0 ? 'top' : ''}" data-act="swap" data-off="${p.id}" data-on="${c.id}">${esc(c.name)}<small>${fmt(played(c, t))}</small></button>`).join('')}</div>` : '';
      if (!p.gk) body += `<button class="btn alt wide" data-act="make-gk" data-id="${p.id}">${I.glove} Put in goal</button>`;
    } else if (p.state === 'bench') {
      const cands = onField(g).sort((a, b) => a.gk - b.gk || gap(g, b, t) - gap(g, a, t));
      body += `<h3>Bring on, take off…</h3><div class="pick">${cands.map((c, i) => `
        <button class="pick-btn ${i === 0 ? 'top' : ''}" data-act="swap" data-off="${c.id}" data-on="${p.id}">${c.gk ? 'GK · ' : ''}${esc(c.name)}<small>${fmt(played(c, t))}</small></button>`).join('')}</div>`;
    }
    if (p.state === 'out') body += `<button class="btn wide" data-act="return" data-id="${p.id}">Back on the bench</button>`;
    else body += `<h3>Sideline for a bit</h3><div class="reasons">${SIDELINE_REASONS.map(r => `<button class="reason" data-act="sideline" data-id="${p.id}" data-reason="${r}">${r}</button>`).join('')}</div>`;
  }
  else if (s.type === 'replace') {
    const p = g.players[s.id];
    const cands = onBench(g).sort((a, b) => gap(g, a, t) - gap(g, b, t));
    body = `<h2>Who replaces ${esc(p.name)}?</h2><p class="hint">${esc(s.reason)}${p.gk ? ' · they were in goal, so the replacement takes the gloves.' : ''}</p>
      <div class="pick">${cands.map((c, i) => `<button class="pick-btn ${i === 0 ? 'top' : ''}" data-act="sideline-confirm" data-rep="${c.id}">${esc(c.name)}<small>${fmt(played(c, t))}</small></button>`).join('')}</div>
      ${p.gk ? '' : `<button class="btn alt wide" data-act="sideline-confirm" data-rep="">Nobody. Play a player short.</button>`}`;
  }
  else if (s.type === 'menu') {
    const inLive = g.phase === 'live';
    body = `<h2>Game</h2><div class="menu">
      <button data-act="sheet" data-type="late">Add a late arrival</button>
      ${inLive && !g.qOver ? `<button data-act="end-quarter">End Q${g.quarter} now</button>` : ''}
      <button data-act="finish">Finish game & save</button>
      <button class="danger" data-act="discard">${view.confirm === 'discard' ? 'Tap again to discard without saving' : 'Discard game'}</button>
    </div>`;
  }
  else if (s.type === 'late') {
    const missing = store.roster.filter(r => !g.players[r.id]);
    body = `<h2>Late arrival</h2>
      ${missing.length ? `<div class="pick">${missing.map(r => `<button class="pick-btn" data-act="add-late" data-id="${r.id}">${esc(r.name)}</button>`).join('')}</div>` : '<p class="hint">Everyone on the roster is already here.</p>'}
      <form class="add" data-form="add-late"><input name="name" placeholder="Someone new?" autocapitalize="words"><button class="btn">Add</button></form>`;
  }
  $sheet.innerHTML = `<div class="scrim" data-act="close-sheet"></div>
    <div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>${body}
    <button class="ghost" data-act="close-sheet">Close</button></div>`;
}

/* ============================================================
   Events
   ============================================================ */

const actions = {
  go: d => go(d.to),
  resume: () => go(G().phase === 'lineup' ? 'lineup' : 'live'),
  'new-game': () => go('setup'),
  'view-game': d => { view.summaryId = d.id; go('summary'); },
  'del-player': d => { store.roster = store.roster.filter(r => r.id !== d.id); save(); render(); },
  'bulk-add': () => {
    const names = document.getElementById('bulk').value.split(/\n|,/).map(s => s.trim()).filter(Boolean);
    names.forEach(name => { if (!store.roster.some(r => r.name.toLowerCase() === name.toLowerCase())) store.roster.push({ id: uid(), name }); });
    save(); render();
  },
  'demo-team': () => { store.roster = DEMO_TEAM.map(name => ({ id: uid(), name })); save(); render(); },
  'toggle-present': d => { const s = view.setup.present; s.has(d.id) ? s.delete(d.id) : s.add(d.id); render(); },
  'present-all': () => { view.setup.present = new Set(store.roster.map(r => r.id)); render(); },
  'present-none': () => { view.setup.present = new Set(); render(); },
  step: d => {
    const s = view.setup, lim = { onField: [3, 11], quarterMin: [4, 30] }[d.k];
    s[d.k] = Math.min(lim[1], Math.max(lim[0], s[d.k] + +d.d)); render();
  },
  'create-game': createGame,
  'lu-toggle': d => {
    const dr = view.draft;
    if (dr.gk === d.id) dr.gk = null;
    else if (dr.field.has(d.id)) dr.field.delete(d.id);
    else dr.field.add(d.id);
    render();
  },
  'lu-gk': d => {
    const dr = view.draft;
    if (dr.gk === d.id) { dr.gk = null; render(); return; }
    // Promote to goalie; if they were on the field, the old goalie takes their field spot.
    const wasOn = dr.field.delete(d.id);
    if (dr.gk && wasOn) dr.field.add(dr.gk);
    dr.gk = d.id; render();
  },
  'start-quarter': startQuarter,
  clock: toggleClock,
  undo,
  awake: () => keepAwake(true).then(() => G() && view.screen === 'live' && updateLive(G(), now())),
  menu: () => { view.sheet = { type: 'menu' }; view.confirm = null; renderSheet(); },
  sheet: d => { view.sheet = { type: d.type }; renderSheet(); },
  'close-sheet': () => { view.sheet = null; view.confirm = null; renderSheet(); },
  player: d => { view.sheet = { type: 'player', id: d.id }; renderSheet(); },
  swap: d => { const g = G(); doSubs([[g.players[d.off], g.players[d.on]]]); },
  'do-subs': () => { const g = G(); doSubs(suggest(g, now(g), g.plan.k).filter(([o]) => !view.keep.has(o.id)), true); },
  'toggle-pair': d => { view.keep.has(d.id) ? view.keep.delete(d.id) : view.keep.add(d.id); render(); },
  skip: skipWindow,
  'make-gk': d => makeGoalie(d.id),
  sideline: d => {
    const g = G(), p = g.players[d.id];
    // With nobody on the bench, a sidelined goalie leaves the net empty; tap a field player → "Put in goal".
    if (p.state === 'field' && g.phase === 'live' && onBench(g).length) { view.sheet = { type: 'replace', id: d.id, reason: d.reason }; renderSheet(); }
    else sideline(d.id, d.reason, null);
  },
  'sideline-confirm': d => sideline(view.sheet.id, view.sheet.reason, d.rep || null),
  return: d => {
    returnPlayer(d.id);
    if (view.screen === 'lineup') { view.draft = suggestLineup(G()); render(); }
  },
  'add-late': d => addLate(d.id),
  'end-quarter': endQuarterNow,
  'next-quarter': nextQuarter,
  finish: finishGame,
  discard: () => { if (view.confirm === 'discard') discardGame(); else { view.confirm = 'discard'; renderSheet(); } },
  'save-url': () => {
    store.settings.sheetUrl = document.getElementById('sheet-url').value.trim();
    save(); render(); syncAll();
  },
  sync: () => { store.history.forEach(h => { if (h.id === view.summaryId) h.synced = false; }); syncAll(); },
  'del-game': d => {
    if (view.confirm !== 'del-game') { view.confirm = 'del-game'; render(); return; }
    store.history = store.history.filter(h => h.id !== d.id); save(); go('home');
  },
};

document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el.dataset, el); }
});

document.addEventListener('submit', e => {
  e.preventDefault();
  const form = e.target, name = form.elements.name.value.trim();
  if (!name) return;
  if (form.dataset.form === 'add-player') {
    if (!store.roster.some(r => r.name.toLowerCase() === name.toLowerCase())) store.roster.push({ id: uid(), name });
    save(); render();
    document.getElementById('add-name')?.focus();
  } else if (form.dataset.form === 'add-late') addLate(null, name);
});

document.addEventListener('change', e => {
  const id = e.target.dataset.rename;
  if (id) {
    const r = store.roster.find(x => x.id === id), v = e.target.value.trim();
    if (r && v) { r.name = v; save(); }
  }
});
document.addEventListener('input', e => {
  if (e.target.id === 'opponent' && view.setup) view.setup.opponent = e.target.value;
});

/* ---------- boot ---------- */

if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js');
if (G()) {
  view.screen = G().phase === 'lineup' ? 'lineup' : 'live';
  if (G().phase === 'lineup') view.draft = suggestLineup(G());
  else keepAwake(true);
}
render();
syncAll();
