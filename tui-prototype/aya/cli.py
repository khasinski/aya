"""CLI entrypoint."""

from __future__ import annotations

import argparse
import sys

from .app import AyaApp
from .config import create_project, list_projects


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="aya",
        description="Tabbed terminal IDE for AI-driven projects.",
    )
    sub = parser.add_subparsers(dest="cmd")

    sub.add_parser("run", help="Launch the IDE (default).")

    add_p = sub.add_parser("add", help="Create a new project.")
    add_p.add_argument("name", help="Display name for the project.")
    add_p.add_argument("directory", help="Project directory.")

    sub.add_parser("list", help="List configured projects.")

    args = parser.parse_args(argv)

    if args.cmd == "add":
        try:
            project = create_project(args.name, args.directory)
        except FileExistsError as err:
            print(err, file=sys.stderr)
            return 1
        print(f"Created project '{project.name}' ({project.slug}) at {project.directory}")
        print(f"Config: {project.path}")
        return 0

    if args.cmd == "list":
        projects = list_projects()
        if not projects:
            print("No projects configured. Run `aya` and press Ctrl+F4 to add one,")
            print("or use `aya add <name> <directory>`.")
            return 0
        for p in projects:
            print(f"  {p.slug:24}  {p.name:24}  {p.directory}")
        return 0

    AyaApp().run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
