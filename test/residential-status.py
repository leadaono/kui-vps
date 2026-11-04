"""Pure scheduling regressions for residential SOCKS subscription visibility.

Extract only two helpers from lite_manager.py; importing the full manager would
start root-only runtime dependencies and use live network/tunnel state.
"""
import ast
from contextlib import nullcontext
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any
import unittest

SOURCE = Path(__file__).resolve().parents[1] / "vendor/K-UI/vps/lite_manager.py"
HELPERS = {"proxy_report_signature", "should_send_http_status"}


class ResidentialStatusTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        tree = ast.parse(SOURCE.read_text())
        functions: list[ast.stmt] = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in HELPERS]
        assert {n.name for n in functions if isinstance(n, ast.FunctionDef)} == HELPERS
        namespace: dict[str, Any] = {"REALTIME_HTTP_INTERVAL": 300, "HTTP_CHANGE_MIN_INTERVAL": 15}
        exec(compile(ast.Module(body=functions, type_ignores=[]), str(SOURCE), "exec"), namespace)
        cls.signature = staticmethod(namespace["proxy_report_signature"])
        cls.should_send = staticmethod(namespace["should_send_http_status"])
        cls.loop = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "c2_heartbeat_loop")

    def test_signature_ignores_uptime_and_report_logs_but_tracks_active_endpoint(self):
        active = {"tunnel": "tun_main", "active": True, "country": "JP", "port": 7920,
                  "node_ip": "198.51.100.1", "connected_time": 10}
        first = self.signature([active])
        self.assertEqual(first, self.signature([{**active, "connected_time": 500}]))
        self.assertNotEqual(first, self.signature([{**active, "active": False}]))
        self.assertNotEqual(first, self.signature([{**active, "node_ip": "198.51.100.2"}]))
        self.assertNotEqual(first, self.signature([{**active, "port": 7921}]))

    def test_first_active_report_immediately_after_empty_boot_report(self):
        empty = self.signature([])
        active = self.signature([{"tunnel": "tun_main", "active": True, "port": 7920}])
        self.assertTrue(self.should_send(1001, active, empty, 1000, 1000, empty, True, False, False))

    def test_failed_first_active_report_is_rate_limited_then_retried(self):
        empty = self.signature([])
        active = self.signature([{"tunnel": "tun_main", "active": True, "port": 7920}])
        self.assertFalse(self.should_send(1002, active, empty, 1000, 1001, active, True, False, True))
        self.assertTrue(self.should_send(1016, active, empty, 1000, 1001, active, True, False, True))
        other = self.signature([{"tunnel": "tun_backup", "active": True, "port": 7920}])
        self.assertFalse(self.should_send(1002, other, empty, 1000, 1001, active, True, False, True),
                         "alternate failed ACTIVE states must not bypass the retry limit")

    def test_repeated_loss_and_recovery_cannot_repeat_first_active_exception(self):
        empty = self.signature([])
        active = self.signature([{"tunnel": "tun_main", "active": True, "port": 7920}])
        self.assertFalse(self.should_send(1017, active, empty, 1016, 1016, empty, True, False, True))
        self.assertTrue(self.should_send(1031, active, empty, 1016, 1016, empty, True, False, True))

    def test_switch_and_active_loss_update_after_short_throttle(self):
        main = self.signature([{"tunnel": "tun_main", "active": True, "port": 7920}])
        backup = self.signature([{"tunnel": "tun_backup", "active": True, "port": 7920}])
        empty = self.signature([])
        self.assertFalse(self.should_send(1005, backup, main, 1000, 1000, main, True, False, True))
        self.assertTrue(self.should_send(1015, backup, main, 1000, 1000, main, True, False, True))
        self.assertTrue(self.should_send(1015, empty, main, 1000, 1000, main, True, False, True))

    def test_five_minute_fallback_and_disconnected_retry(self):
        empty = self.signature([])
        self.assertFalse(self.should_send(1299, empty, empty, 1000, 1000, empty, True, False, False))
        self.assertTrue(self.should_send(1300, empty, empty, 1000, 1000, empty, True, False, False))
        self.assertFalse(self.should_send(1001, empty, empty, 1000, 1000, empty, False, False, False))
        self.assertTrue(self.should_send(1015, empty, empty, 1000, 1000, empty, False, True, False))

    def test_live_loop_uses_scheduler_and_commits_only_successful_reports(self):
        names = [n.func.id for n in ast.walk(self.loop) if isinstance(n, ast.Call)
                 and isinstance(n.func, ast.Name)]
        self.assertIn("proxy_report_signature", names)
        self.assertIn("should_send_http_status", names)
        source = ast.get_source_segment(SOURCE.read_text(), self.loop)
        self.assertIsNotNone(source)
        assert source is not None
        self.assertIn("last_persisted_signature = signature", source)
        self.assertIn("last_attempt_signature = signature", source)
        self.assertIn("REALTIME_HTTP_INTERVAL = 300", SOURCE.read_text())
        self.assertIn("REALTIME_CONFIG_INTERVAL = 900", SOURCE.read_text())
        self.assertIn("config_wakeup.wait(timeout=REALTIME_CONFIG_INTERVAL", SOURCE.read_text())

    def test_live_loop_persists_first_active_without_waiting_five_minutes(self):
        clock = [1000.0]
        main = SimpleNamespace(name="tun_main", ready=False, process=SimpleNamespace(poll=lambda: None),
                               connected_at=1000, country="JP", egress_ip="198.51.100.1",
                               entry_ip="198.51.100.1")
        backup = SimpleNamespace(name="tun_backup", ready=False, process=None)
        sent = []

        class StopLoop(Exception):
            pass

        class Event:
            calls = 0

            def clear(self):
                pass

            def wait(self, timeout):
                self.calls += 1
                if self.calls == 1:
                    main.ready = True
                    clock[0] += 1
                else:
                    raise StopLoop

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, _size):
                return b"O"

        def urlopen(request, timeout):
            sent.append(json.loads(request.data))
            return Response()

        tree = ast.parse(SOURCE.read_text())
        functions: list[ast.stmt] = [n for n in tree.body if isinstance(n, ast.FunctionDef)
                                     and n.name in HELPERS | {"c2_heartbeat_loop"}]
        namespace: dict[str, Any] = {
            "REALTIME_HTTP_INTERVAL": 300, "HTTP_CHANGE_MIN_INTERVAL": 15,
            "last_http_report": 0, "last_http_attempt": 0,
            "last_attempt_signature": None, "last_persisted_signature": None,
            "first_active_report_attempted": False,
            "public_ip": "141.148.242.134", "PROXY_PORT": 7920,
            "tun_main": main, "tun_backup": backup, "state_lock": nullcontext(),
            "proxy_server": SimpleNamespace(ACTIVE_BIND="tun_main"),
            "get_recent_logs": lambda: "", "VPS_IP": "141.148.242.134",
            "realtime_channel": SimpleNamespace(connected=True, enabled=True, send=lambda status: True,
                                                last_disconnected=0, started_at=0),
            "time": SimpleNamespace(time=lambda: clock[0]), "heartbeat_wakeup": Event(),
            "realtime_status_interval": 5,
            "urllib": SimpleNamespace(request=SimpleNamespace(Request=lambda url, **kw: SimpleNamespace(data=kw["data"]),
                                                       urlopen=urlopen)),
            "json": json, "C2_URL": "https://example.invalid", "C2_API_PREFIX": "/api/proxy",
            "get_c2_headers": lambda: {},
        }
        exec(compile(ast.Module(body=functions, type_ignores=[]), str(SOURCE), "exec"), namespace)
        with self.assertRaises(StopLoop):
            namespace["c2_heartbeat_loop"]()
        self.assertEqual([len(item["details"]) for item in sent], [0, 1])
        self.assertTrue(sent[1]["details"][0]["active"])
        self.assertEqual(namespace["last_http_report"], 1001)
        self.assertTrue(namespace["first_active_report_attempted"])


if __name__ == "__main__":
    unittest.main()
