# Hive

A web-based session manager and terminal UI for [Claude Code](https://claude.ai/code). Your swarm of Claude Code sessions and background agents in one grid: open them in embedded terminals, click any file path or URL to open it, and manage everything without leaving the browser.

![License: MIT](https://img.shields.io/badge/license-MIT-blue)
![Node.js](https://img.shields.io/badge/node-%3E%3D18-green)

## Screenshot

> Sessions grid on the left, terminals tiled on the right. Groups, state filters, and clickable file links included.

## Features

**Sessions**
- All sessions and background agents sorted by last activity
- State badges: `running` (animated), `waiting` (needs input), `done`, `idle`, `failed`
- Shows model, effort level, and working directory per session
- New sessions appear automatically within ~5 seconds — no manual refresh

**Terminals**
- Open any session in an embedded xterm.js terminal
- Side-by-side layout: sessions panel on the left, terminals tiled on the right
- Multiple terminals tile in an equal-height grid (1, 2×2, 3-column)
- Drag a terminal's titlebar to reorder the grid; the open-sessions list resorts to match
- Terminal title and Claude Code status bar both update on rename
- Clickable links: absolute, `~`, relative paths and directories open in VS Code or Chrome; URLs open in a new tab; OSC 8 and wrapped-line links handled

**Background agents**
- Background sessions are detected via the live process registry, not just the job scan, so a resumed agent never hits the "currently running as a background agent" error
- Running/idle live agents: choose between **Open Agent Manager** (`claude agents` TUI) or **Fork & Open**
- If a resume slips through, the error is caught in-stream and converted to the attach/fork prompt

**Agent teams** ([experimental](https://code.claude.com/docs/en/agent-teams))
- Reads `~/.claude/teams/{session-XXXXXXXX}/config.json`; the lead card shows a 👥 team badge with member count and names, teammates show their role

**Organisation**
- Rename sessions inline (click the name)
- Assign sessions to named groups; filter by group via pill bar
- Filter by state (Running / Waiting / Done / Idle / Failed) or source (Agents / Interactive)
- Archive (hides from default view) or Delete; archiving an open session closes its terminal

**Quality of life**
- PWA-installable — add to Dock for a standalone window, no browser chrome
- Zero external requests — xterm.js bundled locally, no CDN, no telemetry
- Auto-starts on login via a launchd service (macOS)
- Graceful handling when the server isn't running yet: shows start command + retry button

## Requirements

- **Node.js** ≥ 18
- **Claude Code** CLI (`claude`) installed and authenticated
- macOS (uses `open -a` for file routing; small changes needed for Linux/Windows)

## Setup

```bash
git clone https://github.com/alexander-tsyba-bolt/claude-agents.git
cd claude-agents
npm install
```

### Option A — run manually

```bash
npm start
# → Hive: http://localhost:3737
```

### Option B — auto-start on login (recommended)

Create `~/Library/LaunchAgents/com.claude-agents.server.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>             <string>com.claude-agents.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/claude-agents/server.js</string>
  </array>
  <key>WorkingDirectory</key>  <string>/path/to/claude-agents</string>
  <key>RunAtLoad</key>         <true/>
  <key>KeepAlive</key>         <true/>
  <key>StandardOutPath</key>   <string>/path/to/claude-agents/server.log</string>
  <key>StandardErrorPath</key> <string>/path/to/claude-agents/server.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key> <string>3737</string>
    <key>HOME</key> <string>/Users/yourname</string>
    <key>PATH</key> <string>/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
```

Replace `/path/to/claude-agents` and `/Users/yourname` with your actual paths, then load it:

```bash
launchctl load ~/Library/LaunchAgents/com.claude-agents.server.plist
```

The server now starts on login and restarts automatically if it crashes. Logs go to `server.log`.

**Manage the service:**
```bash
# Stop
launchctl unload ~/Library/LaunchAgents/com.claude-agents.server.plist
# Start
launchctl load  ~/Library/LaunchAgents/com.claude-agents.server.plist
# Check
launchctl list | grep claude-agents
```

Running `npm start` when the service is already up prints a helpful message and exits cleanly.

## PWA Install

In Chrome or Edge: open `http://localhost:3737`, click the install icon in the address bar. "Hive" appears in your Dock as a standalone window.

In Safari: Share → Add to Dock.

## Usage

### Session grid

| Action | How |
|--------|-----|
| Open terminal | **Open** button on any card |
| Rename | Click the session name |
| Set group | **+ Group** → type or pick |
| Archive | **Archive** button (reversible) |
| Delete | **Delete** → confirm |
| Filter | State/source pills in the filter bar |
| New session | **+ New Session** → model, effort, directory |

### Terminals

| Action | How |
|--------|-----|
| Focus open terminal | Button turns **↗ Focus** when open |
| Clickable file link | Hover over a path, click to open |
| Close | **×** in the terminal titlebar |

### File routing on click

| Extension | App |
|-----------|-----|
| `.html`, `.htm` | Google Chrome |
| `.md`, `.py`, `.ipynb`, `.json`, `.yaml`, `.csv`, `.sh`, and most code/text formats | VS Code |
| Everything else | macOS system default |

## Security

- Server binds to **127.0.0.1 only** — never reachable from other machines on the network
- **DNS-rebinding protection**: requests with a non-loopback `Host` header are rejected with 403, so a malicious website cannot reach the local server through the browser
- Terminal I/O stays entirely local: `PTY ↔ WebSocket (localhost) ↔ browser`
- Session history is read from `~/.claude/` — no API calls to Anthropic
- xterm.js is bundled in `public/` — zero CDN requests after install
- File open uses `execFile` (no shell), safe against paths with special characters

## Architecture

```
server.js
  /api/sessions    Reads ~/.claude/jobs/ and ~/.claude/projects/
  /api/terminal    Spawns the Claude CLI in a node-pty PTY
  /api/open        Opens files with native apps via execFile
  /ws              Bidirectional PTY ↔ browser WebSocket

public/
  index.html       Single-page app — vanilla JS, no build step
  xterm.js         Terminal emulator (bundled)
  sw.js            Service worker for PWA offline caching
  manifest.json    PWA manifest
```

## License

MIT
