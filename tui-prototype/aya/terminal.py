"""Embedded terminal widget for Textual.

Based on textual-terminal (David Brochart's pyte example), patched for:
  * Textual 8.x compatibility (no DEFAULT_COLORS / self.app.dark).
  * Inherited environment (so PATH lets us find `claude`, `codex`, `node`, etc.).
  * Configurable cwd.
  * Single-shot rebuild lets us switch processes inside the same widget instance.
"""

from __future__ import annotations

import asyncio
import fcntl
import os
import pty
import re
import shlex
import signal
import struct
import termios
from asyncio import Task

import pyte
from pyte.screens import Char
from rich.color import ColorParseError
from rich.style import Style
from rich.text import Text

from textual import events, log
from textual.message import Message
from textual.widget import Widget


class _PyteScreen(pyte.Screen):
    """Tolerate the `private` margin arg some apps emit."""

    def set_margins(self, *args, **kwargs):
        kwargs.pop("private", None)
        return super().set_margins(*args, **kwargs)


class _Display:
    def __init__(self, lines):
        self.lines = lines

    def __rich_console__(self, _console, _options):
        yield from self.lines


_ANSI_RE = re.compile(r"(\x1b\[\??[\d;]*[a-zA-Z])")
_DECSET_PREFIX = "\x1b[?"


class Terminal(Widget, can_focus=True):
    """A PTY-backed terminal rendered with pyte."""

    DEFAULT_CSS = """
    Terminal {
        background: $background;
    }
    """

    class Exited(Message):
        """Posted when the underlying PTY process disconnects."""

        def __init__(self, terminal: "Terminal") -> None:
            self.terminal = terminal
            super().__init__()

    _CTRL_KEYS = {
        "up": "\x1bOA",
        "down": "\x1bOB",
        "right": "\x1bOC",
        "left": "\x1bOD",
        "home": "\x1bOH",
        "end": "\x1b[F",
        "delete": "\x1b[3~",
        "pageup": "\x1b[5~",
        "pagedown": "\x1b[6~",
        "shift+tab": "\x1b[Z",
        **{f"f{i}": code for i, code in enumerate(
            [
                "\x1bOP", "\x1bOQ", "\x1bOR", "\x1bOS",
                "\x1b[15~", "\x1b[17~", "\x1b[18~", "\x1b[19~",
                "\x1b[20~", "\x1b[21~", "\x1b[23~", "\x1b[24~",
            ],
            start=1,
        )},
    }

    def __init__(
        self,
        command: str,
        *,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        name: str | None = None,
        id: str | None = None,
        classes: str | None = None,
    ) -> None:
        super().__init__(name=name, id=id, classes=classes)
        self.command = command
        self.cwd = cwd
        self.env = env
        self.ncol = 80
        self.nrow = 24
        self.mouse_tracking = False
        self._emulator: _Emulator | None = None
        self._send_queue: asyncio.Queue | None = None
        self._recv_queue: asyncio.Queue | None = None
        self._recv_task: Task | None = None
        self._screen = _PyteScreen(self.ncol, self.nrow)
        self._stream = pyte.Stream(self._screen)
        self._display = _Display([Text()])

    # Lifecycle ----------------------------------------------------------------

    def start(self) -> None:
        if self._emulator is not None:
            return
        self._emulator = _Emulator(self.command, cwd=self.cwd, env=self.env)
        self._emulator.start()
        self._send_queue = self._emulator.recv_queue
        self._recv_queue = self._emulator.send_queue
        self._recv_task = asyncio.create_task(self._recv_loop())

    def stop(self) -> None:
        if self._emulator is None:
            return
        self._display = _Display([Text()])
        if self._recv_task is not None:
            self._recv_task.cancel()
        self._emulator.stop()
        self._emulator = None

    async def on_unmount(self) -> None:
        self.stop()

    # Rendering ----------------------------------------------------------------

    def render(self):
        return self._display

    # Input --------------------------------------------------------------------

    # Keys the host app reserves for global actions. Forwarded by NOT calling
    # event.stop(), so they bubble up to App bindings.
    APP_RESERVED_KEYS = frozenset(
        f"ctrl+f{i}" for i in range(1, 13)
    )

    async def on_key(self, event: events.Key) -> None:
        if event.key in self.APP_RESERVED_KEYS:
            return  # let the app handle it
        if self._send_queue is None:
            return
        event.stop()
        char = self._CTRL_KEYS.get(event.key) or event.character
        if char:
            await self._send_queue.put(["stdin", char])

    async def on_resize(self, _event: events.Resize) -> None:
        if self._send_queue is None:
            return
        self.ncol = max(self.size.width, 1)
        self.nrow = max(self.size.height, 1)
        await self._send_queue.put(["set_size", self.nrow, self.ncol])
        self._screen.resize(self.nrow, self.ncol)

    async def on_click(self, event: events.MouseEvent) -> None:
        if not self.mouse_tracking or self._send_queue is None:
            return
        await self._send_queue.put(["click", event.x, event.y, event.button])

    async def on_mouse_scroll_down(self, event: events.MouseScrollDown) -> None:
        if not self.mouse_tracking or self._send_queue is None:
            return
        await self._send_queue.put(["scroll", "down", event.x, event.y])

    async def on_mouse_scroll_up(self, event: events.MouseScrollUp) -> None:
        if not self.mouse_tracking or self._send_queue is None:
            return
        await self._send_queue.put(["scroll", "up", event.x, event.y])

    # IO loop ------------------------------------------------------------------

    async def _recv_loop(self) -> None:
        assert self._recv_queue is not None and self._send_queue is not None
        try:
            while True:
                message = await self._recv_queue.get()
                cmd = message[0]
                if cmd == "setup":
                    await self._send_queue.put(["set_size", self.nrow, self.ncol])
                elif cmd == "stdout":
                    chars = message[1]
                    for m in _ANSI_RE.finditer(chars):
                        seq = m.group(0)
                        if seq.startswith(_DECSET_PREFIX):
                            params = seq.removeprefix(_DECSET_PREFIX).split(";")
                            if "1000h" in params:
                                self.mouse_tracking = True
                            if "1000l" in params:
                                self.mouse_tracking = False
                    try:
                        self._stream.feed(chars)
                    except TypeError as err:
                        log.warning("pyte feed error:", err)
                    self._rebuild_display()
                    self.refresh()
                elif cmd == "disconnect":
                    self.stop()
                    self.post_message(self.Exited(self))
        except asyncio.CancelledError:
            pass

    def _rebuild_display(self) -> None:
        lines: list[Text] = []
        for y in range(self._screen.lines):
            line_text = Text()
            row = self._screen.buffer[y]
            style_change = 0
            for x in range(self._screen.columns):
                char: Char = row[x]
                line_text.append(char.data)
                if x > 0:
                    prev = row[x - 1]
                    if not _same_style(char, prev) or x == self._screen.columns - 1:
                        style = _char_style(prev)
                        if style is not None:
                            line_text.stylize(style, style_change, x + 1)
                        style_change = x
                if self._screen.cursor.x == x and self._screen.cursor.y == y:
                    line_text.stylize("reverse", x, x + 1)
            lines.append(line_text)
        self._display = _Display(lines)


