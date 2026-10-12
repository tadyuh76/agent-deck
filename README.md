<p align="center">
  <img src="docs/icon.png" width="128" alt="">
</p>

<h1 align="center">Agent Deck</h1>

<p align="center">
  Six Claude Code (or Codex) chats side by side in one Mac app, with every conversation one click away.
</p>

<p align="center">
  <img src="docs/deck.png" alt="An Agent Deck window: the conversation list on the left and six chat panels">
</p>

## Install

Paste this into Terminal:

```sh
curl -fsSL https://raw.githubusercontent.com/tadyuh76/agent-deck/main/install.sh | zsh
```

It asks a few things:

- the folder where new chats start
- your Claude account, plus any others you want to use, and your Codex (ChatGPT) accounts if you use Codex
- whether chats may run commands without asking each time
- the model and effort new chats start with, if you want to choose them (Enter keeps the usual one). It asks about Codex only if you added a Codex account

Then it signs you in through the browser and builds everything on your Mac. The first install takes about 5–10 minutes.

It installs anything missing along the way: Homebrew, Node, tmux, Go, git, iTerm2 and Claude Code, plus Codex if you add a Codex account.

**Mac only** (macOS 14 or later). There is no Windows version: the app is built from iTerm2, which runs only on the Mac.

## What you get

- **One app in your Dock.** Click it to bring your decks back. Right-click it, or press `⌘N`, for a new deck.
- **Six chats at once.** Each deck window has six panels, each a live Claude Code chat, titled *account · project · chat name*. Chats get their names on their own, from what they are about.
- **Every conversation in one list.** The left side groups chats into *Needs you*, *Working* and *Recent*, with recent ones grouped by project. Double-click one to open it in a free panel, or to jump to the panel that already has it.
- **Several accounts, Claude and Codex.** Each one's 5-hour and weekly usage is shown as bars. When a chat reaches an account's limit, it carries on with its full history in the account of the same kind that has the most room left.
- **Your model and effort.** New chats start with the model and effort you chose for Claude and for Codex. Any chat can still switch with `/model`.
- **Nothing stops when you close it.** Closing a deck window or quitting the app only closes the view; every chat keeps running, and each panel shows its chat again when the deck reopens.

<p align="center">
  <img src="docs/accounts.png" width="560" alt="A chat that reached its account's limit, offering to continue on another account">
  <br>
  <sub>When an account reaches its limit, the chat carries on in the one with the most room.</sub>
</p>

## Using it

- **Start a chat:** in an empty panel, press the number of an account (`1`, `2`, `3`…). Press `f` first to start in another folder.
- **Open a chat:** double-click it in the list on the left, or select it and press Enter.
- **Panels are panes:** drag the dividers to resize, `⌘⇧↩` to zoom one, `⌘⌥` + arrows to move between them.
- **Copy text:** drag over it and let go; it is on the clipboard.
- **Shortcuts:** press `Ctrl+B`, then:

  | Key | Does |
  | --- | --- |
  | `r` / `d` | recent list / project tree |
  | `g` | jump to the panels |
  | `n` | account menu in this panel (`r` there returns to the chat) |
  | `s` | move this chat to another account |
  | `z` | zoom this panel |
  | `w` | another deck window |

## Accounts, folder, updates

```sh
# Add another Claude or Codex account
curl -fsSL https://raw.githubusercontent.com/tadyuh76/agent-deck/main/install.sh | zsh -s -- --add-account

# Change the model and effort new chats start with
curl -fsSL https://raw.githubusercontent.com/tadyuh76/agent-deck/main/install.sh | zsh -s -- --models

# Change the folder where new chats start
curl -fsSL https://raw.githubusercontent.com/tadyuh76/agent-deck/main/install.sh | zsh -s -- --folder ~/Code

# Update: run the install line again. The chat engine also updates itself each morning.
curl -fsSL https://raw.githubusercontent.com/tadyuh76/agent-deck/main/install.sh | zsh

# Uninstall (your Claude accounts and conversations stay)
curl -fsSL https://raw.githubusercontent.com/tadyuh76/agent-deck/main/install.sh | zsh -s -- --uninstall
```

A chat can move to another account of the same kind and carry on where it left off. Your first Claude account uses Claude Code's usual folder (`~/.claude`). Each extra account gets its own folder for its sign-in.

## How it is made

- **The app** is your own installed iTerm2, copied under the name Agent Deck with a small add-on that arranges the deck windows. It is built on your Mac during setup; nothing prebuilt is downloaded. Your own iTerm2, its windows and its settings are left alone.
- **The chats** run in [agent-deck](https://github.com/asheshgoplani/agent-deck) with this project's changes, built from source. Each morning it picks up new agent-deck releases and applies the changes again.
- Problems are written to `~/Library/Logs/Agent Deck.log`.

## Credits

Built on [agent-deck](https://github.com/asheshgoplani/agent-deck) by Ashesh Goplani (MIT) and [iTerm2](https://iterm2.com) by George Nachman (GPL-2.0). Agent Deck is an independent project, not made by or affiliated with Anthropic, iTerm2 or agent-deck.

## License

[MIT](LICENSE)
