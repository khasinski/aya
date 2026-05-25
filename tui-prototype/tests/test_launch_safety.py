"""Guards against accidentally launching Claude in non-interactive mode.

Running `claude -p` (or any `--print` / headless invocation) consumes API credits
and bypasses the subscription. This test fails loudly if anyone introduces a
forbidden flag into the launch path.
"""

from __future__ import annotations

import re
import subprocess

import pytest

from aya.app import _command_for


FORBIDDEN_FLAGS = [
    r"(?<!\w)-p(?!\w)",        # `-p` not part of a longer flag
    r"--print(?!\w)",          # `--print` (with or without =value)
    r"--headless(?!\w)",
    r"--non-interactive(?!\w)",
    r"--no-interactive(?!\w)",
]


@pytest.mark.parametrize("kind", ["claude", "codex", "shell"])
def test_command_is_interactive(kind):
    cmd = _command_for(kind, "/tmp/aya-test")
    for pattern in FORBIDDEN_FLAGS:
        assert not re.search(pattern, cmd), (
            f"Launch command for {kind!r} contains a forbidden non-interactive flag: {cmd!r}"
        )


@pytest.mark.parametrize("kind", ["claude", "codex"])
def test_command_exec_replaces_shell(kind):
    """The wrapper must `exec` the AI tool so the bash wrapper doesn't hang
    around as a parent process consuming a PID and reading stdin."""
    cmd = _command_for(kind, "/tmp/aya-test")
    assert "exec " in cmd, cmd


def test_bash_wrapper_runs():
    """Sanity: the wrapper shape we generate (without the AI tool) actually
    executes under /bin/bash -lc and exits cleanly."""
    cmd = "/bin/bash -lc 'cd /tmp && echo ok'"
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stderr
    assert "ok" in result.stdout
