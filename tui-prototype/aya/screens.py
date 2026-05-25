"""Modal screens for project / working-tab creation."""

from __future__ import annotations

import os
from pathlib import Path

from textual import on
from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical
from textual.screen import ModalScreen
from textual.widgets import Button, Input, Label, RadioButton, RadioSet

from .config import TabKind


class NewProjectScreen(ModalScreen[tuple[str, str] | None]):
    """Ask for project name and directory. Returns (name, directory) or None."""

    DEFAULT_CSS = """
    NewProjectScreen {
        align: center middle;
    }
    NewProjectScreen > Vertical {
        width: 64;
        height: auto;
        padding: 1 2;
        background: $panel;
        border: round $primary;
    }
    NewProjectScreen Label.title {
        text-style: bold;
        margin-bottom: 1;
    }
    NewProjectScreen Label.hint {
        color: $text-muted;
        margin-bottom: 1;
    }
    NewProjectScreen Input {
        margin-bottom: 1;
    }
    NewProjectScreen Horizontal {
        height: auto;
        align-horizontal: right;
    }
    NewProjectScreen Button {
        margin-left: 1;
    }
    """

    BINDINGS = [("escape", "cancel", "Cancel")]

    def __init__(
        self,
        *,
        title: str = "New project",
        hint: str | None = None,
        default_name: str = "",
        default_directory: str | None = None,
        lock_directory: bool = False,
    ) -> None:
        super().__init__()
        self._title = title
        self._hint = hint
        self._default_name = default_name
        self._default_directory = default_directory or str(Path.cwd())
        self._lock_directory = lock_directory

    def compose(self) -> ComposeResult:
        with Vertical():
            yield Label(self._title, classes="title")
            if self._hint:
                yield Label(self._hint, classes="hint")
            yield Input(placeholder="Name", value=self._default_name, id="name")
            yield Input(
                placeholder="Directory (absolute or ~)",
                value=self._default_directory,
                id="directory",
                disabled=self._lock_directory,
            )
            with Horizontal():
                yield Button("Cancel", id="cancel")
                yield Button("Create", id="create", variant="primary")

    def on_mount(self) -> None:
        name_input = self.query_one("#name", Input)
        name_input.focus()
        if self._default_name:
            name_input.cursor_position = len(self._default_name)

    @on(Button.Pressed, "#cancel")
    def _cancel(self) -> None:
        self.dismiss(None)

    @on(Button.Pressed, "#create")
    def _create(self) -> None:
        name = self.query_one("#name", Input).value.strip()
        directory = self.query_one("#directory", Input).value.strip()
        if not name or not directory:
            return
        directory = os.path.abspath(os.path.expanduser(directory))
        self.dismiss((name, directory))

    @on(Input.Submitted)
    def _submitted(self, event: Input.Submitted) -> None:
        if event.input.id == "name":
            self.query_one("#directory", Input).focus()
        else:
            self._create()

    def action_cancel(self) -> None:
        self.dismiss(None)


class NewTabScreen(ModalScreen[TabKind | None]):
    """Pick a working-tab kind. Returns the chosen kind or None."""

    DEFAULT_CSS = """
    NewTabScreen {
        align: center middle;
    }
    NewTabScreen > Vertical {
        width: 48;
        height: auto;
        padding: 1 2;
        background: $panel;
        border: round $primary;
    }
    NewTabScreen Label.title {
        text-style: bold;
        margin-bottom: 1;
    }
    NewTabScreen Horizontal {
        height: auto;
        align-horizontal: right;
        margin-top: 1;
    }
    NewTabScreen Button {
        margin-left: 1;
    }
    """

    BINDINGS = [("escape", "cancel", "Cancel")]

    def compose(self) -> ComposeResult:
        with Vertical():
            yield Label("New working tab", classes="title")
            with RadioSet(id="kinds"):
                yield RadioButton("Claude Code", value=True, id="kind-claude")
                yield RadioButton("Codex", id="kind-codex")
                yield RadioButton("Shell", id="kind-shell")
            with Horizontal():
                yield Button("Cancel", id="cancel")
                yield Button("Open", id="open", variant="primary")

    def on_mount(self) -> None:
        self.query_one("#kinds", RadioSet).focus()

    @on(Button.Pressed, "#cancel")
    def _cancel(self) -> None:
        self.dismiss(None)

    @on(Button.Pressed, "#open")
    def _open(self) -> None:
        kinds = self.query_one("#kinds", RadioSet)
        pressed = kinds.pressed_button
        if pressed is None or pressed.id is None:
            return
        kind = pressed.id.removeprefix("kind-")
        self.dismiss(kind)  # type: ignore[arg-type]

    def action_cancel(self) -> None:
        self.dismiss(None)
