"""Regression tests for bursty node updates on the VPS Agent.

Load just the scheduling helpers from agent.py so tests never touch /opt/kui,
start services, or need real panel credentials.
"""
import ast
import json
import os
from pathlib import Path
import tempfile
from typing import Any
from types import SimpleNamespace
import unittest


SOURCE = Path(__file__).resolve().parents[1] / "vendor/K-UI/vps/agent.py"
HELPERS = {"wait_for_config_wakeup", "pace_singbox_restart"}


class FakeClock:
    def __init__(self):
        self.now = 0.0

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        assert seconds >= 0
        self.now += seconds


class FakeEvent:
    def __init__(self, clock, signals):
        self.clock = clock
        self.signals = list(signals)
        self.pending = False

    def wait(self, timeout):
        if self.pending:
            return True
        if self.signals and self.signals[0] <= self.clock.now + timeout:
            self.clock.now = max(self.clock.now, self.signals.pop(0))
            self.pending = True
            return True
        self.clock.now += timeout
        return False

    def clear(self):
        self.pending = False


class AgentSyncTests(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        tree = ast.parse(SOURCE.read_text())
        functions: list[ast.stmt] = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in HELPERS]
        self.assertEqual({node.name for node in functions if isinstance(node, ast.FunctionDef)}, HELPERS)
        namespace: dict[str, Any] = {"time": self.clock}
        exec(compile(ast.Module(body=functions, type_ignores=[]), str(SOURCE), "exec"), namespace)
        self.wait = namespace["wait_for_config_wakeup"]
        self.pace = namespace["pace_singbox_restart"]

    def test_burst_coalesces_into_one_fetch(self):
        event = FakeEvent(self.clock, [0, 0.5, 1.0, 1.5])
        self.assertTrue(self.wait(event, 60, quiet_seconds=2, max_wait=10))
        self.assertAlmostEqual(self.clock.now, 3.5)
        self.assertFalse(event.pending)
        self.assertEqual(event.signals, [])

    def test_continuous_refreshes_cannot_starve_fetch(self):
        event = FakeEvent(self.clock, list(range(30)))
        self.assertTrue(self.wait(event, 60, quiet_seconds=2, max_wait=10))
        self.assertLessEqual(self.clock.now, 10)
        self.assertTrue(event.signals)

    def test_timeout_remains_periodic_fallback(self):
        event = FakeEvent(self.clock, [])
        self.assertFalse(self.wait(event, 30, quiet_seconds=2, max_wait=10))
        self.assertEqual(self.clock.now, 30)

    def test_restart_spacing_survives_many_updates(self):
        last = None
        starts = []
        for _ in range(8):
            last = self.pace(last, min_interval=5)
            starts.append(last)
        self.assertEqual(starts, [0, 5, 10, 15, 20, 25, 30, 35])

    def test_helpers_are_connected_to_the_live_agent(self):
        tree = ast.parse(SOURCE.read_text())
        functions = {node.name: node for node in tree.body if isinstance(node, ast.FunctionDef)}
        applies = [node for node in ast.walk(functions["build_singbox_config"])
                   if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                   and node.func.id == "pace_singbox_restart"]
        self.assertEqual(len(applies), 3, "primary restart, rollback and failed-service recovery must be paced")
        loop = next(node for node in tree.body if isinstance(node, ast.If)
                    and isinstance(node.test, ast.Compare) and isinstance(node.test.left, ast.Name)
                    and node.test.left.id == "__name__")
        waits = [node for node in ast.walk(loop) if isinstance(node, ast.Call)
                 and isinstance(node.func, ast.Name) and node.func.id == "wait_for_config_wakeup"]
        self.assertEqual(len(waits), 1)

    def test_unchanged_config_only_starts_failed_service_and_paces_retries(self):
        tree = ast.parse(SOURCE.read_text())
        build = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                     and node.name == "build_singbox_config")
        calls = []
        healthy = [False]

        def fake_run(argv, **_kwargs):
            if argv[0] == "systemctl" and argv[1] in {"restart", "start"}:
                calls.append((argv[1], self.clock.now))
                healthy[0] = True
            return SimpleNamespace(returncode=0, stderr="")

        with tempfile.TemporaryDirectory() as directory:
            runtime_os = SimpleNamespace(path=os.path, makedirs=os.makedirs,
                                         chmod=os.chmod, replace=os.replace,
                                         remove=os.remove, listdir=lambda _path: [])
            namespace: dict[str, Any] = {
                "os": runtime_os, "json": json, "time": self.clock,
                "shutil": SimpleNamespace(which=lambda _name: "/fake/sing-box"),
                "subprocess": SimpleNamespace(run=fake_run, DEVNULL=-1),
                "SINGBOX_CONF_PATH": str(Path(directory) / "config.json"),
                "proxy_port_conflict": None, "last_singbox_restart_at": None,
                "pace_singbox_restart": self.pace,
                "_singbox_service_healthy": lambda: healthy[0],
            }
            exec(compile(ast.Module(body=[build], type_ignores=[]), str(SOURCE), "exec"), namespace)
            apply = namespace["build_singbox_config"]
            apply([])
            self.assertEqual(calls, [("restart", 0)])
            apply([])
            self.assertEqual(calls, [("restart", 0)], "healthy unchanged config should be a no-op")
            healthy[0] = False
            apply([])
            healthy[0] = False
            apply([])
            self.assertEqual(calls, [("restart", 0), ("start", 5), ("start", 10)])


if __name__ == "__main__":
    unittest.main()
