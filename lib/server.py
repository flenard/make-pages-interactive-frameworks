"""
Tiny single-file server for the Claude Feedback library.

Serves a directory of HTML artifacts AND accepts comment-batch submissions from
the in-page library. Submissions are appended to <artifact>/feedback/inbox.jsonl
where Claude (the agent) can pick them up, process them, and append to
<artifact>/feedback/history.json. The page polls history.json to detect new
changes and offer a walkthrough.

Usage:
    python lib/server.py <artifact_dir> [--port 5050]

There are NO dependencies beyond the Python standard library.
"""
import argparse
import http.server
import json
import mimetypes
import os
import socket
import socketserver
import sys
import threading
import time
from pathlib import Path
from urllib.parse import urlparse

# ---------- cross-session registry ----------
# Every live sidecar records itself here so any Claude Code session (or you) can
# answer "what's wired where right now?" without curling /info across a port
# range. Keyed by port. Best-effort: written atomically, cleaned on exit.
REGISTRY_PATH = Path.home() / ".claude" / "cf-registry.json"
LOCK_PATH = REGISTRY_PATH.with_suffix(".lock")


def _read_registry() -> dict:
    try:
        return json.loads(REGISTRY_PATH.read_text())
    except Exception:
        return {}


def _mutate_registry(fn) -> None:
    """Locked read-modify-write so concurrent server starts don't clobber each
    other's entry (flock serializes them). Best-effort: never fatal."""
    try:
        import fcntl
        REGISTRY_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(LOCK_PATH, "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            reg = _read_registry()
            reg = fn(reg)
            tmp = REGISTRY_PATH.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(reg, indent=2))
            tmp.replace(REGISTRY_PATH)
            fcntl.flock(lock, fcntl.LOCK_UN)
    except Exception:
        pass


def _pid_alive(pid) -> bool:
    try:
        os.kill(int(pid), 0)
    except ProcessLookupError:
        return False
    except (PermissionError, ValueError, TypeError):
        return True  # exists but not ours, or unparseable → assume alive
    return True


def _registry_put(port: int, entry: dict) -> None:
    def f(reg):
        reg[str(port)] = entry
        return reg
    _mutate_registry(f)


def _registry_remove(port: int) -> None:
    def f(reg):
        reg.pop(str(port), None)
        return reg
    _mutate_registry(f)


def _registry_prune() -> dict:
    """Drop entries whose process is gone (kill -9 / crash can't self-clean) and
    return the live set."""
    live = {}
    def f(reg):
        nonlocal live
        live = {p: e for p, e in reg.items() if _pid_alive(e.get("pid"))}
        return live
    _mutate_registry(f)
    return live


def _port_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((host, port))
            return True
        except OSError:
            return False


def _find_free_port(host: str, start: int, span: int = 25) -> int | None:
    for p in range(start, start + span):
        if _port_free(host, p):
            return p
    return None

# Project-root lib directory (where this file lives). The server serves
# /lib/<file> from here so artifacts can <script src="/lib/feedback.js">
# instead of inlining — library updates apply on a simple page refresh.
LIB_DIR = Path(__file__).resolve().parent

# ---------- Auto-shutdown bookkeeping ----------
# Servers launched as Claude Code background tasks would otherwise outlive the
# session (orphaned to launchd/init) and accumulate. Two complementary checks:
#   1. parent-death — if our parent process exits, we get reparented to PID 1.
#      Skip this watchdog if we were already detached at startup (e.g. nohup).
#   2. idle timeout — the page polls every ~4s, so any live browser keeps us
#      alive. When no requests have arrived for IDLE_TIMEOUT_S, exit.
INITIAL_PPID = os.getppid()
_activity_lock = threading.Lock()
_last_activity = time.monotonic()


def _touch_activity():
    global _last_activity
    with _activity_lock:
        _last_activity = time.monotonic()


def _idle_seconds():
    with _activity_lock:
        return time.monotonic() - _last_activity


