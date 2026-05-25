"""Main Aya application.

Layout:
  +----------------------------------------------------------+
  | Header                                                   |
  +----------------------------------------------------------+
  | [Project A] [Project B] [+]   (top tabs: projects)       |
  +-----------------------------------------------+----------+
  |                                               | shell    |
  |                                               | claude   |
  |          Active embedded terminal             | codex    |
  |                                               |          |
  |                                               | +Shell   |
  |                                               | +Claude  |
  |                                               | +Codex   |
  +-----------------------------------------------+----------+
  | F-key bindings hints                                     |
  +----------------------------------------------------------+
"""

from __future__ import annotations

import os
import shlex
from pathlib import Path
from typing import cast

from textual import on
from textual.app import App, ComposeResult
from textual.binding import Binding
from textual.containers import Container, Vertical
from textual.widgets import (
    ContentSwitcher,
    Footer,
    Header,
    Label,
    TabbedContent,
    TabPane,
)

from .config import Project, TabKind, WorkingTab, create_project, list_projects
from .screens import NewProjectScreen
from .sidebar import QuickAdd, QuickAddBar, TabClose, TabRow, TabSwitch
from .terminal import Terminal


# Sentinel ID for the "+" project tab. Project panes are "pane-<slug>"; the
# matching reserved slug is blocked in config.create_project so no user-named
# project can ever shadow this id.
SENTINEL_PANE_ID = "pane-aya-sentinel-new"
SENTINEL_SLUG = "aya-sentinel-new"


def _command_for(kind: TabKind, cwd: str) -> str:
    """Build the interactive invocation for a tab kind.

    Wrapped in `/bin/bash -lc` so the login shell sets up PATH (mise, brew, etc.)
    before exec'ing the target. NEVER pass -p, --print, or any headless flag —
    that would break the Claude subscription license.
    """
    cwd_quoted = shlex.quote(cwd)
    if kind == "claude":
        inner = "exec claude"
    elif kind == "codex":
        inner = "exec codex"
    elif kind == "shell":
        inner = f"exec {shlex.quote(_login_shell())}"
    else:
        raise ValueError(f"unknown tab kind: {kind}")
    return f"/bin/bash -lc {shlex.quote(f'cd {cwd_quoted} && {inner}')}"


def _login_shell() -> str:
    return os.environ.get("SHELL", "/bin/zsh")


