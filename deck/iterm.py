#!/usr/bin/env python3
"""Arranges the deck windows of the Agent Deck app.

The app is its own copy of iTerm2 (app/build-app). Every deck window has the
conversation list on the left and six chat panels as split panes, each with its
own title bar. The app starts this controller with a key to its Python API and
starts it again if it stops. The deck's scripts reach it on a local socket, one
JSON line per request, to open and raise deck windows and to find, focus and
highlight panels.
"""
import asyncio
import json
import os
import re
import time

import iterm2

ROOT = os.path.dirname(os.path.realpath(__file__))
HOME = os.path.expanduser('~')
SOCKET = os.path.join(ROOT, 'iterm.sock')
OPEN_DECKS = os.path.join(ROOT, 'open-decks.json')
PANELS = os.path.join(ROOT, 'panels')
LOG = os.path.join(HOME, 'Library/Logs/Agent Deck.log')
RUN = os.path.join(HOME, '.local/bin/agent-deck-run')
PROFILE = 'Agent Deck'
LIST_COLUMNS = 50
WORKSPACE = re.compile(r'^claude-desk(?:-\d+)?$')
HIGHLIGHT = {'dark': '#3b3420', 'light': '#fbefc4'}


def log(text):
    with open(LOG, 'a') as f:
        f.write(time.strftime('%F %T') + ' Deck controller: ' + text + '\n')


def number(workspace):
    return 1 if workspace == 'claude-desk' else int(workspace.rsplit('-', 1)[1])


def workspace_named(n):
    return 'claude-desk' if n == 1 else 'claude-desk-%d' % n


def title(workspace):
    return 'Agent Deck %d' % number(workspace)


def program(workspace, script, *args):
    return ' '.join([RUN, workspace, os.path.join(ROOT, script), *args])


def panel_profile(workspace, slot):
    profile = iterm2.LocalWriteOnlyProfile()
    profile.set_use_custom_command('Yes')
    profile.set_command(program(workspace, 'panel.js', str(slot), '--restore'))
    return profile


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except (OSError, TypeError):
        return False


def recorded_panels():
    """Deck panes by terminal, as the list and each panel record themselves."""
    found = {}
    try:
        workspaces = [w for w in os.listdir(PANELS) if WORKSPACE.match(w)]
    except FileNotFoundError:
        return found
    for workspace in workspaces:
        for slot in range(7):
            try:
                with open(os.path.join(PANELS, workspace, '%d.json' % slot)) as f:
                    state = json.load(f)
            except (OSError, ValueError):
                continue
            if state.get('tty') and alive(state.get('pid')):
                found[state['tty']] = (workspace, slot)
    return found


