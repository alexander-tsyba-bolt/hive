'use strict';

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execSync, execFile, execFileSync } = require('child_process');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const JOBS_DIR = path.join(CLAUDE_DIR, 'jobs');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions'); // live process registry the CLI maintains
const TEAMS_DIR = path.join(CLAUDE_DIR, 'teams');       // agent-teams config (experimental)
const META_FILE = path.join(CLAUDE_DIR, 'web-sessions-meta.json');
const CODEX_DIR = path.join(HOME, '.codex');
const CODEX_SESSIONS_DIR = path.join(CODEX_DIR, 'sessions'); // rollout-*.jsonl under YYYY/MM/DD

let claudeBin = 'claude';
try { claudeBin = execSync('which claude', { encoding: 'utf8' }).trim(); } catch {}

let codexBin = 'codex';
let codexAvailable = false;
try { codexBin = execSync('which codex', { encoding: 'utf8' }).trim(); codexAvailable = true; } catch {}

// ── Security guard ────────────────────────────────────────────────────────
// Two independent controls, because this process can spawn an interactive Claude
// PTY with the user's full credentials:
//
//   1. Host allowlist. A website the user visits can reach 127.0.0.1 via DNS
//      rebinding, but the browser sends the attacker's hostname in Host, which
//      fails this check. Only loopback and this machine's NetBird address pass.
//   2. Bearer token, required on every non-loopback request. NetBird is the Bolt
//      corporate mesh, not a trusted network — other employees' machines are peers
//      on it — so reaching the port must not be sufficient to use it.
//
// Loopback stays token-free: anything running as this user locally can already
// spawn `claude` directly, so a token there guards nothing and only adds friction.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

// NetBird hands out addresses in the 100.64.0.0/10 CGNAT range on a utun device.
// Resolve at startup rather than hardcoding: the mesh address can change.
function netbirdAddress() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const [o1, o2] = a.address.split('.').map(Number);
      if (o1 === 100 && o2 >= 64 && o2 <= 127) return a.address;
    }
  }
  return null;
}
const NETBIRD_IP = netbirdAddress();
const NETBIRD_FQDN = (process.env.HIVE_NETBIRD_FQDN || '').trim().toLowerCase() || null;

function hostnameOf(value) {
  if (!value) return null;
  const m = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(String(value).trim());
  return m ? m[1].toLowerCase() : null;
}
function isLoopback(value) {
  const h = hostnameOf(value);
  return h !== null && LOOPBACK_HOSTS.has(h);
}
function isAllowedHost(value) {
  const h = hostnameOf(value);
  if (h === null) return false;
  if (LOOPBACK_HOSTS.has(h)) return true;
  if (NETBIRD_IP && h === NETBIRD_IP) return true;
  if (NETBIRD_FQDN && h === NETBIRD_FQDN) return true;
  return false;
}

// ── Token ─────────────────────────────────────────────────────────────────
// Kept outside the repo so it can never be committed. Generated on first run.
const TOKEN_FILE = path.join(HOME, '.config', 'hive', 'token');
function loadToken() {
  if (process.env.HIVE_TOKEN) return process.env.HIVE_TOKEN.trim();
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (t) return t;
  } catch {}
  const t = crypto.randomBytes(32).toString('base64url');
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(TOKEN_FILE, t + '\n', { mode: 0o600 });
  return t;
}
const TOKEN = loadToken();
const COOKIE_NAME = 'hive_token';

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  // timingSafeEqual throws on length mismatch, so compare a fixed-size digest.
  return crypto.timingSafeEqual(
    crypto.createHash('sha256').update(ba).digest(),
    crypto.createHash('sha256').update(bb).digest(),
  );
}
function cookieToken(cookieHeader) {
  if (!cookieHeader) return null;
  for (const part of String(cookieHeader).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === COOKIE_NAME) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
    }
  }
  return null;
}
// Accepts the token from a cookie (browser, after first visit), an Authorization
// header (curl), or a ?token= query param (the first visit / the link you open
// on your phone). Returns 'query' when it came from the URL so the caller can
// set the cookie and redirect the token out of the address bar and history.
function tokenSource(req, url) {
  const auth = req.headers.authorization;
  if (auth && /^Bearer\s+/i.test(auth) && safeEqual(auth.replace(/^Bearer\s+/i, '').trim(), TOKEN)) return 'header';
  const c = cookieToken(req.headers.cookie);
  if (c && safeEqual(c, TOKEN)) return 'cookie';
  const q = url && url.searchParams.get('token');
  if (q && safeEqual(q, TOKEN)) return 'query';
  return null;
}