def _with_charset(content_type: str) -> str:
    """Append `; charset=utf-8` to text-ish content types when missing. Without
    this, browsers fall back to Latin-1 and emojis / non-ASCII glyphs garble."""
    if not content_type:
        return content_type
    needs = (
        content_type.startswith("text/")
        or content_type in ("application/javascript", "application/json", "application/xml")
    )
    if needs and "charset=" not in content_type.lower():
        return f"{content_type}; charset=utf-8"
    return content_type


class FeedbackHandler(http.server.SimpleHTTPRequestHandler):
    feedback_dir: Path = None  # type: ignore
    artifact_dir: Path = None  # type: ignore
    project_id: str = ""       # type: ignore
    token: str = ""            # type: ignore

    # ---------- override caching: dev server should never cache ----------
    def end_headers(self):
        # Any response is proof of a live client — push the idle deadline back.
        _touch_activity()
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def guess_type(self, path):
        # SimpleHTTPRequestHandler uses this to set Content-Type. Force UTF-8
        # for text/*, JS, JSON so emojis and non-ASCII glyphs render correctly.
        return _with_charset(super().guess_type(path))

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/info":
            # Diagnostic endpoint: lets other Claude Code sessions detect what
            # this server is serving so they know whether to reuse or take over.
            info = {
                "artifact_dir": str(self.artifact_dir),
                "feedback_dir": str(self.feedback_dir),
                "lib_dir": str(LIB_DIR),
                "port": self.server.server_address[1],
                "project_id": self.project_id,
                "host": self.server.server_address[0],
                "auth": bool(self.token),
            }
            self._json(200, info)
            return
        if parsed.path.startswith("/lib/"):
            self._serve_from_lib(parsed.path[len("/lib/"):])
            return
        super().do_GET()

    def _serve_from_lib(self, rel: str):
        # Path-traversal-safe lookup inside LIB_DIR
        try:
            target = (LIB_DIR / rel).resolve()
        except Exception:
            self.send_error(404); return
        if not str(target).startswith(str(LIB_DIR) + os.sep) and target != LIB_DIR:
            self.send_error(403, "forbidden"); return
        if not target.exists() or not target.is_file():
            self.send_error(404); return
        mime, _ = mimetypes.guess_type(str(target))
        if mime is None:
            mime = "application/octet-stream"
        mime = _with_charset(mime)
        body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/feedback":
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length).decode("utf-8") if length else ""
            try:
                data = json.loads(body)
            except json.JSONDecodeError:
                self._json(400, {"ok": False, "error": "invalid json"})
                return
            # Auth gate (only active when started with --token, i.e. exposed
            # beyond localhost). Without a matching X-CF-Token, reject — the
            # inbox drives source edits, so it must not accept untrusted input.
            if self.token:
                sent = self.headers.get("X-CF-Token") or data.get("token") or ""
                if sent != self.token:
                    self._json(401, {"ok": False, "error": "missing or invalid token"})
                    return
            # Reject feedback wired to a different project so a cross-wired page
            # (e.g. data-cf-api pointing at the wrong port) fails loudly instead
            # of silently landing in this session's inbox. A post with no id is
            # an older/static page → accept for back-compat.
            posted_id = self.headers.get("X-CF-Project") or data.get("project") or ""
            if self.project_id and posted_id and posted_id != self.project_id:
                sys.stdout.write(
                    f"[feedback] REJECTED project mismatch: page='{posted_id}' "
                    f"server='{self.project_id}'\n"
                )
                sys.stdout.flush()
                self._json(409, {
                    "ok": False,
                    "error": "project mismatch",
                    "expected": self.project_id,
                    "got": posted_id,
                    "port": self.server.server_address[1],
                })
                return
            data["received_at"] = time.time()
            data["received_iso"] = time.strftime("%Y-%m-%dT%H:%M:%S")
            inbox = self.feedback_dir / "inbox.jsonl"
            with open(inbox, "a") as f:
                f.write(json.dumps(data) + "\n")
            sys.stdout.write(f"[feedback] batch with {len(data.get('comments', []))} comment(s) -> {inbox}\n")
            sys.stdout.flush()
            self._json(200, {"ok": True})
            return

        if parsed.path == "/mark-seen":
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length).decode("utf-8") if length else ""
            try:
                data = json.loads(body)
            except json.JSONDecodeError:
                data = {}
            seen_path = self.feedback_dir / "lastseen.json"
            seen_path.write_text(json.dumps(data, indent=2))
            self._json(200, {"ok": True})
            return

        self._json(404, {"ok": False, "error": "unknown endpoint"})

    def _json(self, status: int, payload: dict):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # Silence the default request logging — too noisy for our purposes.
    def log_message(self, format, *args):
        # Only log POSTs and errors
        if args and (args[0].startswith("POST") or " 4" in " ".join(map(str, args)) or " 5" in " ".join(map(str, args))):
            sys.stderr.write("%s - %s\n" % (self.address_string(), format % args))


