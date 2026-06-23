'use strict';

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execSync, execFile } = require('child_process');

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

let claudeBin = 'claude';
try { claudeBin = execSync('which claude', { encoding: 'utf8' }).trim(); } catch {}

// ── Security guard ────────────────────────────────────────────────────────
// This server has no auth. Binding to 127.0.0.1 stops LAN peers, but a website
// the user visits can still reach localhost via DNS rebinding. Defeat that by
// rejecting any request whose Host header isn't loopback (the browser sends the
// attacker's hostname, e.g. evil.com, which fails this check).
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
function hostnameOf(value) {
  if (!value) return null;
  const m = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(String(value).trim());
  return m ? m[1].toLowerCase() : null;
}
function isLoopback(value) {
  const h = hostnameOf(value);
  return h !== null && LOOPBACK_HOSTS.has(h);
}
app.use((req, res, next) => {
  if (!isLoopback(req.headers.host)) return res.status(403).end('Forbidden');
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
  if (m === 'sonnet') return 'claude-sonnet-4-6';
  if (m === 'opus') return 'claude-opus-4-8';
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
    // Latest EXPLICIT rename in the tail (newest-first). Only custom-title and
    // agent-name — NOT ai-title. Claude Code auto-generates ai-title entries as
    // the conversation progresses; allowing those to win would silently undo an
    // intentional /rename or Hive rename every time Claude re-titles the session.
    let tailName = null;
    let aiTitleBeforeCustom = false; // ai-title seen before any custom-title in newest-first scan
    for (let i = tailLines.length - 1; i >= 0; i--) {
      if (!tailLines[i].trim()) continue;
      try {
        const d = JSON.parse(tailLines[i]);
        if (d.type === 'custom-title' && d.customTitle) { tailName = d.customTitle; break; }
        if (d.type === 'agent-name' && d.agentName) { tailName = d.agentName; break; }
        if (d.type === 'ai-title' && d.aiTitle && tailName === null) aiTitleBeforeCustom = true;
      } catch {}
    }
    if (tailName !== null) out.name = tailName;
    out._hasExplicitTitle = tailName !== null;
    out._aiTitleAfterCustom = aiTitleBeforeCustom; // ai-title is newer than our custom-title
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

// Re-append custom-title to JSONL so Claude Code's UI shows the correct name
// when the session is next opened. Fires only when ai-title is newer than our
// custom-title (i.e. Claude rewrote the title after our rename), or when
// customName exists in Hive meta but no custom-title entry is in the JSONL yet.
function reappendCustomTitleIfStale(jsonlPath, jm, sm) {
  if (!jsonlPath) return;
  const nameToPin = sm.customName || (jm._hasExplicitTitle ? jm.name : null);
  if (!nameToPin) return;
  const needsReappend = jm._aiTitleAfterCustom || (sm.customName && !jm._hasExplicitTitle);
  if (!needsReappend) return;
  try {
    fs.appendFileSync(jsonlPath, JSON.stringify({ type: 'custom-title', customTitle: nameToPin }) + '\n');
  } catch {}
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
        busyLive: alive && d.status === 'busy',
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

// ── Routes ──────────────────────────────────────────────────────────────────

app.get('/api/info', (_req, res) => {
  const settings = loadSettings();
  res.json({ home: HOME, claudeBin, defaultCwd: settings.defaultCwd || HOME });
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
        reappendCustomTitleIfStale(linkScanPath, jm, sm);

        sessions.set(id, {
          id,
          shortId: jobId,
          jmName: jm.name || null,
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
          if (sessions.has(sid)) continue;
          const sm = meta[sid] || {};
          if (sm.deleted) continue;
          const jsonlPath = path.join(projPath, file);
          const stat = fs.statSync(jsonlPath);
          const jm = parseSessionMetaCached(jsonlPath);
          const live = registry.get(sid);
          const fullCwd = jm.cwd || HOME;
          reappendCustomTitleIfStale(jsonlPath, jm, sm);

          sessions.set(sid, {
            id: sid,
            shortId: sid.slice(0, 8),
            jmName: jm.name || null,
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
            bg: jm.kind === 'bg' || live?.kind === 'bg' || false,
            bgLive: live?.bgLive || false,
            archived: sm.archived || false,
          });
        }
      } catch {}
    }
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
          s.team = {
            name: t.teamName, role: 'lead', size: t.members.length,
            members: t.members.map(m => ({ name: m.name, agentType: m.agentType, status: m.status })),
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
    // Mirror rename into the JSONL so Claude Code picks it up on next resume.
    // The tail scan in parseSessionMeta reads this entry (newest-first) and
    // returns it as jmName, keeping both directions in sync.
    if (customName) {
      const jsonlPath = findJsonlPath(id);
      if (jsonlPath) {
        try {
          const entry = JSON.stringify({ type: 'custom-title', customTitle: customName });
          fs.appendFileSync(jsonlPath, entry + '\n');
        } catch {}
      }
    }
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
  const { model, effort, cwd, sessionId, sessionName, fork, agentsView } = req.body;
  const args = [];
  let assignedSessionId = null;

  if (agentsView) {
    // Open the claude agents TUI — user can attach to a running agent interactively
    args.push('agents');
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
  const env = { ...process.env };
  delete env.CLAUDE_CODE_SESSION_ID;   // child must get its own session
  delete env.CLAUDE_CODE_CHILD_SESSION; // don't mark as child — fresh session
  delete env.CLAUDE_JOB_DIR;           // parent job dir is meaningless here
  delete env.CLAUDE_EFFORT;            // we set effort via --effort flag explicitly

  let term;
  try {
    term = pty.spawn(claudeBin, args, {
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

wss.on('connection', (ws, req) => {
  // Same loopback guard as HTTP: reject non-loopback Host, and reject any
  // cross-origin upgrade (WebSockets bypass CORS, so check Origin explicitly).
  const origin = req.headers.origin;
  if (!isLoopback(req.headers.host) || (origin && !isLoopback(new URL(origin).host))) {
    ws.close(4003, 'Forbidden'); return;
  }
  const url = new URL(req.url, 'http://localhost');
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
});

const PORT = process.env.PORT || 3737;
// Bind to loopback only — never expose the terminal/PTY surface to the network.
// This server has no auth; any LAN peer reaching it could spawn a Claude PTY.
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