app.use((req, res, next) => {
  if (!isAllowedHost(req.headers.host)) return res.status(403).end('Forbidden');
  if (isLoopback(req.headers.host)) return next();

  const url = new URL(req.originalUrl || req.url, 'http://placeholder');
  const src = tokenSource(req, url);
  if (!src) return res.status(401).end('Unauthorized');

  if (src === 'query') {
    // Persist it, then strip it from the URL so the token doesn't linger in
    // browser history, bookmarks or the Referer header.
    res.setHeader('Set-Cookie',
      `${COOKIE_NAME}=${encodeURIComponent(TOKEN)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
    url.searchParams.delete('token');
    return res.redirect(302, url.pathname + (url.search || ''));
  }
  next();
});

app.use(express.json());
// Prevent browser from caching stale JS/HTML
app.use((req, res, next) => {
  if (req.path.endsWith('.html') || req.path === '/') {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

const terminals = new Map();

function loadMeta() {
  try { return JSON.parse(fs.readFileSync(META_FILE, 'utf8')); } catch { return {}; }
}
function saveMeta(meta) {
  try { fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2)); } catch {}
}

function loadSettings() {
  const meta = loadMeta();
  return meta._settings || {};
}
function saveSettings(settings) {
  const meta = loadMeta();
  meta._settings = { ...(meta._settings || {}), ...settings };
  saveMeta(meta);
}

function deriveJobState(s) {
  const runningStates = new Set(['working', 'running', 'thinking', 'calling', 'streaming']);
  // waiting = agent paused waiting for user input (--brief mode, SendUserMessage tool)
  const waitingStates = new Set(['waiting', 'paused', 'needs_input', 'waiting_input', 'pending_input']);
  if (s.tempo === 'active' || (s.inFlight?.tasks ?? 0) > 0 || runningStates.has(s.state)) return 'running';
  if (waitingStates.has(s.state)) return 'waiting';
  if (s.state === 'failed') return 'failed';
  if (s.state === 'done' || s.state === 'stopped') return 'done';
  return 'idle';
}

function extractFlag(flags, name) {
  if (!Array.isArray(flags)) return null;
  const i = flags.indexOf(name);
  return i !== -1 && i + 1 < flags.length ? flags[i + 1] : null;
}

function normalizeModel(m) {
  if (!m) return null;
  // Filter out synthetic/internal model identifiers
  if (m === '<synthetic>' || m.startsWith('<') || m === 'synthetic') return null;
  m = m.replace(/\[1m\]?$/i, '');
  if (m === 'sonnet') return 'claude-sonnet-5';
  if (m === 'opus') return 'claude-opus-5';
  if (m === 'haiku') return 'claude-haiku-4-5';
  return m;
}

function parseSessionMeta(jsonlPath) {
  const out = { name: null, model: null, cwd: null, kind: null };
  if (!jsonlPath || !fs.existsSync(jsonlPath)) return out;
  try {
    const size = fs.statSync(jsonlPath).size;
    if (size === 0) return out;
    const fd = fs.openSync(jsonlPath, 'r');
    const headLen = Math.min(16384, size);
    const head = Buffer.alloc(headLen);
    fs.readSync(fd, head, 0, headLen, 0);
    // Scan a generous tail: the model only appears on `assistant` lines, which
    // can be pushed far back by large tool outputs/attachments. 8KB was too small.
    const tailLen = Math.min(262144, size);
    const tail = Buffer.alloc(tailLen);
    fs.readSync(fd, tail, 0, tailLen, Math.max(0, size - tailLen));
    fs.closeSync(fd);

    const headStr = head.toString('utf8');
    for (const line of headStr.split('\n')) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        if (!out.name) {
          if (d.type === 'custom-title' && d.customTitle) out.name = d.customTitle;
          else if (d.type === 'ai-title' && d.aiTitle) out.name = d.aiTitle;
          else if (d.type === 'agent-name' && d.agentName) out.name = d.agentName;
        }
        if (!out.cwd && d.cwd) out.cwd = d.cwd;
        if (!out.kind && d.sessionKind) out.kind = d.sessionKind; // 'bg' | 'interactive'
      } catch {}
    }
    // Last assistant model in the tail (scan newest-first).
    const tailLines = tail.toString('utf8').split('\n');
    for (let i = tailLines.length - 1; i >= 0; i--) {
      if (!tailLines[i].trim()) continue;
      try {
        const d = JSON.parse(tailLines[i]);
        if (!out.kind && d.sessionKind) out.kind = d.sessionKind;
        if (!out.model && d.type === 'assistant' && d.message?.model) {
          const m = normalizeModel(d.message.model);
          if (m) out.model = m;
        }
        if (out.model && out.kind) break;
      } catch {}
    }
    // Naming is fully owned by Hive (customName in web-sessions-meta.json).
    // out.name from the head scan is used only as a read-only fallback for
    // sessions the user has not yet renamed in Hive — we never overwrite it
    // from the tail or write back to the JSONL for display purposes.
    // Head fallback: short sessions whose only assistant turn is near the top.
    if (!out.model) {
      for (const line of headStr.split('\n')) {
        if (!line.trim()) continue;
        try {
          const d = JSON.parse(line);
          if (d.type === 'assistant' && d.message?.model) {
            const m = normalizeModel(d.message.model);
            if (m) { out.model = m; break; }
          }
        } catch {}
      }
    }
  } catch {}
  return out;
}

// Re-parsing every jsonl on each 5s poll is wasteful; cache by mtime + size.
const metaCache = new Map(); // jsonlPath -> { mtimeMs, size, meta }
function parseSessionMetaCached(jsonlPath) {
  try {
    const st = fs.statSync(jsonlPath);
    const c = metaCache.get(jsonlPath);
    if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.meta;
    const meta = parseSessionMeta(jsonlPath);
    metaCache.set(jsonlPath, { mtimeMs: st.mtimeMs, size: st.size, meta });
    return meta;
  } catch {
    return parseSessionMeta(jsonlPath);
  }
}


// ── Live process registry ─────────────────────────────────────────────────
// ~/.claude/sessions/*.json is written by every running CLI process. Multiple
// stale PID files can point at one sessionId, so merge: a session counts as a
// background agent if ANY entry says kind:'bg', and as busy if ANY says busy.
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function loadLiveRegistry() {
  const out = new Map(); // sessionId -> { kind, status, updatedAt, bgLive, busyLive }
  if (!fs.existsSync(SESSIONS_DIR)) return out;
  for (const f of fs.readdirSync(SESSIONS_DIR)) {
    if (!f.endsWith('.json')) continue;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
      const sid = d.sessionId;
      if (!sid) continue;
      // Liveness matters: a session is only un-resumable / busy if its PID is alive.
      // Stale registry files (dead PIDs) must not force the attach/fork modal.
      const alive = pidAlive(d.pid);
      const entry = {
        kind: d.kind || null,
        status: d.status || null,
        updatedAt: d.updatedAt || 0,
        bgLive: alive && d.kind === 'bg',
        // The CLI writes more than one active-work status here — 'busy' while
        // generating, but also e.g. 'shell' while a Bash-backed tool call is
        // running (confirmed by watching this file live). 'idle' (or no status
        // at all) is the only genuine at-rest value, so treat anything else as
        // busy instead of allowlisting a single string and missing the rest.
        busyLive: alive && !!d.status && d.status !== 'idle',
      };
      const prev = out.get(sid);
      if (!prev) { out.set(sid, entry); continue; }
      out.set(sid, {
        kind: (prev.kind === 'bg' || entry.kind === 'bg') ? 'bg' : (entry.kind || prev.kind),
        status: (prev.status === 'busy' || entry.status === 'busy') ? 'busy'
              : (entry.updatedAt >= prev.updatedAt ? entry.status : prev.status) || prev.status,
        updatedAt: Math.max(prev.updatedAt, entry.updatedAt),
        bgLive: prev.bgLive || entry.bgLive,
        busyLive: prev.busyLive || entry.busyLive,
      });
    } catch {}
  }
  return out;
}

// ── Agent teams (experimental) ──────────────────────────────────────────────
// Team config lives at ~/.claude/teams/{team-name}/config.json where team-name
// is `session-<first 8 chars of the lead session id>`. The config holds a
// `members` array. Schema is unstable, so read defensively.
function loadTeams() {
  const out = []; // [{ teamName, leadPrefix, members:[{name,agentId,agentType,sessionId,status}] }]
  if (!fs.existsSync(TEAMS_DIR)) return out;
  for (const teamName of fs.readdirSync(TEAMS_DIR)) {
    const cfgPath = path.join(TEAMS_DIR, teamName, 'config.json');
    if (!fs.existsSync(cfgPath)) continue;
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const leadPrefix = teamName.startsWith('session-') ? teamName.slice('session-'.length) : null;
      const rawMembers = Array.isArray(cfg.members) ? cfg.members
        : Array.isArray(cfg.teammates) ? cfg.teammates : [];
      const members = rawMembers.map(m => ({
        name: m.name || m.teammateName || null,
        agentId: m.agentId || m.id || null,
        agentType: m.agentType || m.type || m.subagentType || null,
        sessionId: m.sessionId || m.session_id || null,
        status: m.status || m.state || null,
      }));
      out.push({ teamName, leadPrefix, members, leadSessionId: cfg.leadSessionId || cfg.sessionId || null });
    } catch {}
  }
  return out;
}

function shortenPath(p) {
  if (!p) return '';
  if (p.startsWith(HOME)) p = '~' + p.slice(HOME.length);
  const parts = p.split('/').filter(Boolean);
  if (parts.length <= 3) return p;
  const prefix = p.startsWith('~') ? '~' : '';
  return `${prefix}/.../` + parts.slice(-2).join('/');
}

// Find the JSONL file for a given session id. Checks PROJECTS_DIR first
// (history sessions), then JOBS_DIR linkScanPath (job sessions).
function findJsonlPath(sessionId) {
  if (fs.existsSync(PROJECTS_DIR)) {
    for (const projName of fs.readdirSync(PROJECTS_DIR)) {
      const p = path.join(PROJECTS_DIR, projName, `${sessionId}.jsonl`);
      if (fs.existsSync(p)) return p;
    }
  }
  if (fs.existsSync(JOBS_DIR)) {
    for (const jobId of fs.readdirSync(JOBS_DIR)) {
      try {
        const sf = path.join(JOBS_DIR, jobId, 'state.json');
        if (!fs.existsSync(sf)) continue;
        const s = JSON.parse(fs.readFileSync(sf, 'utf8'));
        if (s.sessionId === sessionId && s.linkScanPath && s.linkScanPath.endsWith('.jsonl')) {
          if (fs.existsSync(s.linkScanPath)) return s.linkScanPath;
        }
      } catch {}
    }
  }
  return null;
}

// ── Codex sessions ───────────────────────────────────────────────────────────
// No live registry file like Claude's ~/.claude/sessions/*.json, and a different
// transcript format (~/.codex/sessions/YYYY/MM/DD/rollout-<id>.jsonl). Reuses the
// same web-sessions-meta.json store for rename/group/archive/delete — engine-
// agnostic already, keyed only by session id.

function listCodexRolloutFiles() {
  const out = [];
  if (!fs.existsSync(CODEX_SESSIONS_DIR)) return out;
  try {
    for (const y of fs.readdirSync(CODEX_SESSIONS_DIR)) {
      const yp = path.join(CODEX_SESSIONS_DIR, y);
      if (!fs.statSync(yp).isDirectory()) continue;
      for (const m of fs.readdirSync(yp)) {
        const mp = path.join(yp, m);
        if (!fs.statSync(mp).isDirectory()) continue;
        for (const d of fs.readdirSync(mp)) {
          const dp = path.join(mp, d);
          if (!fs.statSync(dp).isDirectory()) continue;
          for (const f of fs.readdirSync(dp)) {
            if (f.startsWith('rollout-') && f.endsWith('.jsonl')) out.push(path.join(dp, f));
          }
        }
      }
    }
  } catch {}
  return out;
}

// `session_meta` is always line 0, but on some launch surfaces it embeds the
// entire system prompt inline (observed: tens of KB), so the head buffer has to
// be much larger than Claude's equivalent (parseSessionMeta's 16KB would clip it).
function parseCodexSessionMeta(jsonlPath, size) {
  try {
    const headLen = Math.min(131072, size);
    const fd = fs.openSync(jsonlPath, 'r');
    const head = Buffer.alloc(headLen);
    fs.readSync(fd, head, 0, headLen, 0);
    fs.closeSync(fd);
    const nl = head.indexOf(10); // '\n'
    const line = (nl === -1 ? head : head.subarray(0, nl)).toString('utf8');
    const d = JSON.parse(line);
    return d.payload || {};
  } catch {
    return {};
  }
}

const codexMetaCache = new Map(); // jsonlPath -> { mtimeMs, size, meta }
function parseCodexSessionMetaCached(jsonlPath, stat) {
  const c = codexMetaCache.get(jsonlPath);
  if (c && c.mtimeMs === stat.mtimeMs && c.size === stat.size) return c.meta;
  const meta = parseCodexSessionMeta(jsonlPath, stat.size);
  codexMetaCache.set(jsonlPath, { mtimeMs: stat.mtimeMs, size: stat.size, meta });
  return meta;
}

function scanCodexSessions() {
  const out = [];
  for (const fp of listCodexRolloutFiles()) {
    try {
      const stat = fs.statSync(fp);
      if (stat.size === 0) continue;
      const meta = parseCodexSessionMetaCached(fp, stat);
      const sid = meta.session_id;
      if (!sid) continue;
      out.push({ id: sid, cwd: meta.cwd || HOME, lastActivity: stat.mtime.toISOString(), path: fp });
    } catch {}
  }
  return out;
}

// Best-effort liveness: no registry file to read, so find real `codex` processes
// and resolve each one's cwd. Approximate by design — a false positive/negative
// here just mis-colors a badge, it never blocks or corrupts anything.
function findLiveCodexCwds() {
  const cwds = new Set();
  if (!codexAvailable) return cwds;
  let psOut;
  try { psOut = execSync('ps -axo pid,comm', { encoding: 'utf8' }); } catch { return cwds; }
  const pids = [];
  for (const line of psOut.split('\n').slice(1)) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (m && path.basename(m[2].trim()) === 'codex') pids.push(m[1]);
  }
  for (const pid of pids) {
    try {
      const lsofOut = execFileSync('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
      const nLine = lsofOut.split('\n').find(l => l.startsWith('n'));
      if (nLine) cwds.add(nLine.slice(1));
    } catch {}
  }
  return cwds;
}

// ── Routes ──────────────────────────────────────────────────────────────────

app.get('/api/info', (_req, res) => {
  const settings = loadSettings();
  res.json({ home: HOME, claudeBin, codexBin, codexAvailable, defaultCwd: settings.defaultCwd || HOME });
});

app.get('/api/settings', (_req, res) => {
  res.json(loadSettings());
});

app.patch('/api/settings', (req, res) => {
  const { defaultCwd } = req.body;
  const update = {};
  if (defaultCwd !== undefined) update.defaultCwd = defaultCwd || HOME;
  saveSettings(update);
  res.json({ ok: true });
});

app.get('/api/sessions', (req, res) => {
  const meta = loadMeta();
  const registry = loadLiveRegistry();
  const sessions = new Map();

  if (fs.existsSync(JOBS_DIR)) {
    for (const jobId of fs.readdirSync(JOBS_DIR)) {
      if (jobId === 'pins.json') continue;
      const jobDir = path.join(JOBS_DIR, jobId);
      try {
        if (!fs.statSync(jobDir).isDirectory()) continue;
        const stateFile = path.join(jobDir, 'state.json');
        if (!fs.existsSync(stateFile)) continue;
        const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        const { sessionId, name, intent, cwd, createdAt, updatedAt, linkScanPath, respawnFlags } = s;
        if (!sessionId) continue;

        // A job's own sessionId can differ from the transcript it runs: a bg job
        // that resumed an existing session points linkScanPath/resumeSessionId at
        // the original. Key the card by the TRANSCRIPT id (the jsonl filename) so
        // it matches the jsonl and the projects scan doesn't emit a duplicate,
        // un-flagged "history" card for the same session — that duplicate was the
        // real cause of the bg-resume error (it got --resume'd directly).
        let id = sessionId;
        if (linkScanPath && linkScanPath.endsWith('.jsonl')) {
          id = path.basename(linkScanPath, '.jsonl') || sessionId;
        }

        const sm = meta[id] || {};
        if (sm.deleted) continue;
        const jm = parseSessionMetaCached(linkScanPath);
        const live = registry.get(id) || registry.get(sessionId);
        const modelFromFlags = normalizeModel(extractFlag(respawnFlags, '--model'));
        const fullCwd = cwd || jm.cwd || HOME;

        sessions.set(id, {
          id,
          shortId: jobId,
          name: jm.name || name || intent || `Job ${jobId.slice(0, 8)}`,
          customName: sm.customName || null,
          group: sm.group || null,
          state: deriveJobState(s),
          model: jm.model || modelFromFlags || sm.model || null,
          effort: extractFlag(respawnFlags, '--effort') || sm.effort || null,
          lastActivity: updatedAt || createdAt || null,
          cwd: fullCwd,
          cwdShort: shortenPath(fullCwd),
          source: 'job',
          engine: 'claude',
          // `bg` (badge): was this ever a background agent? `bgLive`: is it a
          // background agent whose process is alive right now? Only `bgLive`
          // sessions truly can't be plain --resume'd, so only those force the modal.
          bg: s.template === 'bg' || jm.kind === 'bg' || live?.kind === 'bg' || false,
          bgLive: live?.bgLive || false,
          archived: sm.archived || false,
        });
      } catch {}
    }
  }

  if (fs.existsSync(PROJECTS_DIR)) {
    for (const projName of fs.readdirSync(PROJECTS_DIR)) {
      const projPath = path.join(PROJECTS_DIR, projName);
      try {
        if (!fs.statSync(projPath).isDirectory()) continue;
        for (const file of fs.readdirSync(projPath)) {
          if (!file.endsWith('.jsonl')) continue;
          const sid = file.replace('.jsonl', '');
          const existing = sessions.get(sid);
          if (existing && existing.source !== 'history') continue; // job entries always win
          const sm = meta[sid] || {};
          if (sm.deleted) continue;
          const jsonlPath = path.join(projPath, file);
          const stat = fs.statSync(jsonlPath);
          const jm = parseSessionMetaCached(jsonlPath);
          const live = registry.get(sid);
          const fullCwd = jm.cwd || HOME;
          if (existing) {
            // Same session split across two project dirs — typically a renamed
            // mount (e.g. GDrive locale flip) left a stale encoded folder behind
            // whose cwd no longer resolves. Prefer the copy whose cwd still
            // exists on disk, then whichever was modified more recently, so a
            // resume never gets silently routed through a dead path into HOME.
            const existingCwdOk = fs.existsSync(existing.cwd);
            const candidateCwdOk = fs.existsSync(fullCwd);
            const candidateIsBetter = candidateCwdOk !== existingCwdOk
              ? candidateCwdOk
              : stat.mtime > new Date(existing.lastActivity || 0);
            if (!candidateIsBetter) continue;
          }
          sessions.set(sid, {
            id: sid,
            shortId: sid.slice(0, 8),
            name: jm.name || `Session ${sid.slice(0, 8)}`,
            customName: sm.customName || null,
            group: sm.group || null,
            // History sessions are idle unless a LIVE process for this id is busy.
            state: live?.busyLive ? 'running' : 'idle',
            model: jm.model || sm.model || null,
            effort: sm.effort || null,
            lastActivity: stat.mtime.toISOString(),
            cwd: fullCwd,
            cwdShort: shortenPath(fullCwd),
            source: 'history',
            engine: 'claude',
            bg: jm.kind === 'bg' || live?.kind === 'bg' || false,
            bgLive: live?.bgLive || false,
            archived: sm.archived || false,
          });
        }
      } catch {}
    }
  }

  // Codex sessions: launch-only support originally (see README "Engines"), now
  // also listed here so a closed/finished one is still discoverable and re-openable
  // via `codex resume`, same as Claude's history entries.
  for (const cs of scanCodexSessions()) {
    if (sessions.has(cs.id)) continue; // independent UUID spaces, but don't clobber
    const sm = meta[cs.id] || {};
    if (sm.deleted) continue;
    sessions.set(cs.id, {
      id: cs.id,
      shortId: cs.id.slice(0, 8),
      name: sm.customName || path.basename(cs.cwd) || `Codex ${cs.id.slice(0, 8)}`,
      customName: sm.customName || null,
      group: sm.group || null,
      state: 'idle', // upgraded to 'running' below if a live codex process matches
      // Codex rollout files don't record model/effort anywhere as reliable as
      // Claude's assistant-message field, so this only ever has a value for
      // sessions launched through Hive (the same launchModel/launchEffort PATCH
      // used for Claude's own id-less edge case links it in, see
      // linkAndUpdateTerminalTitles in index.html) — null otherwise, not guessed.
      model: sm.model || null,
      effort: sm.effort || null,
      lastActivity: cs.lastActivity,
      cwd: cs.cwd,
      cwdShort: shortenPath(cs.cwd),
      source: 'codex',
      engine: 'codex',
      bg: false,
      bgLive: false,
      archived: sm.archived || false,
    });
  }

  // Best-effort liveness for Codex (no registry file to read): only upgrade the
  // MOST RECENT session per matched cwd, so several old sessions sharing a folder
  // don't all light up "running" just because one of them currently is.
  const liveCodexCwds = findLiveCodexCwds();
  if (liveCodexCwds.size) {
    const newestByCwd = new Map();
    for (const s of sessions.values()) {
      if (s.engine !== 'codex' || !liveCodexCwds.has(s.cwd)) continue;
      const cur = newestByCwd.get(s.cwd);
      if (!cur || new Date(s.lastActivity) > new Date(cur.lastActivity)) newestByCwd.set(s.cwd, s);
    }
    for (const s of newestByCwd.values()) s.state = 'running';
  }

  const list = [...sessions.values()].sort(
    (a, b) => new Date(b.lastActivity || 0) - new Date(a.lastActivity || 0)
  );

  // Attach agent-team membership. Lead = session whose id prefix matches the
  // team dir name; members are matched by their recorded session id.
  const teams = loadTeams();
  if (teams.length) {
    for (const s of list) {
      const prefix8 = s.id.slice(0, 8);
      for (const t of teams) {
        if (t.leadPrefix && prefix8 === t.leadPrefix) {
          // cfg.members includes the lead's own entry (agentType 'team-lead') —
          // exclude it so it doesn't show up as a "member" nested under itself.
          const teammates = t.members.filter(m => m.agentType !== 'team-lead');
          s.team = {
            name: t.teamName, role: 'lead', size: teammates.length,
            members: teammates.map(m => ({ name: m.name, agentType: m.agentType, status: m.status, sessionId: m.sessionId })),
          };
        } else if (t.members.some(m => m.sessionId && m.sessionId === s.id)) {
          const me = t.members.find(m => m.sessionId === s.id);
          s.team = { name: t.teamName, role: 'member', memberName: me.name || null, agentType: me.agentType || null };
        }
      }
    }
  }

  res.json(list);
});

// Update session metadata (rename, group)
app.patch('/api/sessions/:id', (req, res) => {
  const { id } = req.params;
  const { customName, group, model, effort } = req.body;
  const meta = loadMeta();
  meta[id] = meta[id] || {};
  if (customName !== undefined) {
    meta[id].customName = customName || null;
  }
  if (group !== undefined) meta[id].group = group || null;
  // Interactive sessions don't persist the launch model/effort anywhere we can
  // read, so when the app launches/opens one we remember the choice here.
  if (model !== undefined) meta[id].model = model || null;
  if (effort !== undefined) meta[id].effort = effort || null;
  saveMeta(meta);
  res.json({ ok: true });
});

app.post('/api/sessions/:id/archive', (req, res) => {
  const meta = loadMeta();
  const { id } = req.params;
  meta[id] = meta[id] || {};
  meta[id].archived = !meta[id].archived;
  saveMeta(meta);
  res.json({ archived: meta[id].archived });
});

app.delete('/api/sessions/:id', (req, res) => {
  const { id } = req.params;
  const meta = loadMeta();
  // Tombstone: prevents the session card from reappearing even if the JSONL is
  // recreated by a still-running Claude process (e.g. in an external terminal).
  meta[id] = { ...meta[id], deleted: true };
  saveMeta(meta);

  let removed = false;
  if (fs.existsSync(PROJECTS_DIR)) {
    for (const proj of fs.readdirSync(PROJECTS_DIR)) {
      const p = path.join(PROJECTS_DIR, proj, `${id}.jsonl`);
      if (fs.existsSync(p)) { try { fs.unlinkSync(p); removed = true; } catch {} }
    }
  }
  if (fs.existsSync(JOBS_DIR)) {
    for (const jobId of fs.readdirSync(JOBS_DIR)) {
      try {
        const sf = path.join(JOBS_DIR, jobId, 'state.json');
        if (!fs.existsSync(sf)) continue;
        const s = JSON.parse(fs.readFileSync(sf, 'utf8'));
        const linkId = s.linkScanPath && s.linkScanPath.endsWith('.jsonl')
          ? path.basename(s.linkScanPath, '.jsonl')
          : null;
        if (s.sessionId === id || linkId === id) {
          fs.rmSync(path.join(JOBS_DIR, jobId), { recursive: true });
          removed = true;
        }
      } catch {}
    }
  }
  for (const cs of scanCodexSessions()) {
    if (cs.id !== id) continue;
    try { fs.unlinkSync(cs.path); removed = true; } catch {}
  }
  res.json({ removed });
});

// ── Open file/URL in native app ─────────────────────────────────────────────

const VSCODE_EXTS = new Set([
  '.md', '.txt', '.py', '.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs',
  '.json', '.jsonl', '.yaml', '.yml', '.toml', '.csv', '.tsv',
  '.sh', '.bash', '.zsh', '.fish', '.ipynb',
  '.css', '.scss', '.sass', '.less',
  '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.cpp', '.h',
  '.sql', '.graphql', '.proto', '.tf',
  '.gitignore', '.env', '.envrc', '', // no extension = directory → VS Code
]);

// Resolve a single candidate string to an existing absolute path, or null.
// Handles file:// , ~ , trailing :line:col , and cwd-relative paths.
function resolveCandidate(cand, baseCwd) {
  if (!cand) return null;
  cand = cand.replace(/^file:\/\//, '').replace(/^~(?=\/|$)/, HOME).replace(/:\d+(:\d+)?$/, '');
  if (!cand) return null;
  let p = path.isAbsolute(cand) ? cand : path.join(baseCwd, cand);
  try { if (fs.existsSync(p)) return p; } catch {}
  return null;
}

// Bare filename (no directory) that wasn't found in cwd: search a few levels down,
// the way VS Code does. Bounded so it stays fast even on a network/Drive folder.
const BASENAME_SKIP = new Set(['node_modules', '.git', '.venv', 'venv', 'dist', 'build', '.next', '.cache', '__pycache__', '.idea', '.vscode']);
function findByBasename(name, baseCwd) {
  let budget = 4000;
  const queue = [{ dir: baseCwd, depth: 0 }];
  while (queue.length && budget > 0) {
    const { dir, depth } = queue.shift();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    const subdirs = [];
    for (const ent of entries) {
      if (--budget <= 0) break;
      if (ent.name === name) return path.join(dir, ent.name);
      if (ent.isDirectory() && depth < 3 && !ent.name.startsWith('.') && !BASENAME_SKIP.has(ent.name)) {
        subdirs.push(path.join(dir, ent.name));
      }
    }
    for (const d of subdirs) queue.push({ dir: d, depth: depth + 1 });
  }
  return null;
}

// Given a line of terminal text and the clicked column, find the longest path
// that spans the click AND actually exists on disk. This is how we handle paths
// containing spaces and parentheses (e.g. Google Drive dirs): a pure regex can't
// know where such a path ends, but the filesystem can. Mirrors VS Code's approach.
function resolvePathAt(line, col, baseCwd) {
  if (typeof line !== 'string' || !line) return null;
  col = Math.max(0, Math.min(col | 0, line.length - 1));
  const isHard = ch => ch === '"' || ch === "'" || ch === '`' || ch === '<' || ch === '>' || ch === '|' || ch === '\t';
  // Region = run around the click excluding chars that can't appear in a path token.
  let rs = col, re = col + 1;
  while (rs > 0 && !isHard(line[rs - 1])) rs--;
  while (re < line.length && !isHard(line[re])) re++;
  // Candidate boundaries: a path can begin after a space OR an opening delimiter
  // like `(` `[` `{` `=` `,` `@` (e.g. Claude's `Update(Projects/x.md)` display),
  // and can end before a space OR a closing delimiter. We try all combinations and
  // keep the longest that actually exists, so wrapping delimiters are handled while
  // real paths that contain parens still resolve (the full candidate is also tried).
  const isStartB = ch => ch === ' ' || ch === '(' || ch === '[' || ch === '{' || ch === '=' || ch === ',' || ch === '@';
  // `/` is an end boundary too, so directory prefixes are candidates: clicking any
  // part of `Projects/x/missing-file.md` still resolves to the longest existing
  // ancestor (e.g. the `Projects/x` directory) instead of failing entirely.
  const isEndB = ch => ch === ' ' || ch === ')' || ch === ']' || ch === '}' || ch === ',' || ch === '/';
  const starts = [rs];
  for (let i = rs + 1; i <= col; i++) if (isStartB(line[i - 1])) starts.push(i);
  const ends = [re];
  for (let i = re - 1; i > col; i--) if (isEndB(line[i])) ends.push(i);
  let best = null;
  for (const s of starts) {
    for (const e of ends) {
      if (s > col || e <= col || e <= s) continue;
      const raw = line.slice(s, e).trim();
      for (const cand of [raw, raw.replace(/[.,;:!?)\]}>]+$/, '')]) {
        const r = resolveCandidate(cand, baseCwd);
        if (r && (!best || r.length > best.length)) best = r;
      }
    }
  }
  // Fallback: a bare filename under the click that isn't in cwd — search for it
  // (one bounded search, only when direct resolution found nothing).
  if (!best) {
    let a = col, b = col;
    while (a > 0 && line[a - 1] !== ' ') a--;
    while (b < line.length && line[b] !== ' ') b++;
    const token = line.slice(a, b).replace(/^file:\/\//, '').replace(/:\d+(:\d+)?$/, '').replace(/[.,;:!?)\]}>'"]+$/, '');
    if (token && !token.includes('/') && /[^.]\.\w{1,8}$/.test(token)) {
      best = findByBasename(token, baseCwd);
    }
  }
  return best;
}

app.post('/api/open', (req, res) => {
  let { path: rawPath, cwd: rawCwd, line, col } = req.body;
  const baseCwd = (rawCwd || HOME).replace(/^~(?=\/|$)/, HOME);

  let filePath = null;
  // Preferred path: filesystem-validated resolution from the clicked line + column.
  if (typeof line === 'string') {
    filePath = resolvePathAt(line, col, baseCwd);
    if (!filePath && !rawPath) return res.status(404).json({ error: 'no existing path at click' });
  }
  // Fallback: explicit path string (OSC 8 links, etc.).
  if (!filePath) {
    if (!rawPath) return res.status(400).json({ error: 'no path' });
    filePath = rawPath.replace(/^file:\/\//, '').replace(/^~(?=\/|$)/, HOME);
    if (!path.isAbsolute(filePath)) filePath = path.join(baseCwd, filePath);
  }

  const ext = path.extname(filePath).toLowerCase();

  // Use execFile to avoid shell injection — args passed directly to open(1)
  const openArgs = ext === '.html' || ext === '.htm'
    ? ['-a', 'Google Chrome', filePath]
    : VSCODE_EXTS.has(ext)
    ? ['-a', 'Visual Studio Code', filePath]
    : [filePath];

  execFile('open', openArgs, err => {
    if (err) {
      // Fallback: system default (e.g. VS Code not installed under that name)
      execFile('open', [filePath], err2 => {
        if (err2) res.status(500).json({ error: err2.message });
        else res.json({ ok: true, fallback: true });
      });
    } else {
      res.json({ ok: true });
    }
  });
});

// ── Terminals ────────────────────────────────────────────────────────────────

app.post('/api/terminal', (req, res) => {
  const { engine, model, effort, cwd, sessionId, sessionName, fork, agentsView } = req.body;
  const isCodex = engine === 'codex';
  const bin = isCodex ? codexBin : claudeBin;
  const args = [];
  let assignedSessionId = null;

  if (agentsView) {
    // Open the claude agents TUI — user can attach to a running agent interactively
    args.push('agents');
  } else if (isCodex) {
    // Codex has no --session-id equivalent: it assigns its own UUID internally
    // and it's only discoverable afterward (via `codex resume`/`--last`), so unlike
    // the Claude branch below we can't pre-assign or persist an id up front.
    if (sessionId) args.push('resume', sessionId); // subcommand form, not a flag
    if (model) args.push('--model', model);
    // No --effort flag in Codex; reasoning effort is set via a config override.
    if (effort) args.push('-c', `model_reasoning_effort=${effort}`);
  } else {
    if (sessionId) {
      args.push('--resume', sessionId);
      if (fork) args.push('--fork-session');
    } else {
      // Brand-new session: pre-assign its id so the client can persist model/effort
      // and track it immediately. This removes the old cwd+time guessing that could
      // mis-link a new terminal to an unrelated same-directory session.
      assignedSessionId = crypto.randomUUID();
      args.push('--session-id', assignedSessionId);
    }
    // --name overrides the daemon's session context in the status bar
    if (sessionName) args.push('--name', sessionName);
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
  }
  // Expand ~ in cwd path
  const expandedCwd = cwd ? cwd.replace(/^~(?=$|\/)/, HOME) : HOME;
  const workDir = fs.existsSync(expandedCwd) ? expandedCwd : HOME;

  // Strip session-identity vars so the child gets its own session (not the parent's).
  // CLAUDE_CODE_SESSION_ID is the main issue: child inherits the parent session ID,
  // writes to its JSONL, and shows its title. Auth uses macOS keychain — no env vars.
  // (Codex reads its own credentials from ~/.codex — same no-env-vars assumption.)
  const env = { ...process.env };
  delete env.CLAUDE_CODE_SESSION_ID;   // child must get its own session
  delete env.CLAUDE_CODE_CHILD_SESSION; // don't mark as child — fresh session
  delete env.CLAUDE_JOB_DIR;           // parent job dir is meaningless here
  delete env.CLAUDE_EFFORT;            // we set effort via --effort flag explicitly

  let term;
  try {
    term = pty.spawn(bin, args, {
      name: 'xterm-256color',
      cols: 220,
      rows: 50,
      cwd: workDir,
      env,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err.message) });
  }

  const termId = `t${Date.now().toString(36)}`;
  const td = { pty: term, clients: new Set(), buffer: [] };
  terminals.set(termId, td);

  term.onData(data => {
    td.buffer.push(data);
    if (td.buffer.length > 10000) td.buffer.shift();
    for (const ws of td.clients) {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'data', data }));
    }
  });

  term.onExit(({ exitCode }) => {
    for (const ws of td.clients) {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'exit', code: exitCode }));
    }
    terminals.delete(termId);
  });

  res.json({ termId, cwd: workDir, sessionId: assignedSessionId });
});