class ProjectView(Container):
    """One project's pane: working-tab sidebar on the left, terminal stack on the right."""

    DEFAULT_CSS = """
    ProjectView {
        layout: horizontal;
        height: 1fr;
    }
    ProjectView > #sidebar {
        width: 32;
        height: 1fr;
        background: $panel;
        border-right: tall $primary 50%;
    }
    ProjectView #sidebar-header {
        height: 4;
        background: $primary;
        color: $background;
        padding: 1 1;
    }
    ProjectView #sidebar-title {
        height: 1;
        text-style: bold;
    }
    ProjectView #sidebar-subtitle {
        height: 1;
        color: $background 70%;
    }
    ProjectView #tabs-list {
        height: 1fr;
        background: $panel;
        overflow-y: auto;
        padding-top: 1;
    }
    ProjectView > ContentSwitcher.term-area {
        width: 1fr;
        height: 1fr;
        border: round $primary 50%;
        padding: 0;
    }
    ProjectView > ContentSwitcher.term-area:focus-within {
        border: round $accent;
    }
    """

    def __init__(self, project: Project) -> None:
        super().__init__(id=f"project-{project.slug}")
        self.project = project

    def compose(self) -> ComposeResult:
        with Vertical(id="sidebar"):
            with Vertical(id="sidebar-header"):
                yield Label(self.project.name, id="sidebar-title")
                yield Label(self._compact_dir(self.project.directory), id="sidebar-subtitle")
            yield Container(id="tabs-list")
            yield QuickAddBar()
        yield ContentSwitcher(
            initial=None,
            id=f"switcher-{self.project.slug}",
            classes="term-area",
        )

    @staticmethod
    def _compact_dir(directory: str) -> str:
        home = str(Path.home())
        if directory == home:
            return "~"
        if directory.startswith(home + os.sep):
            return "~" + directory[len(home):]
        return directory

    @property
    def _switcher(self) -> ContentSwitcher:
        return self.query_one(f"#switcher-{self.project.slug}", ContentSwitcher)

    @property
    def _tabs_list(self) -> Container:
        return self.query_one("#tabs-list", Container)

    def on_mount(self) -> None:
        # Restore tabs persisted in config.
        for tab in self.project.tabs:
            self._mount_tab(tab, start=True, persist=False)
        if self.project.tabs:
            self._set_active_tab(self.project.tabs[0].id)
        else:
            # Auto-start a shell so the user can do something immediately.
            self.add_tab("shell")

    # Tab management -----------------------------------------------------------

    def add_tab(self, kind: TabKind) -> WorkingTab:
        tab = WorkingTab.new(kind, title=self._unique_title(kind))
        self.project.tabs.append(tab)
        self._mount_tab(tab, start=True, persist=True)
        self._set_active_tab(tab.id)
        return tab

    def _mount_tab(self, tab: WorkingTab, *, start: bool, persist: bool) -> None:
        terminal = Terminal(
            command=_command_for(tab.kind, self.project.directory),
            cwd=self.project.directory,
            id=f"term-{tab.id}",
        )
        self._switcher.mount(terminal)
        if start:
            terminal.start()
        self._tabs_list.mount(TabRow(tab))
        if persist:
            self.project.save()

    def _set_active_tab(self, tab_id: str) -> None:
        self._switcher.current = f"term-{tab_id}"
        for row in self._tabs_list.query(TabRow):
            row.set_active(row.tab.id == tab_id)
        # Focus the terminal so keypresses go to it.
        self.app.call_after_refresh(self._focus_active_terminal)

    def _focus_active_terminal(self) -> None:
        if self._switcher.current is None:
            return
        try:
            term = self.query_one(f"#{self._switcher.current}", Terminal)
            term.focus()
        except Exception:
            pass

    def close_tab_by_id(self, tab_id: str) -> None:
        # Stop and remove the Terminal widget.
        try:
            terminal = self.query_one(f"#term-{tab_id}", Terminal)
            terminal.stop()
            terminal.remove()
        except Exception:
            pass
        # Remove the sidebar row.
        try:
            row = self.query_one(f"#row-{tab_id}", TabRow)
            row.remove()
        except Exception:
            pass
        # Drop from config.
        self.project.tabs = [t for t in self.project.tabs if t.id != tab_id]
        self.project.save()
        # Activate another tab, or spawn a fresh shell if none remain.
        if self.project.tabs:
            self._set_active_tab(self.project.tabs[-1].id)
        else:
            self._switcher.current = None
            self.add_tab("shell")

    def close_current_tab(self) -> None:
        current = self._switcher.current
        if current is None:
            return
        self.close_tab_by_id(current.removeprefix("term-"))

    def show_tab_by_id(self, tab_id: str) -> None:
        self._set_active_tab(tab_id)

    def next_tab(self) -> None:
        self._cycle_tab(1)

    def prev_tab(self) -> None:
        self._cycle_tab(-1)

    def _cycle_tab(self, delta: int) -> None:
        if not self.project.tabs or self._switcher.current is None:
            return
        ids = [t.id for t in self.project.tabs]
        idx = ids.index(self._switcher.current.removeprefix("term-"))
        self._set_active_tab(ids[(idx + delta) % len(ids)])

    def _unique_title(self, kind: TabKind) -> str:
        base = kind.title()
        existing = {t.title for t in self.project.tabs}
        if base not in existing:
            return base
        i = 2
        while f"{base} {i}" in existing:
            i += 1
        return f"{base} {i}"

    # Message handlers ---------------------------------------------------------

    @on(TabSwitch)
    def _on_tab_switch(self, message: TabSwitch) -> None:
        self.show_tab_by_id(message.tab_id)

    @on(TabClose)
    def _on_tab_close(self, message: TabClose) -> None:
        self.close_tab_by_id(message.tab_id)

    @on(QuickAdd)
    def _on_quick_add(self, message: QuickAdd) -> None:
        self.add_tab(message.kind)

    @on(Terminal.Exited)
    def _on_terminal_exited(self, message: Terminal.Exited) -> None:
        term_id = message.terminal.id or ""
        if term_id.startswith("term-"):
            self.close_tab_by_id(term_id.removeprefix("term-"))


