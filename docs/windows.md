# Agent Deck on Windows

The Windows version runs the same deck (agent-deck, tmux and Claude Code) inside WSL Ubuntu 24.04, with its own desktop app in place of the Mac's iTerm2 window: six terminals, a conversation sidebar, and a right-hand panel with Chat, Changes, Files, Browser and Agents.

> **Preview.** Windows support covers **Claude Code accounts** only; the other subscriptions of the Mac setup are not wired into the Windows installer yet. The desktop app's interface is currently in Vietnamese.

## Install

You need Windows 10 22H2 or Windows 11, a Claude subscription for each account, and Chrome or Edge.

1. Download this repository (Code → Download ZIP) and unzip it to a folder you keep, for example `D:\Tools\agent-deck`. Updating later runs the setup from the same folder.
2. Double-click **`install-windows.cmd`**.
3. Answer its questions:
   - If Ubuntu 24.04 is missing, setup installs it and opens Ubuntu to **create your Linux user name and password**. When that is done (and Windows restarted, if it asks), double-click `install-windows.cmd` again.
   - **Claude emails**: one or more, comma separated. Each becomes an account in the deck, named after the part before the `@`.
   - **Two project folders**: where terminals 1/3/5 and 2/4/6 open (they may be the same folder).

Setup installs what is missing: WSL Ubuntu 24.04, Node.js LTS, Git for Windows and Windows Terminal (through `winget`), and inside Ubuntu tmux, Git, Go, build tools, Node.js, Claude Code and agent-deck (built from source with this repository's patch). The first run takes about 10–20 minutes.

## Sign in

Start menu → **Agent Deck** → **Sign in &lt;name&gt;** for each account. A browser opens with a profile of its own; sign in with **that account's email**. The window says `Signed in correctly` when done. Then open **Agent Deck** from the desktop.

From PowerShell instead: `wsl -d Ubuntu-24.04 -- ~/.local/bin/agent-deck-login <name>`.

## Update

Double-click `install-windows.cmd` again. The account list is kept; press Enter to keep the project folders or type new ones. To rebuild only the desktop app: `.\windows\install-desktop.ps1`.

To change the accounts, delete `~/.config/agent-deck/accounts.js` in Ubuntu and run the setup again.

## What the desktop app adds

- **Six terminals** in a 2×3 or 3×2 grid, each showing a deck panel. Zoom one (Ctrl+Shift+Z), pick one with Ctrl+Alt+1…6. Ctrl+Z inside Claude undoes input instead of suspending it.
- **Conversation sidebar**: chats grouped by project and worktree, running ones first; click one to open it in the selected terminal. Rename, archive or delete from the context menu.
- **Chat**: the selected terminal at full size, or its history rendered as chat (Markdown, images, tool cards). The composer sends into the same Claude session, with attachments (paste, drag and drop), model and effort pickers, a message **queue** while Claude is busy, and **Steer** (Ctrl+Enter) to reach the running turn.
- **Skills and plugins**: type `/` in the composer for every built-in command, skill and plugin command of the chat's account; the **Skills & plugins** button lists them and turns plugins on or off for that account.
- **Changes**: Git review of uncommitted, staged, branch-to-branch and per-commit changes, as one scrolling diff with a file list, reviewed marks and side-by-side view. **Files** browses and edits the project (Ctrl+S saves).
- **Worktrees and branches**: create a worktree for a parallel task, switch branches when the checkout is clean; sessions follow the folder their terminal is in.
- **Browser**: a Chrome of the deck's own (DevTools only on `127.0.0.1`), shown live in the panel. To let Claude use it, register the `browser` MCP server once per account: `CLAUDE_CONFIG_DIR=~/.claude-<name> claude mcp add --scope user browser -- ~/.local/bin/agent-deck-browser-mcp`. Each chat then gets an isolated browser context.
- **Agents**: sub-agents and background tasks of the selected chat, with their progress.
- **Account limits**: the 5-hour window left for each account, with the time to its reset.
- **Tray**: closing the window keeps the agents running; the tray menu can quit and stop them.

The app polls only while its window is visible, so it stays light when it sits in the tray.

## Where things are

| What | Where |
| --- | --- |
| Desktop app | `%LOCALAPPDATA%\AgentDeck\Desktop-<date>` (one folder per install) |
| Desktop log | `%APPDATA%\Agent Deck\desktop.log` |
| Sign-in browser profiles | `%LOCALAPPDATA%\AgentDeck\Login` |
| Agent browser profile | `%LOCALAPPDATA%\AgentDeck\browser\profile` |
| Deck configuration (Ubuntu) | `~/.config/agent-deck` |
| Desktop backend (Ubuntu) | `~/.local/share/agent-deck/desktop` |
| Deck log (Ubuntu) | `~/.local/state/agent-deck/Agent Deck.log` |

The `Login` and `browser\profile` folders hold signed-in sessions: never share them.

## Notes

- The installer adds every plugin of the official Claude Code marketplace to each account (`node ~/.config/agent-deck/claude-skills.js install`). Some start an MCP server in every chat and use memory; turn the ones you do not need off in **Skills & plugins**.
- Claude keeps asking before running commands on Windows (the deck's skip-permissions setting is off).
- Git for Windows reads repositories on Windows drives much faster than Git in WSL; the app uses it for those, and gives Claude a small Git bridge so worktrees made by either work.

## How it fits together

| Part | Folder |
| --- | --- |
| Setup (`install-windows.cmd` → `setup.ps1`), WSL installer, sign-in, shortcuts | `windows/` |
| Desktop app: Electron window and renderer (React) | `desktop/main.cjs`, `desktop/src` |
| Desktop backend: runs in WSL, drives the six panels through tmux and the deck | `desktop/backend` |
| Skills and plugins catalog | `deck/claude-skills.js` |

The desktop backend takes the place of `iterm.py`: the deck's controller requests (focus, zoom, new deck, notify…) arrive at it through `windows/desktop-bridge.js`. Unit tests: `node --test desktop/tests/*.test.cjs`.
