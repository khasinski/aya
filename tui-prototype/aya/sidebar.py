"""Sidebar widgets: working-tab strip and quick-add buttons.

Each working tab is a `TabRow` — a clickable name half plus a clickable ✕.
Rows are 3 cells tall so they're a comfortable mouse target and the active
tab gets a left-edge accent bar (▌) and bold styling.

A `QuickAddBar` at the bottom of the sidebar offers single-click creation of
shell / claude / codex tabs.
"""

from __future__ import annotations

from textual.app import ComposeResult
from textual.containers import Horizontal
from textual.message import Message
from textual.widget import Widget
from textual.widgets import Static

from .config import TabKind, WorkingTab


_KIND_GLYPH = {"claude": "C", "codex": "X", "shell": "$"}


def kind_glyph(kind: TabKind) -> str:
    """Letter glyph for a tab kind — rendered inside square brackets."""
    return _KIND_GLYPH.get(kind, "?")


def kind_label(kind: TabKind) -> str:
    return {"claude": "Claude", "codex": "Codex", "shell": "Shell"}.get(kind, kind)


class TabSwitch(Message):
    """Request to switch the active working tab."""

    def __init__(self, tab_id: str) -> None:
        self.tab_id = tab_id
        super().__init__()


class TabClose(Message):
    """Request to close a working tab."""

    def __init__(self, tab_id: str) -> None:
        self.tab_id = tab_id
        super().__init__()


class _TabLabel(Static):
    """Name half of a tab row. Clicking switches tabs."""

    DEFAULT_CSS = """
    _TabLabel {
        width: 1fr;
        height: 3;
        padding: 1 1 1 2;
        background: $panel;
        color: $text;
    }
    _TabLabel:hover {
        background: $boost;
    }
    _TabLabel.-active {
        background: $accent 30%;
        color: $text;
        text-style: bold;
    }
    """

    def __init__(self, tab: WorkingTab) -> None:
        super().__init__()
        self.tab = tab
        self._is_active = False
        self.update(self._format())

    def _format(self) -> str:
        bar = "[$accent]▌[/]" if self._is_active else " "
        return f"{bar} [{kind_glyph(self.tab.kind)}] {self.tab.title}"

    def set_active(self, active: bool) -> None:
        self._is_active = active
        self.set_class(active, "-active")
        self.update(self._format())

    def on_click(self) -> None:
        self.post_message(TabSwitch(self.tab.id))


class _TabCloseButton(Static):
    """The ✕ half of a tab row."""

    DEFAULT_CSS = """
    _TabCloseButton {
        width: 3;
        height: 3;
        content-align: center middle;
        background: $panel;
        color: $text-muted;
    }
    _TabCloseButton:hover {
        background: $error;
        color: $background;
        text-style: bold;
    }
    """

    def __init__(self, tab: WorkingTab) -> None:
        super().__init__("✕")
        self.tab = tab

    def on_click(self) -> None:
        self.post_message(TabClose(self.tab.id))


class TabRow(Horizontal):
    """A single row in the working-tab list."""

    DEFAULT_CSS = """
    TabRow {
        height: 3;
        width: 100%;
    }
    """

    def __init__(self, tab: WorkingTab) -> None:
        super().__init__(id=f"row-{tab.id}")
        self.tab = tab
        self._label = _TabLabel(tab)
        self._close = _TabCloseButton(tab)

    def compose(self) -> ComposeResult:
        yield self._label
        yield self._close

    def set_active(self, active: bool) -> None:
        self._label.set_active(active)


class QuickAdd(Message):
    """Request to add a new working tab of the given kind."""

    def __init__(self, kind: TabKind) -> None:
        self.kind = kind
        super().__init__()


class _QuickAddButton(Static):
    """One row in the quick-add section."""

    DEFAULT_CSS = """
    _QuickAddButton {
        height: 3;
        width: 100%;
        padding: 1 1 1 2;
        background: $panel;
        color: $text;
    }
    _QuickAddButton:hover {
        background: $primary;
        color: $background;
        text-style: bold;
    }
    """

    def __init__(self, kind: TabKind) -> None:
        super().__init__()
        self.kind = kind
        self.update(self._format())

    def _format(self) -> str:
        return f"＋ [{kind_glyph(self.kind)}] {kind_label(self.kind)}"

    def on_click(self) -> None:
        self.post_message(QuickAdd(self.kind))


class QuickAddBar(Widget):
    """The cluster of '＋ Shell / ＋ Claude / ＋ Codex' buttons."""

    DEFAULT_CSS = """
    QuickAddBar {
        height: auto;
        width: 100%;
        background: $panel;
        border-top: heavy $primary 50%;
    }
    QuickAddBar Static.section-title {
        height: 1;
        background: $panel;
        color: $text-muted;
        text-style: bold;
        padding: 0 1;
    }
    """

    def compose(self) -> ComposeResult:
        yield Static("NEW TAB", classes="section-title")
        yield _QuickAddButton("shell")
        yield _QuickAddButton("claude")
        yield _QuickAddButton("codex")