class AyaApp(App):
    """The Aya tabbed-terminal IDE."""

    CSS = """
    Screen {
        background: $background;
    }
    TabbedContent {
        height: 1fr;
    }
    """

    BINDINGS = [
        Binding("ctrl+f1", "blur_terminal", "Unfocus", show=True),
        Binding("ctrl+f2", "new_tab_menu", "New tab", show=True),
        Binding("ctrl+f3", "close_tab", "Close tab", show=True),
        Binding("ctrl+f4", "new_project", "New project", show=True),
        Binding("ctrl+f5", "prev_project", "Prev project", show=False),
        Binding("ctrl+f6", "next_project", "Next project", show=False),
        Binding("ctrl+f7", "prev_tab", "Prev tab", show=False),
        Binding("ctrl+f8", "next_tab", "Next tab", show=False),
        Binding("ctrl+f12", "quit", "Quit", show=True),
    ]

    TITLE = "Aya"

    def __init__(self) -> None:
        super().__init__()
        self._previous_active_pane: str | None = None

    def compose(self) -> ComposeResult:
        yield Header(show_clock=False)
        yield TabbedContent(id="projects")
        yield Footer()

    async def on_mount(self) -> None:
        projects = list_projects()
        tabbed = self._tabbed
        for project in projects:
            await tabbed.add_pane(
                TabPane(project.name, ProjectView(project), id=f"pane-{project.slug}")
            )
        # Sentinel "+" pane: clicking it opens the new-project modal.
        await tabbed.add_pane(
            TabPane("＋ New project", Label("", classes="placeholder"), id=SENTINEL_PANE_ID)
        )

        cwd = os.path.abspath(os.getcwd())
        cwd_project = next((p for p in projects if p.directory == cwd), None)
        if cwd_project is not None:
            tabbed.active = f"pane-{cwd_project.slug}"
            self._previous_active_pane = tabbed.active
        elif projects:
            tabbed.active = f"pane-{projects[0].slug}"
            self._previous_active_pane = tabbed.active
            # cwd is unknown — offer to add a project here.
            self.call_after_refresh(self._start_cwd_modal, cwd, True)
        else:
            # No projects at all — must create one.
            self.call_after_refresh(self._start_cwd_modal, cwd, False)

    def _start_cwd_modal(self, cwd: str, has_others: bool) -> None:
        """Kick off the unknown-cwd modal as a worker.

        Run via call_after_refresh so the initial mount is complete first.
        """
        self.run_worker(self._offer_cwd_project(cwd, has_others=has_others))

    # Helpers ------------------------------------------------------------------

    @property
    def _tabbed(self) -> TabbedContent:
        return self.query_one("#projects", TabbedContent)

    def _active_project_view(self) -> ProjectView | None:
        active = self._tabbed.active
        if not active or active == SENTINEL_PANE_ID:
            return None
        try:
            return self._tabbed.query_one(f"#{active}", TabPane).query_one(ProjectView)
        except Exception:
            return None

    async def _add_project(self, project: Project) -> None:
        await self._tabbed.add_pane(
            TabPane(project.name, ProjectView(project), id=f"pane-{project.slug}"),
            before=SENTINEL_PANE_ID,
        )
        self._tabbed.active = f"pane-{project.slug}"
        self._previous_active_pane = self._tabbed.active

    async def _offer_cwd_project(self, cwd: str, *, has_others: bool) -> None:
        default_name = os.path.basename(cwd.rstrip(os.sep)) or "project"
        hint = (
            f"This directory isn't a known project. Start one here?"
            if has_others
            else "Welcome! Create your first project to get started."
        )
        result = await self.push_screen_wait(
            NewProjectScreen(
                title="Start a project here",
                hint=hint,
                default_name=default_name,
                default_directory=cwd,
                lock_directory=True,
            )
        )
        if not result:
            if not has_others:
                # No projects and user cancelled — nothing to show. Quit.
                self.exit()
            return
        name, directory = result
        try:
            project = create_project(name, directory)
        except FileExistsError as err:
            self.notify(str(err), severity="error")
            return
        await self._add_project(project)

    # Project tab events -------------------------------------------------------

    @on(TabbedContent.TabActivated)
    async def _on_project_changed(self, event: TabbedContent.TabActivated) -> None:
        pane_id = event.pane.id
        if pane_id == SENTINEL_PANE_ID:
            # Bounce back to the previous active pane, then open the modal.
            if self._previous_active_pane and self._previous_active_pane != SENTINEL_PANE_ID:
                self._tabbed.active = self._previous_active_pane
            self.run_worker(self.action_new_project, exclusive=True)
            return
        self._previous_active_pane = pane_id
        # Focus the project's active terminal when switching projects.
        view = self._active_project_view()
        if view is not None:
            self.call_after_refresh(view._focus_active_terminal)

    # Actions ------------------------------------------------------------------

    def action_blur_terminal(self) -> None:
        self.set_focus(None)

    async def action_new_project(self) -> None:
        cwd = os.path.abspath(os.getcwd())
        default_name = os.path.basename(cwd.rstrip(os.sep)) or "project"
        result = await self.push_screen_wait(
            NewProjectScreen(default_name=default_name, default_directory=cwd)
        )
        if not result:
            return
        name, directory = result
        try:
            project = create_project(name, directory)
        except FileExistsError as err:
            self.notify(str(err), severity="error")
            return
        await self._add_project(project)

    def action_new_tab_menu(self) -> None:
        """Ctrl+F2 default: add a shell tab. (Mouse: use sidebar +Shell/+Claude/+Codex.)"""
        view = self._active_project_view()
        if view is None:
            self.notify("No active project.", severity="warning")
            return
        view.add_tab("shell")

    def action_close_tab(self) -> None:
        view = self._active_project_view()
        if view is not None:
            view.close_current_tab()

    def action_prev_project(self) -> None:
        self._cycle_project(-1)

    def action_next_project(self) -> None:
        self._cycle_project(1)

    def _cycle_project(self, delta: int) -> None:
        tabbed = self._tabbed
        ids = [
            p.id
            for p in tabbed.query(TabPane)
            if p.id and p.id != SENTINEL_PANE_ID
        ]
        if not ids or not tabbed.active or tabbed.active == SENTINEL_PANE_ID:
            return
        idx = ids.index(tabbed.active)
        tabbed.active = ids[(idx + delta) % len(ids)]

    def action_prev_tab(self) -> None:
        view = self._active_project_view()
        if view is not None:
            view.prev_tab()

    def action_next_tab(self) -> None:
        view = self._active_project_view()
        if view is not None:
            view.next_tab()