def _watchdog(idle_timeout_s: int, cleanup=None):
    """Daemon thread: terminate the server when (a) the parent process dies,
    or (b) no client has hit us for idle_timeout_s. Polls every 5s. Uses
    os._exit because srv.shutdown() can hang on the per-request thread join
    that ThreadingTCPServer.server_close() does by default — and for a dev
    server graceful close has no upside."""
    watch_parent = (INITIAL_PPID != 1)
    while True:
        time.sleep(5)
        reason = None
        if watch_parent and os.getppid() == 1:
            reason = "parent process exited"
        elif idle_timeout_s > 0 and _idle_seconds() > idle_timeout_s:
            reason = f"idle for >{idle_timeout_s}s with no clients"
        if reason:
            sys.stdout.write(f"[server] {reason}; shutting down\n")
            sys.stdout.flush()
            if cleanup:
                cleanup()  # os._exit skips atexit — drop our registry entry here
            os._exit(0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("artifact_dir", nargs="?", help="directory containing the HTML artifact")
    ap.add_argument("--port", type=int, default=5050)
    ap.add_argument("--host", default="127.0.0.1",
                    help="bind address. Default 127.0.0.1 (localhost only). Use 0.0.0.0 to expose on the LAN (pair with --token).")
    ap.add_argument("--token", default="",
                    help="require this shared secret on POSTs (X-CF-Token). Auto-loaded from feedback/.cf-token if present. Use when --host is non-localhost.")
    ap.add_argument("--auto-port", action="store_true",
                    help="if --port is taken, bind the next free port instead of failing (static mode only — framework pages bake the port into data-cf-api).")
    ap.add_argument("--list", action="store_true",
                    help="print the live-sidecar registry (~/.claude/cf-registry.json) and exit.")
    ap.add_argument("--idle-timeout", type=int, default=600,
                    help="exit if no client requests for this many seconds (0 = disable). Default 600 (10 min).")
    args = ap.parse_args()

    if args.list:
        reg = _registry_prune()  # self-heal: drop entries whose process is gone
        if not reg:
            print("(no live sidecars registered)")
        else:
            for port in sorted(reg, key=lambda p: int(p)):
                e = reg[port]
                print(f"  :{port}  {e.get('project_id','?'):24}  {e.get('dir','?')}  (pid {e.get('pid','?')}, host {e.get('host','?')})")
        return
    if not args.artifact_dir:
        ap.error("artifact_dir is required (unless --list)")

    artifact_dir = Path(args.artifact_dir).resolve()
    if not artifact_dir.exists():
        print(f"ERROR: {artifact_dir} does not exist")
        sys.exit(1)

    feedback_dir = artifact_dir / "feedback"
    feedback_dir.mkdir(exist_ok=True)
    inbox = feedback_dir / "inbox.jsonl"
    if not inbox.exists():
        inbox.touch()
    history = feedback_dir / "history.json"
    if not history.exists():
        history.write_text("[]")
    notes = feedback_dir / "notes.json"
    if not notes.exists():
        notes.write_text("[]")

    # Project id: shared with inject.py via feedback/.cf-project. Derived
    # deterministically from the artifact path if the marker is absent, so the
    # server and the injected page agree even if inject.py ran on another run.
    marker = feedback_dir / ".cf-project"
    if marker.exists():
        project_id = marker.read_text(encoding="utf-8").strip()
    else:
        import hashlib, re
        slug = re.sub(r"[^a-z0-9]+", "-", artifact_dir.name.lower()).strip("-") or "project"
        project_id = f"{slug}-{hashlib.sha1(str(artifact_dir).encode()).hexdigest()[:6]}"
        marker.write_text(project_id + "\n", encoding="utf-8")

    # Token: CLI flag wins; otherwise auto-load feedback/.cf-token (written by
    # inject.py --token). Empty → auth disabled (fine for localhost-only).
    token = args.token.strip()
    if not token:
        tok_marker = feedback_dir / ".cf-token"
        if tok_marker.exists():
            token = tok_marker.read_text(encoding="utf-8").strip()

    FeedbackHandler.feedback_dir = feedback_dir
    FeedbackHandler.artifact_dir = artifact_dir
    FeedbackHandler.project_id = project_id
    FeedbackHandler.token = token

    os.chdir(artifact_dir)

    # socketserver.TCPServer doesn't reuse the port quickly enough — subclass:
    class ReuseTCP(socketserver.ThreadingTCPServer):
        allow_reuse_address = True
        # Per-request handler threads are daemon so they don't block process
        # exit if a client connection lingers.
        daemon_threads = True

    port = args.port
    if args.auto_port and not _port_free(args.host, port):
        free = _find_free_port(args.host, port)
        if free is None:
            print(f"[server] FATAL: no free port in {port}..{port + 24}")
            sys.exit(1)
        print(f"[server] port {port} taken; --auto-port → using {free}")
        port = free

    try:
        srv = ReuseTCP((args.host, port), FeedbackHandler)
    except OSError as e:
        print(f"[server] FATAL: port {port} is unavailable ({e}).")
        print(f"[server]  - check what's running there:  curl -s http://localhost:{port}/info")
        print(f"[server]  - or kill it:                  lsof -ti:{port} | xargs kill")
        print(f"[server]  - or run me on a different port: --port {port + 1}  (or --auto-port)")
        sys.exit(1)

    # Register this live sidecar so other sessions can discover it; clean up on
    # any exit path (atexit covers normal/KeyboardInterrupt; the watchdog calls
    # it explicitly before os._exit).
    _registry_put(port, {
        "project_id": project_id,
        "dir": str(artifact_dir),
        "pid": os.getpid(),
        "host": args.host,
        "auth": bool(token),
        "started": time.strftime("%Y-%m-%dT%H:%M:%S"),
    })
    cleanup = lambda: _registry_remove(port)
    import atexit, signal
    atexit.register(cleanup)
    # atexit doesn't fire on SIGTERM (the usual `kill`) — clean up explicitly.
    signal.signal(signal.SIGTERM, lambda *_: (cleanup(), os._exit(0)))

    # Auto-shutdown so servers don't accumulate across Claude Code sessions.
    threading.Thread(
        target=_watchdog, args=(args.idle_timeout, cleanup), daemon=True
    ).start()

    with srv:
        print(f"[server] serving {artifact_dir}")
        print(f"[server] project: {project_id}  host: {args.host}  auth: {'on' if token else 'off'}")
        print(f"[server] open http://localhost:{port}/sample.html")
        print(f"[server] inbox:   {inbox}")
        print(f"[server] history: {history}")
        print(f"[server] info:    http://localhost:{port}/info")
        if args.host not in ("127.0.0.1", "localhost") and not token:
            print(f"[server] ⚠  exposed on {args.host} with NO token — anyone on the network can POST feedback. Use --token.")
        if args.idle_timeout > 0:
            print(f"[server] auto-shutdown: parent-death OR {args.idle_timeout}s idle (no requests). --idle-timeout 0 to disable")
        else:
            print(f"[server] auto-shutdown: parent-death only (idle timeout disabled)")
        print(f"[server] Ctrl-C to stop")
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            print("\n[server] stopping")


if __name__ == "__main__":
    main()