class Deck:
    def __init__(self, connection):
        self.connection = connection
        self.app = None
        self.places = {}   # session id -> (workspace, slot)
        self.ttys = {}     # session id -> terminal
        self.last = {}     # workspace -> panel focused last
        self.frame = None  # where new deck windows open
        self.busy = asyncio.Lock()
        self.notices = {}

    # Deck windows

    async def refresh(self):
        self.app = await iterm2.async_get_app(self.connection)
        await self.app.async_refresh()
        live = set()
        recorded = None
        for window in self.app.terminal_windows:
            for tab in window.tabs:
                for session in tab.sessions:
                    live.add(session.session_id)
                    if session.session_id in self.places:
                        continue
                    if recorded is None:
                        recorded = recorded_panels()
                    place = recorded.get(await self.tty(session))
                    if place:
                        self.places[session.session_id] = place
        for gone in set(self.places) - live:
            self.places.pop(gone, None)
            self.ttys.pop(gone, None)

    def windows(self):
        """Deck windows by workspace."""
        found = {}
        for window in self.app.terminal_windows:
            for tab in window.tabs:
                for session in tab.sessions:
                    place = self.places.get(session.session_id)
                    if place:
                        found.setdefault(place[0], window)
        return found

    def sessions(self, window):
        by_slot = {}
        for tab in window.tabs:
            for session in tab.sessions:
                place = self.places.get(session.session_id)
                if place:
                    by_slot[place[1]] = session
        return by_slot

    async def tty(self, session):
        if session.session_id not in self.ttys:
            self.ttys[session.session_id] = await session.async_get_variable('tty')
        return self.ttys[session.session_id]

    async def session_for(self, tty):
        await self.refresh()
        for window in self.app.terminal_windows:
            for tab in window.tabs:
                for session in tab.sessions:
                    if await self.tty(session) == tty:
                        return session
        raise LookupError('That panel is not open.')

    def save(self):
        decks = sorted(self.windows(), key=number)
        temp = OPEN_DECKS + '.tmp'
        with open(temp, 'w') as f:
            json.dump({'open': decks}, f)
        os.replace(temp, OPEN_DECKS)

    def saved(self):
        try:
            with open(OPEN_DECKS) as f:
                decks = [w for w in json.load(f).get('open', []) if WORKSPACE.match(w)]
        except (OSError, ValueError):
            decks = []
        return decks or ['claude-desk']

    async def settle(self, window_id):
        for _ in range(100):
            await self.app.async_refresh()
            window = self.app.get_window_by_id(window_id)
            if window and window.current_tab and window.current_tab.current_session:
                return window
            await asyncio.sleep(0.05)
        raise RuntimeError('The deck window did not open.')

    def frame_for(self, frame):
        if frame:
            self.frame = iterm2.Frame(iterm2.Point(frame['x'], frame['y']), iterm2.Size(frame['width'], frame['height']))
        return self.frame

    async def create(self, workspace, frame):
        dashboard = program(workspace, 'workspace.js', 'dashboard', '--workspace', workspace)
        created = await iterm2.Window.async_create(self.connection, profile=PROFILE, command=dashboard)
        window = await self.settle(created.window_id)
        left = window.current_tab.current_session
        self.places[left.session_id] = (workspace, 0)
        # The list's own title changes with the chat it points at; keep its name.
        fixed = iterm2.LocalWriteOnlyProfile()
        fixed.set_allow_title_setting(False)
        await left.async_set_profile_properties(fixed)
        await left.async_set_name('Conversations')
        await window.async_set_title(title(workspace))
        # Fill the screen under the pointer exactly; a plain frame snaps to whole characters.
        if frame:
            await window.async_set_frame(frame)
        await window.async_activate()
        try:
            await iterm2.MainMenu.async_select_menu_item(self.connection, 'Window Style.Maximized')
            await asyncio.sleep(0.3)
        except Exception:
            pass
        top = await left.async_split_pane(vertical=True, profile=PROFILE, profile_customizations=panel_profile(workspace, 1))
        bottom = await top.async_split_pane(vertical=False, profile=PROFILE, profile_customizations=panel_profile(workspace, 4))
        rows = [[top], [bottom]]
        for row, slots in zip(rows, ((2, 3), (5, 6))):
            for slot in slots:
                row.append(await row[-1].async_split_pane(vertical=True, profile=PROFILE, profile_customizations=panel_profile(workspace, slot)))
        for slot, session in enumerate(rows[0] + rows[1], start=1):
            self.places[session.session_id] = (workspace, slot)
        self.last[workspace] = 1
        await self.arrange(window.window_id)
        await top.async_activate(select_tab=True, order_window_front=True)
        self.save()

    async def arrange(self, window_id):
        """The list keeps a fixed width; the six panels share the rest evenly."""
        await asyncio.sleep(0.2)
        await self.app.async_refresh()
        window = self.app.get_window_by_id(window_id)
        tab = window.current_tab
        by_slot = self.sessions(window)
        if set(by_slot) != set(range(7)):
            return
        width = sum(by_slot[s].grid_size.width for s in (0, 1, 2, 3))
        height = by_slot[1].grid_size.height + by_slot[4].grid_size.height
        listed = min(LIST_COLUMNS, max(30, width // 4))
        rest = width - listed
        columns = [rest // 3, rest // 3, rest - 2 * (rest // 3)]
        top = height // 2
        by_slot[0].preferred_size = iterm2.Size(listed, height)
        for i, slot in enumerate((1, 2, 3)):
            by_slot[slot].preferred_size = iterm2.Size(columns[i], top)
        for i, slot in enumerate((4, 5, 6)):
            by_slot[slot].preferred_size = iterm2.Size(columns[i], height - top)
        await tab.async_update_layout()

    async def bring_forward(self, window):
        await window.async_activate()

    async def open(self, workspace, frame):
        await self.refresh()
        window = self.windows().get(workspace)
        if window:
            await self.bring_forward(window)
        else:
            await self.create(workspace, frame or self.nearby_frame())

    def nearby_frame(self):
        return self.frame

    # Requests

    async def handle(self, request):
        command = request.get('cmd')
        if command == 'ping':
            return {}
        frame = self.frame_for(request.get('frame'))
        if command in ('open', 'new', 'restore', 'show', 'decks'):
            async with self.busy:
                await self.refresh()
                if command == 'decks':
                    return {'decks': sorted(self.windows(), key=number)}
                if command == 'open':
                    workspace = request.get('workspace', 'claude-desk')
                    if not WORKSPACE.match(workspace):
                        raise ValueError('Unknown deck.')
                    await self.open(workspace, frame)
                elif command == 'new':
                    n = 1
                    while workspace_named(n) in self.windows():
                        n += 1
                    await self.create(workspace_named(n), frame)
                else:
                    windows = self.windows()
                    if command == 'show' and windows:
                        for workspace in sorted(windows, key=number, reverse=True):
                            await self.bring_forward(windows[workspace])
                    else:
                        for workspace in self.saved():
                            if workspace not in windows:
                                await self.create(workspace, frame)
                        windows = self.windows()
                        for workspace in sorted(windows, key=number, reverse=True):
                            await self.bring_forward(windows[workspace])
                self.save()
                return {'decks': sorted(self.windows(), key=number)}
        if command == 'focus':
            session = await self.session_for(request['tty'])
            await session.async_activate(select_tab=True, order_window_front=True)
            return {}
        if command == 'flash':
            session = await self.session_for(request['tty'])
            asyncio.ensure_future(self.flash(session))
            return {}
        if command == 'zoom':
            session = await self.session_for(request['tty'])
            await session.async_activate(select_tab=True, order_window_front=True)
            await iterm2.MainMenu.async_select_menu_item(self.connection, iterm2.MainMenu.View.MAXIMIZE_ACTIVE_PANE.value.identifier)
            return {}
        if command == 'restart':
            session = await self.session_for(request['tty'])
            await session.async_restart(only_if_exited=False)
            return {}
        if command == 'active':
            return {'slot': self.last.get(request.get('workspace'), 1)}
        if command == 'list-view':
            return await self.list_view(request.get('workspace'), request.get('mode'))
        if command == 'focus-panel':
            await self.refresh()
            window = self.windows().get(request.get('workspace'))
            if window:
                session = self.sessions(window).get(self.last.get(request.get('workspace'), 1))
                if session:
                    await session.async_activate(select_tab=True, order_window_front=True)
            return {}
        if command == 'notify':
            await self.refresh()
            for workspace, window in self.windows().items():
                asyncio.ensure_future(self.notice(workspace, window, request.get('text', '')))
            return {}
        raise ValueError('Unknown request.')

    async def flash(self, session):
        theme = await self.app.async_get_variable('effectiveTheme') or ''
        color = HIGHLIGHT['light' if 'light' in theme else 'dark']
        try:
            for pause in (0.25, 0):
                await session.async_inject(('\x1b]11;%s\x07' % color).encode())
                await asyncio.sleep(0.35)
                await session.async_inject(b'\x1b]111\x07')
                await asyncio.sleep(pause)
        except Exception:
            pass

    async def list_view(self, workspace, mode):
        """Shows the list as recent chats or the project tree, and focuses it."""
        await self.refresh()
        window = self.windows().get(workspace)
        if not window:
            return {}
        listing = self.sessions(window).get(0)
        if not listing:
            return {}
        contents = await listing.async_get_screen_contents()
        text = '\n'.join(contents.line(i).string for i in range(contents.number_of_lines))
        if ('RECENT · Alt+V Projects' in text) != (mode == 'recent'):
            await listing.async_send_text('\x1bv')
        await listing.async_activate(select_tab=True, order_window_front=True)
        return {}

    async def notice(self, workspace, window, text):
        """Shows a short note in the deck window's title for a few seconds."""
        stamp = time.monotonic()
        self.notices[workspace] = stamp
        try:
            await window.async_set_title(title(workspace) + '  —  ' + text)
            await asyncio.sleep(10)
            if self.notices.get(workspace) == stamp:
                await window.async_set_title(title(workspace))
        except Exception:
            pass

    # Watchers

    async def watch_focus(self):
        async with iterm2.FocusMonitor(self.connection) as monitor:
            while True:
                update = await monitor.async_get_next_update()
                if update.active_session_changed:
                    place = self.places.get(update.active_session_changed.session_id)
                    if place and place[1] > 0:
                        self.last[place[0]] = place[1]

    async def watch_closing(self):
        async with iterm2.SessionTerminationMonitor(self.connection) as monitor:
            while True:
                session_id = await monitor.async_get()
                if session_id in self.places:
                    asyncio.ensure_future(self.closed())

    async def closed(self):
        # Quitting the app also closes every session, but the app stops this
        # controller first, so the decks open now are kept for next time.
        await asyncio.sleep(2)
        async with self.busy:
            await self.refresh()
            self.save()

    async def client(self, reader, writer):
        try:
            request = json.loads(await reader.readline())
            reply = {'ok': True, **(await self.handle(request) or {})}
        except Exception as error:
            if not isinstance(error, LookupError):
                log('%s: %s' % (type(error).__name__, error))
            reply = {'ok': False, 'error': str(error) or 'Something went wrong.'}
        try:
            writer.write((json.dumps(reply) + '\n').encode())
            await writer.drain()
        finally:
            writer.close()


async def running():
    try:
        _, writer = await asyncio.open_unix_connection(SOCKET)
        writer.close()
        return True
    except OSError:
        return False


serving = False


async def main(connection):
    global serving
    if await running():
        return
    deck = Deck(connection)
    # Text selected in a chat reaches the Mac clipboard through the terminal.
    await iterm2.async_set_preference(connection, iterm2.PreferenceKey.APPS_MAY_ACCESS_PASTEBOARD, True)
    await deck.refresh()
    try:
        os.unlink(SOCKET)
    except FileNotFoundError:
        pass
    await asyncio.start_unix_server(deck.client, path=SOCKET)
    os.chmod(SOCKET, 0o600)
    serving = True
    log('started')
    await asyncio.gather(deck.watch_focus(), deck.watch_closing())


if __name__ == '__main__':
    try:
        iterm2.run_until_complete(main)
    except Exception as error:
        log('stopped: %s' % (error or type(error).__name__))
    finally:
        if serving:
            try:
                os.unlink(SOCKET)
            except OSError:
                pass
