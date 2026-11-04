#!/usr/bin/env python3
"""Real authenticated HTTP/SSE/PTY consumers; runs without DISPLAY on Linux/macOS."""
import http.client
import base64
import json
import os
from pathlib import Path
import queue
import shlex
import subprocess
import threading
import time
import unittest
import urllib.parse

import smoke

def terminal_bytes(value):
    if isinstance(value,list):
        return bytes(value)
    if isinstance(value,dict) and "__latticeBridgeBinary" in value:
        return base64.b64decode(value["__latticeBridgeBinary"],validate=True)
    return b""


class Events:
    def __init__(self, test, cookie, client, last_id=None):
        self.connection = http.client.HTTPConnection("127.0.0.1", test.port, timeout=30)
        headers = {"Cookie": cookie}
        if last_id:
            headers["Last-Event-ID"] = last_id
        self.connection.request("GET", "/api/events?client=" + client, headers=headers)
        self.response = self.connection.getresponse()
        assert self.response.status == 200
        self.messages = queue.Queue()
        self.closed = False
        self.last_id = last_id
        self.reader = threading.Thread(target=self.read, daemon=True)
        self.reader.start()
        self.next(lambda value: value.get("event") == "server-ready")

    def read(self):
        data, event_id = [], None
        try:
            while not self.closed:
                line = self.response.readline().decode().rstrip("\r\n")
                if line.startswith("id:"):
                    event_id = line[3:].strip()
                elif line.startswith("data:"):
                    data.append(line[5:].strip())
                elif not line and data:
                    self.messages.put((event_id, json.loads("\n".join(data))))
                    data, event_id = [], None
                elif not line and self.response.isclosed():
                    break
        except (OSError, ValueError, AttributeError, http.client.HTTPException):
            pass

    def next(self, predicate=lambda value: True, timeout=10):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            event_id, value = self.messages.get(timeout=max(.01, deadline - time.monotonic()))
            if event_id:
                self.last_id = event_id
            if predicate(value):
                return value
        raise AssertionError("SSE event did not arrive")

    def output_until(self, text, callback=42, timeout=10):
        output = b""
        deadline = time.monotonic() + timeout
        while text not in output.decode(errors="replace"):
            message = self.next(lambda value: value.get("callback") == callback, max(.01, deadline - time.monotonic()))
            payload = message["payload"]
            output += terminal_bytes(payload.get("message"))
        return output.decode(errors="replace")

    def close(self):
        self.closed = True
        # Shut down the socket to release an outstanding readline immediately.
        try:
            self.response.fp.raw._sock.shutdown(2)
        except (AttributeError, OSError):
            pass
        self.connection.close()