app.delete('/api/terminal/:id', (req, res) => {
  const td = terminals.get(req.params.id);
  if (td) { try { td.pty.kill(); } catch {} terminals.delete(req.params.id); }
  res.json({ ok: true });
});

function handleWsConnection(ws, req) {
  // Same guard as HTTP. WebSockets bypass CORS, so Origin is checked explicitly:
  // a cross-origin page must not be able to upgrade into a live PTY.
  const origin = req.headers.origin;
  let originHost = null;
  if (origin) {
    try { originHost = new URL(origin).host; } catch { ws.close(4003, 'Forbidden'); return; }
  }
  if (!isAllowedHost(req.headers.host) || (originHost && !isAllowedHost(originHost))) {
    ws.close(4003, 'Forbidden'); return;
  }
  const url = new URL(req.url, 'http://localhost');
  if (!isLoopback(req.headers.host) && !tokenSource(req, url)) {
    ws.close(4001, 'Unauthorized'); return;
  }
  const termId = url.searchParams.get('id');
  const td = terminals.get(termId);
  if (!td) { ws.close(4004, 'Not found'); return; }

  td.clients.add(ws);
  if (td.buffer.length) ws.send(JSON.stringify({ type: 'data', data: td.buffer.join('') }));

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'input') td.pty.write(msg.data);
      if (msg.type === 'resize') td.pty.resize(Math.max(10, +msg.cols), Math.max(2, +msg.rows));
    } catch {}
  });

  ws.on('close', () => td.clients.delete(ws));
  ws.on('error', () => td.clients.delete(ws));
}

