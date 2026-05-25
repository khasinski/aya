"""Project configuration management.

Projects live in ~/.aya/projects/{slug}.json. Each file holds:
  {
    "name": "Display Name",
    "directory": "/abs/path",
    "tabs": [
      {"id": "...", "kind": "claude" | "codex" | "shell", "title": "..."}
    ]
  }
"""

from __future__ import annotations

import json
import os
import re
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Literal

TabKind = Literal["claude", "codex", "shell"]

PROJECTS_DIR = Path.home() / ".aya" / "projects"


def _slugify(name: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9_-]+", "-", name.strip().lower()).strip("-")
    return slug or "project"


@dataclass
class WorkingTab:
    id: str
    kind: TabKind
    title: str

    @staticmethod
    def new(kind: TabKind, title: str | None = None) -> "WorkingTab":
        return WorkingTab(id=uuid.uuid4().hex[:8], kind=kind, title=title or kind)


@dataclass
class Project:
    name: str
    directory: str
    slug: str = ""
    tabs: list[WorkingTab] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self.slug:
            self.slug = _slugify(self.name)

    @property
    def path(self) -> Path:
        return PROJECTS_DIR / f"{self.slug}.json"

    def save(self) -> None:
        PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
        payload = {
            "name": self.name,
            "directory": self.directory,
            "tabs": [asdict(t) for t in self.tabs],
        }
        self.path.write_text(json.dumps(payload, indent=2) + "\n")

    def delete(self) -> None:
        if self.path.exists():
            self.path.unlink()

    @classmethod
    def load(cls, slug: str) -> "Project":
        path = PROJECTS_DIR / f"{slug}.json"
        data = json.loads(path.read_text())
        return cls(
            name=data["name"],
            directory=data["directory"],
            slug=slug,
            tabs=[WorkingTab(**t) for t in data.get("tabs", [])],
        )


def list_projects() -> list[Project]:
    if not PROJECTS_DIR.exists():
        return []
    projects: list[Project] = []
    for path in sorted(PROJECTS_DIR.glob("*.json")):
        try:
            projects.append(Project.load(path.stem))
        except (OSError, json.JSONDecodeError, KeyError):
            continue
    return projects


RESERVED_SLUGS = frozenset({"aya-sentinel-new"})


def create_project(name: str, directory: str) -> Project:
    directory = os.path.abspath(os.path.expanduser(directory))
    project = Project(name=name, directory=directory)
    if project.slug in RESERVED_SLUGS:
        raise ValueError(f"Project name '{name}' produces a reserved slug; pick another name.")
    if project.path.exists():
        raise FileExistsError(f"Project '{project.slug}' already exists at {project.path}")
    project.save()
    return project