def _same_style(a: Char, b: Char) -> bool:
    return (
        a.fg == b.fg
        and a.bg == b.bg
        and a.bold == b.bold
        and a.italics == b.italics
        and a.underscore == b.underscore
        and a.strikethrough == b.strikethrough
        and a.reverse == b.reverse
        and a.blink == b.blink
    )


def _color(name: str) -> str:
    if name == "brown":
        return "yellow"
    if name == "brightblack":
        return "#808080"
    if re.fullmatch("[0-9a-fA-F]{6}", name):
        return f"#{name}"
    return name


def _char_style(char: Char) -> Style | None:
    try:
        return Style(color=_color(char.fg), bgcolor=_color(char.bg), bold=char.bold)
    except ColorParseError as err:
        log.warning("color parse error:", err)
        return None


class _Emulator:
    """Owns the forked PTY and pumps bytes between widget and process."""

    def __init__(self, command: str, *, cwd: str | None, env: dict[str, str] | None) -> None:
        self._command = command
        self._cwd = cwd
        self._env = env
        self.pid: int = 0
        self.fd: int = -1
        self._p_out = None
        self.recv_queue: asyncio.Queue = asyncio.Queue()
        self.send_queue: asyncio.Queue = asyncio.Queue()
        self._event = asyncio.Event()
        self._data_or_disconnect: str | None = None
        self._run_task: Task | None = None
        self._send_task: Task | None = None
        self._open_pty()

    def _open_pty(self) -> None:
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            # Child process. Replace with the user's command.
            argv = shlex.split(self._command)
            if self._cwd:
                try:
                    os.chdir(self._cwd)
                except OSError:
                    pass
            env = dict(self._env) if self._env is not None else os.environ.copy()
            env.setdefault("TERM", "xterm-256color")
            env.setdefault("LC_ALL", env.get("LANG", "en_US.UTF-8"))
            try:
                os.execvpe(argv[0], argv, env)
            except FileNotFoundError:
                os.write(2, f"aya: command not found: {argv[0]}\n".encode())
                os._exit(127)
        self._p_out = os.fdopen(self.fd, "w+b", 0)

    def start(self) -> None:
        self._run_task = asyncio.create_task(self._run())
        self._send_task = asyncio.create_task(self._pump())

    def stop(self) -> None:
        if self._run_task:
            self._run_task.cancel()
        if self._send_task:
            self._send_task.cancel()
        try:
            os.kill(self.pid, signal.SIGTERM)
            os.waitpid(self.pid, 0)
        except (ProcessLookupError, ChildProcessError):
            pass

    async def _run(self) -> None:
        loop = asyncio.get_running_loop()

        def on_output() -> None:
            try:
                self._data_or_disconnect = self._p_out.read(65536).decode(errors="replace")
                self._event.set()
            except Exception:
                loop.remove_reader(self._p_out)
                self._data_or_disconnect = None
                self._event.set()

        loop.add_reader(self._p_out, on_output)
        await self.send_queue.put(["setup", {}])
        try:
            while True:
                msg = await self.recv_queue.get()
                if msg[0] == "stdin":
                    self._p_out.write(msg[1].encode())
                elif msg[0] == "set_size":
                    winsize = struct.pack("HH", msg[1], msg[2])
                    fcntl.ioctl(self.fd, termios.TIOCSWINSZ, winsize)
                elif msg[0] == "click":
                    x, y, button = msg[1] + 1, msg[2] + 1, msg[3]
                    if button == 1:
                        self._p_out.write(f"\x1b[<0;{x};{y}M".encode())
                        self._p_out.write(f"\x1b[<0;{x};{y}m".encode())
                elif msg[0] == "scroll":
                    x, y = msg[2] + 1, msg[3] + 1
                    code = 64 if msg[1] == "up" else 65
                    self._p_out.write(f"\x1b[<{code};{x};{y}M".encode())
        except asyncio.CancelledError:
            pass

    async def _pump(self) -> None:
        try:
            while True:
                await self._event.wait()
                self._event.clear()
                if self._data_or_disconnect is not None:
                    await self.send_queue.put(["stdout", self._data_or_disconnect])
                else:
                    await self.send_queue.put(["disconnect", 1])
        except asyncio.CancelledError:
            pass