wss.on('connection', handleWsConnection);

const PORT = process.env.PORT || 3737;
const HOST = process.env.HOST || '127.0.0.1';
function handlePortInUse(err) {
  if (err.code === 'EADDRINUSE') {
    console.log(`\nPort ${PORT} already in use — Hive is already running.`);
    console.log(`  Open:  http://localhost:${PORT}`);
    console.log(`  Stop:  launchctl unload ~/Library/LaunchAgents/com.claude-agents.server.plist\n`);
    process.exit(0);
  }
  throw err;
}
server.on('error', handlePortInUse);
wss.on('error', handlePortInUse);
server.listen(PORT, HOST, () => console.log(`Hive: http://localhost:${PORT}`));

// ── Optional NetBird listener ────────────────────────────────────────────────
// Off unless HIVE_NETBIRD=1, so the default deployment stays loopback-only and
// enabling remote reach is a visible, revocable line in the launchd plist rather
// than an implicit property of the code. A second listener bound to the mesh
// address specifically is deliberate: binding 0.0.0.0 would also open the port on
// whatever café or hotel wifi the laptop joins.
if (process.env.HIVE_NETBIRD === '1') {
  if (!NETBIRD_IP) {
    console.log('HIVE_NETBIRD=1 but no NetBird address found — serving loopback only.');
  } else {
    const nbServer = http.createServer(app);
    const nbWss = new WebSocketServer({ server: nbServer, path: '/ws' });
    nbWss.on('connection', handleWsConnection);
    // NetBird may be down at boot; log and keep loopback rather than crash-looping
    // under launchd KeepAlive.
    const softFail = err => console.log(`NetBird listener unavailable (${err.code || err.message}) — serving loopback only.`);
    nbServer.on('error', softFail);
    nbWss.on('error', softFail);
    nbServer.listen(PORT, NETBIRD_IP, () => {
      // Prefer the mesh hostname over the raw IP: NetBird can reassign the IP, but
      // its DNS keeps this hostname pointed at whatever the current one is, so a
      // bookmarked link built from it doesn't go stale.
      const displayHost = NETBIRD_FQDN || NETBIRD_IP;
      console.log(`Hive on NetBird: http://${displayHost}:${PORT}/?token=<token>`);
      console.log(`  token: ${TOKEN_FILE}`);
    });
  }
}
