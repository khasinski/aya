"""Smoke tests that boot the Textual app under Pilot.

We can't pipe interactive Claude/Codex sessions through CI, but we can verify:
  * The app composes without exceptions.
  * Project tabs render for configured projects.
  * The "+" sentinel tab is present.
  * Auto-spawn of a shell tab fires for a project that has no tabs yet.
"""

from __future__ import annotations

import json
import os

import pytest

from aya.app import AyaApp, SENTINEL_PANE_ID, ProjectView
from aya.sidebar import TabRow


@pytest.fixture
def tmp_projects(tmp_path, monkeypatch):
    projects_dir = tmp_path / "projects"
    projects_dir.mkdir()
    monkeypatch.setattr("aya.config.PROJECTS_DIR", projects_dir)
    # Make sure cwd matches the project's directory so the boot path doesn't
    # trigger the "unknown directory" modal that blocks the Pilot.
    project_dir = tmp_path / "work"
    project_dir.mkdir()
    monkeypatch.chdir(project_dir)
    payload = {
        "name": "Smoke",
        "directory": str(project_dir),
        "tabs": [],
    }
    (projects_dir / "smoke.json").write_text(json.dumps(payload))
    return projects_dir


@pytest.mark.asyncio
async def test_app_boots_with_project(tmp_projects):
    app = AyaApp()
    async with app.run_test() as pilot:
        await pilot.pause()
        tabbed = app.query_one("#projects")
        pane_ids = [p.id for p in tabbed.query("TabPane")]
        assert "pane-smoke" in pane_ids
        assert SENTINEL_PANE_ID in pane_ids
        # The "+" pane should be the last one (sentinel).
        assert pane_ids[-1] == SENTINEL_PANE_ID


@pytest.mark.asyncio
async def test_auto_shell_tab_spawned(tmp_projects):
    app = AyaApp()
    async with app.run_test() as pilot:
        await pilot.pause()
        view = app.query_one(ProjectView)
        # Auto-spawn behaviour: a project that boots with no saved tabs gets
        # one shell tab created automatically.
        rows = list(view.query(TabRow))
        assert len(rows) == 1, [r.tab.kind for r in rows]
        assert rows[0].tab.kind == "shell"