class TerminalSmoke(smoke.HeadlessSmoke):
    def setUp(self):
        self.terminal_cookie = self.login()
        self.client = "client-00000000-0000-0000-000000000001"
        self.streams = []

    def tearDown(self):
        self.request("DELETE", "/api/session", cookie=self.terminal_cookie)
        for events in self.streams:
            events.close()

    def events(self, client=None, cookie=None, last_id=None):
        events = Events(self, cookie or self.terminal_cookie, client or self.client, last_id)
        self.streams.append(events)
        return events

    def command(self, command, args=None, client=None, cookie=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=20)
        connection.request("POST", "/api/invoke", json.dumps({"command": command, "args": args or {}}), {
            "Content-Type": "application/json", "Cookie": cookie or self.terminal_cookie,
            "X-Lattice-Client": client or self.client,
        })
        response = connection.getresponse()
        result = response.status, json.loads(response.read())
        connection.close()
        return result

    def terminal(self, callback=42, client=None):
        status, result = self.command("terminal_open", {"projectRoot": str(self.workspace / "alpha"), "cols": 80, "rows": 24, "onOutput": f"__CHANNEL__:{callback}"}, client=client)
        self.assertEqual(status, 200, result)
        return result["result"]["id"]

    def type(self, terminal, text, client=None):
        result = self.command("terminal_write", {"id": terminal, "data": text}, client=client)
        self.assertEqual(result[0], 200, result)

    def test_terminal_requires_active_authenticated_tab_stream(self):
        status, _ = self.command("terminal_open", {"cols": 80, "rows": 24, "onOutput": "__CHANNEL__:42"})
        self.assertNotEqual(status, 200)
        self.events()
        terminal = self.terminal()
        self.assertEqual(self.command("terminal_write", {"id": terminal, "data": "ignored"}, client="client-00000000-0000-0000-000000000002")[0], 400)

    def test_terminal_runs_real_python_and_reports_exit_in_ordered_channel_envelopes(self):
        events = self.events()
        terminal = self.terminal()
        code = "import os,sys;print(''.join(map(chr,[80,84,89,95,82,69,65,68,89])));print(os.getcwd());sys.exit(7)"
        self.type(terminal, "exec python3 -c " + shlex.quote(code) + "\r")
        output, indexes = b"", []
        while True:
            message = events.next(lambda value: value.get("callback") == 42)["payload"]
            indexes.append(message["index"])
            value = message.get("message")
            if terminal_bytes(value):
                self.assertIn("__latticeBridgeBinary", value)
                output += terminal_bytes(value)
            elif isinstance(value, dict) and "exit" in value:
                self.assertEqual(value["exit"], 7)
                break
        self.assertEqual(indexes, list(range(len(indexes))))
        self.assertIn("PTY_READY", output.decode())
        self.assertIn(str(self.workspace / "alpha"), output.decode())
        end = events.next(lambda value: value.get("callback") == 42)["payload"]
        self.assertEqual(end, {"index": indexes[-1] + 1, "end": True})

    def test_same_cookie_tabs_keep_projects_assets_and_terminal_output_apart(self):
        events = self.events()
        other_client = "client-00000000-0000-0000-000000000002"
        other_events = self.events(client=other_client)
        self.assertEqual(self.command("open_project", {"path": str(self.workspace / "beta")}, client=other_client)[0], 200)
        self.assertEqual(Path(self.command("initial_project")[1]["result"]["root"]).name, "alpha")
        self.assertEqual(Path(self.command("initial_project", client=other_client)[1]["result"]["root"]).name, "beta")
        for client, name in [(self.client, "alpha"), (other_client, "beta")]:
            status, _, content = self.request("GET", "/api/asset?path=notes.md&client=" + client, cookie=self.terminal_cookie)
            self.assertEqual(status, 200)
            self.assertEqual(content, (self.workspace / name / "notes.md").read_bytes())
        terminal = self.terminal()
        self.type(terminal, "python3 -c 'print(chr(79)+chr(87)+chr(78)+chr(69)+chr(82))'\r")
        self.assertIn("OWNER", events.output_until("OWNER"))
        self.assertEqual(self.command("terminal_close", {"id": terminal}, client=other_client)[0], 400)
        time.sleep(.1)
        while not other_events.messages.empty():
            self.assertNotIn("callback", other_events.messages.get()[1])

    def test_terminal_resize_and_interrupt_reach_the_foreground_program(self):
        events = self.events()
        terminal = self.terminal()
        self.assertEqual(self.command("terminal_resize", {"id": terminal, "cols": 91, "rows": 33})[0], 200)
        code = "import os,time; s=os.get_terminal_size();print('SIZE%dX%d'%(s.columns,s.lines),flush=True);time.sleep(60)"
        self.type(terminal, "exec python3 -c " + shlex.quote(code) + "\r")
        self.assertIn("SIZE91X33", events.output_until("SIZE91X33"))
        self.type(terminal, "\x03")
        exited = events.next(lambda value: value.get("callback") == 42 and isinstance(value["payload"].get("message"), dict) and "exit" in value["payload"]["message"])
        self.assertIsNotNone(exited)

    def test_terminal_output_replays_across_a_short_sse_disconnect(self):
        events = self.events()
        terminal = self.terminal()
        self.type(terminal, "python3 -c 'print(chr(65)+chr(76)+chr(73)+chr(86)+chr(69))'\r")
        events.output_until("ALIVE")
        cursor = events.last_id
        events.close()
        self.type(terminal, "python3 -c 'print(chr(66)+chr(65)+chr(67)+chr(75))'\r")
        time.sleep(.1)
        resumed = self.events(last_id=cursor)
        self.assertIn("BACK", resumed.output_until("BACK"))

    def start_sleep(self, terminal, name):
        path = self.workspace / "alpha" / name
        code = f"import os,time;open({str(path)!r},'w').write(str(os.getpid()));time.sleep(60)"
        self.assertEqual(self.command("terminal_close",{"id":terminal})[0],200)
        status,result=self.command("terminal_run",{"projectRoot":str(self.workspace/"alpha"),"cols":80,"rows":24,"onOutput":"__CHANNEL__:43","program":"python3","args":["-c",code]})
        self.assertEqual(status,200,result)
        terminal=result["result"]["id"]
        for _ in range(100):
            if path.exists():
                return terminal,int(path.read_text())
            time.sleep(.05)
        self.fail("Terminal program did not start")

    def assert_stopped(self, pid, timeout=5):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            result = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True)
            if result.returncode or not result.stdout.strip() or result.stdout.strip().startswith("Z"):
                return
            time.sleep(.05)
        self.fail(f"Terminal program {pid} outlived its owner")

    def test_terminal_logout_revokes_and_ends_the_program(self):
        self.events()
        terminal = self.terminal()
        terminal,pid = self.start_sleep(terminal, "logout.pid")
        self.assertEqual(self.request("DELETE", "/api/session", cookie=self.terminal_cookie)[0], 204)
        self.assert_stopped(pid)
        self.assertEqual(self.command("terminal_write", {"id": terminal, "data": "x"})[0], 401)

    def test_terminal_disconnect_lease_ends_abandoned_program(self):
        events = self.events()
        terminal = self.terminal()
        terminal,pid = self.start_sleep(terminal, "lease.pid")
        events.close()
        self.assert_stopped(pid, timeout=15)

    def test_terminal_tab_limit_and_pinned_start(self):
        self.events()
        for _ in range(4):
            self.terminal()
        self.assertNotEqual(self.command("terminal_open", {"cols": 80, "rows": 24, "onOutput": "__CHANNEL__:99"})[0], 200)
        self.assertEqual(self.command("terminal_open", {"projectRoot": str(self.workspace / "beta"), "cols": 80, "rows": 24, "onOutput": "__CHANNEL__:98"})[0], 409)

    def test_terminal_server_sigterm_ends_a_running_program(self):
        class IsolatedService(smoke.HeadlessSmoke):
            pass
        IsolatedService.setUpClass()
        isolated = TerminalSmoke("test_terminal_logout_revokes_and_ends_the_program")
        isolated.port = IsolatedService.port
        isolated.workspace = IsolatedService.workspace
        isolated.terminal_cookie = IsolatedService.cookie
        isolated.client = self.client
        isolated.streams = []
        try:
            isolated.events()
            terminal = isolated.terminal()
            terminal,pid = isolated.start_sleep(terminal, "shutdown.pid")
            IsolatedService.server.terminate()
            self.assertEqual(IsolatedService.server.wait(timeout=10), 0)
            isolated.assert_stopped(pid)
        finally:
            for events in isolated.streams:
                events.close()
            IsolatedService.tearDownClass()

    def test_terminal_run_starts_literal_argv_without_a_login_shell(self):
        events=self.events()
        code="import json,os,sys;print('DIRECT_RUN:'+json.dumps(sys.argv[1:]));sys.exit(6)"
        literal="$(touch injected); quoted ' argument"
        status,result=self.command("terminal_run",{"projectRoot":str(self.workspace/"alpha"),"cols":80,"rows":24,"onOutput":"__CHANNEL__:42","program":"python3","args":["-c",code,literal]})
        self.assertEqual(status,200,result)
        output=b""
        while True:
            value=events.next(lambda value:value.get("callback")==42)["payload"].get("message")
            output+=terminal_bytes(value)
            if isinstance(value,dict) and "exit" in value:
                self.assertEqual(value["exit"],6)
                break
        self.assertIn(literal,output.decode())
        self.assertNotIn("Last login",output.decode())
        self.assertFalse((self.workspace/"alpha"/"injected").exists())
        self.assertNotEqual(self.command("terminal_run",{"cols":80,"rows":24,"onOutput":"__CHANNEL__:43","program":"/nonexistent/lattice-test-program","args":[]})[0],200)


if __name__ == "__main__":
    unittest.main()
