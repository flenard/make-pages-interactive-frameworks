"""
Wire (or remove) the Claude Feedback library into a project.

Two strategies, auto-detected from the target directory:

  • static   — plain folder of *.html files. Injects <link>/<script> tags into
               every page (before </head>/</body>). Pages are served by
               lib/server.py, which also handles /feedback + history.json.

  • framework — Eleventy / Astro / Next.js. The built HTML is throwaway output,
               so instead we inject ONE dev-gated block into the project's base
               layout. The framework's own dev server renders + live-reloads the
               pages; lib/server.py runs as a sidecar API (CORS-enabled) that the
               tags point at via an absolute URL (data-cf-api / --api).
               The block is wrapped in the framework's dev guard so it never
               ships to production, and in <!-- cf-feedback-dev --> markers so it
               is idempotent and cleanly removable.

In both cases we create <root>/feedback/{inbox.jsonl,history.json} and add the
runtime feedback artifacts to .gitignore.

Usage:
    python inject.py <dir> [--framework auto|static|eleventy|astro|next]
                          [--api http://localhost:5050]
                          [--layout path/to/layout]   # override auto-detect
                          [--remove] [--recursive]
"""
import argparse
import hashlib
import json
import os
import re
import signal
import sys
from pathlib import Path

DEFAULT_API = "http://localhost:5050"
BLOCK_MARK = "cf-feedback-dev"  # inner anchor for idempotency + removal
REGISTRY_PATH = Path.home() / ".claude" / "cf-registry.json"


def stop_sidecar(root: Path) -> None:
    """Teardown helper: stop any live sidecar serving this project and drop its
    registry row, so --remove fully undoes the setup (tags + server + registry).
    Best-effort — never fatal."""
    try:
        reg = json.loads(REGISTRY_PATH.read_text())
    except Exception:
        return
    target = str(root.resolve())
    stopped = []
    for port, entry in list(reg.items()):
        if entry.get("dir") == target:
            pid = entry.get("pid")
            try:
                if pid:
                    os.kill(int(pid), signal.SIGTERM)  # server self-removes its row on SIGTERM
                    stopped.append(f":{port} (pid {pid})")
            except ProcessLookupError:
                pass  # already gone
            except Exception:
                continue
            reg.pop(port, None)
    if stopped:
        try:
            REGISTRY_PATH.write_text(json.dumps(reg, indent=2))
        except Exception:
            pass
        print(f"[teardown] stopped sidecar(s): {', '.join(stopped)}")


# ---------- project identity ----------
# A stable id per project so a page POSTing feedback can be matched to the right
# server/inbox/session. When several projects run at once (each its own port and
# Claude session), this turns a silent cross-wire into a loud 409 instead of
# feedback landing in the wrong session's inbox. Persisted to feedback/.cf-project
# so the id survives across re-injects and is shared with server.py.
def _slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return s or "project"


def project_id(root: Path) -> str:
    marker = root / "feedback" / ".cf-project"
    existing = _safe_read(marker).strip()
    if existing:
        return existing
    digest = hashlib.sha1(str(root.resolve()).encode("utf-8")).hexdigest()[:6]
    return f"{_slugify(root.name)}-{digest}"


def ensure_project_id(root: Path) -> str:
    """Return the project id, writing feedback/.cf-project if absent."""
    pid = project_id(root)
    marker = root / "feedback" / ".cf-project"
    marker.parent.mkdir(exist_ok=True)
    if not marker.exists():
        marker.write_text(pid + "\n", encoding="utf-8")
    return pid


def resolve_token(root: Path, cli_token: str) -> str:
    """Token precedence: --token wins (and is persisted); else reuse an existing
    feedback/.cf-token; else none. Shared with server.py via the same marker.
    The marker is a credential, so it's written owner-only (0600)."""
    marker = root / "feedback" / ".cf-token"
    if cli_token:
        marker.parent.mkdir(exist_ok=True)
        # O_CREAT with 0600 so the secret is never briefly world-readable; chmod
        # too in case the file already existed with looser perms.
        fd = os.open(str(marker), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(cli_token + "\n")
        try:
            os.chmod(marker, 0o600)
        except OSError:
            pass
        return cli_token
    return _safe_read(marker).strip()


# ---------- static-mode tags (same-origin; server.py serves /lib + /feedback) ----------
CSS_TAG = '<link rel="stylesheet" href="/lib/feedback.css">'

def _tok_attr(token: str) -> str:
    # Only emit data-cf-token when a token is actually set, so localhost-only
    # pages stay clean.
    return f' data-cf-token="{token}"' if token else ""

def js_tag(api: str, pid: str, token: str = "") -> str:
    return f'<script src="/lib/feedback.js" defer data-cf-api="{api}" data-cf-project="{pid}"{_tok_attr(token)}></script>'

CSS_MARKER = "/lib/feedback.css"
JS_MARKER = "/lib/feedback.js"

CSS_REMOVE_RE = re.compile(
    r'[ \t]*<link[^>]*href=["\']/lib/feedback\.css["\'][^>]*>\s*\n?', re.IGNORECASE
)
JS_REMOVE_RE = re.compile(
    r'[ \t]*<script[^>]*src=["\']/lib/feedback\.js["\'][^>]*></script>\s*\n?', re.IGNORECASE
)

# ---------- framework block builders (dev-gated) ----------
def block_eleventy(api: str, pid: str, token: str = "") -> str:
    return (
        f'{{% if eleventy.env.runMode == "serve" %}}<!-- {BLOCK_MARK} -->\n'
        f'  <link rel="stylesheet" href="{api}/lib/feedback.css">\n'
        f'  <script src="{api}/lib/feedback.js" defer data-cf-api="{api}" data-cf-project="{pid}"{_tok_attr(token)}></script>\n'
        f'  <!-- /{BLOCK_MARK} -->{{% endif %}}\n'
    )


def block_astro(api: str, pid: str, token: str = "") -> str:
    return (
        f'{{import.meta.env.DEV && (<>{{/* {BLOCK_MARK} */}}\n'
        f'  <link rel="stylesheet" href="{api}/lib/feedback.css" />\n'
        f'  <script is:inline defer src="{api}/lib/feedback.js" data-cf-api="{api}" data-cf-project="{pid}"{_tok_attr(token)}></script>\n'
        f'</>)}}\n'
    )


def block_next(api: str, pid: str, token: str = "") -> str:
    return (
        f'{{process.env.NODE_ENV === "development" && (<>{{/* {BLOCK_MARK} */}}\n'
        f'  {{/* eslint-disable-next-line @next/next/no-sync-scripts */}}\n'
        f'  <link rel="stylesheet" href="{api}/lib/feedback.css" />\n'
        f'  <script src="{api}/lib/feedback.js" defer data-cf-api="{api}" data-cf-project="{pid}"{_tok_attr(token)} />\n'
        f'</>)}}\n'
    )


BLOCK_REMOVE_RE = {
    "eleventy": re.compile(
        r'\{%\s*if eleventy\.env\.runMode == "serve" %\}<!-- ' + BLOCK_MARK
        + r' -->.*?<!-- /' + BLOCK_MARK + r' -->\{%\s*endif\s*%\}\n?',
        re.DOTALL,
    ),
    "astro": re.compile(
        r'\{import\.meta\.env\.DEV && \(<>\{/\* ' + BLOCK_MARK + r' \*/\}.*?</>\)\}\n?',
        re.DOTALL,
    ),
    "next": re.compile(
        r'\{process\.env\.NODE_ENV === "development" && \(<>\{/\* ' + BLOCK_MARK
        + r' \*/\}.*?</>\)\}\n?',
        re.DOTALL,
    ),
}
BLOCK_BUILD = {"eleventy": block_eleventy, "astro": block_astro, "next": block_next}


# ---------- framework detection ----------
def detect_framework(root: Path) -> str:
    if list(root.glob("astro.config.*")):
        return "astro"
    if list(root.glob("next.config.*")):
        return "next"
    if list(root.glob("eleventy.config.*")) or (root / ".eleventy.js").exists():
        return "eleventy"
    return "static"


def find_layout(root: Path, framework: str) -> tuple[Path | None, list[Path]]:
    """Return (chosen_layout, all_candidates). chosen is the best single guess;
    None means ambiguous/not-found and the caller should ask the user."""
    candidates: list[Path] = []
    if framework == "eleventy":
        for sub in ("src/_layouts", "src/_includes", "_layouts", "_includes", "src", "."):
            d = root / sub
            if d.is_dir():
                for ext in ("*.njk", "*.html", "*.liquid"):
                    candidates += [p for p in d.glob(ext) if "</body>" in _safe_read(p)]
    elif framework == "astro":
        for sub in ("src/layouts", "src/components", "src"):
            d = root / sub
            if d.is_dir():
                candidates += [p for p in d.rglob("*.astro") if "</body>" in _safe_read(p)]
    elif framework == "next":
        for rel in ("app/layout.tsx", "app/layout.jsx", "app/layout.js",
                    "src/app/layout.tsx", "src/app/layout.jsx", "src/app/layout.js",
                    "pages/_document.tsx", "pages/_document.jsx", "pages/_document.js",
                    "src/pages/_document.tsx", "src/pages/_document.jsx", "src/pages/_document.js"):
            p = root / rel
            if p.exists() and "</body>" in _safe_read(p):
                candidates.append(p)

    candidates = sorted(set(candidates))
    if not candidates:
        return None, []
    if len(candidates) == 1:
        return candidates[0], candidates
    # Heuristic: prefer a file whose name looks like the base/root layout.
    for pref in ("base", "layout", "root", "_document", "default", "main"):
        for c in candidates:
            if pref in c.stem.lower():
                return c, candidates
    return None, candidates  # ambiguous → let the agent pick


def _safe_read(p: Path) -> str:
    try:
        return p.read_text(encoding="utf-8")
    except Exception:
        return ""


# ---------- static injection (per *.html file) ----------
def inject_static_one(path: Path, pid: str, token: str = "") -> str:
    text = path.read_text(encoding="utf-8")
    changed = False
    notes = []
    css_present = CSS_MARKER in text
    js_present = JS_MARKER in text
    if not css_present:
        if "</head>" in text:
            text = text.replace("</head>", f"  {CSS_TAG}\n</head>", 1)
            changed = True
        else:
            notes.append("no </head>")
    if not js_present:
        if "</body>" in text:
            # static mode is same-origin → empty data-cf-api
            text = text.replace("</body>", f"  {js_tag('', pid, token)}\n</body>", 1)
            changed = True
        else:
            notes.append("no </body>")
    if changed:
        path.write_text(text, encoding="utf-8")
        status = "injected"
    elif css_present and js_present:
        status = "skipped (already wired)"
    else:
        status = "skipped (cannot wire)"
    if notes:
        status += " [" + ", ".join(notes) + "]"
    return status


def remove_static_one(path: Path) -> str:
    text = path.read_text(encoding="utf-8")
    new_text, n_css = CSS_REMOVE_RE.subn("", text)
    new_text, n_js = JS_REMOVE_RE.subn("", new_text)
    if n_css + n_js == 0:
        return "skipped (no tags)"
    path.write_text(new_text, encoding="utf-8")
    return f"removed ({n_css} css, {n_js} js)"


def find_html(root: Path, recursive: bool) -> list[Path]:
    if recursive:
        return sorted(p for p in root.rglob("*.html") if "feedback" not in p.parts)
    return sorted(root.glob("*.html"))


# ---------- framework injection (single base layout) ----------
def inject_framework(layout: Path, framework: str, api: str, pid: str, token: str = "") -> str:
    text = layout.read_text(encoding="utf-8")
    if BLOCK_MARK in text:
        return "skipped (already wired)"
    if "</body>" not in text:
        return "skipped (no </body> in layout)"
    block = BLOCK_BUILD[framework](api, pid, token)
    text = text.replace("</body>", block + "</body>", 1)
    layout.write_text(text, encoding="utf-8")
    return "injected"


def remove_framework(layout: Path, framework: str) -> str:
    text = layout.read_text(encoding="utf-8")
    new_text, n = BLOCK_REMOVE_RE[framework].subn("", text)
    if n == 0:
        return "skipped (no block)"
    layout.write_text(new_text, encoding="utf-8")
    return f"removed ({n} block)"


# ---------- shared setup ----------
def ensure_feedback_dir(root: Path) -> None:
    fb = root / "feedback"
    fb.mkdir(exist_ok=True)
    inbox = fb / "inbox.jsonl"
    if not inbox.exists():
        inbox.touch()
    history = fb / "history.json"
    if not history.exists():
        history.write_text("[]")
    notes = fb / "notes.json"
    if not notes.exists():
        notes.write_text("[]")


def ensure_gitignore(root: Path) -> None:
    gi = root / ".gitignore"
    entry = "\n# make-pages-interactive (local feedback runtime)\nfeedback/inbox.jsonl\nfeedback/history.json\nfeedback/notes.json\nfeedback/lastseen.json\nfeedback/.cf-project\nfeedback/.cf-token\n"
    existing = _safe_read(gi)
    if "make-pages-interactive" in existing or "feedback/inbox.jsonl" in existing:
        return
    with open(gi, "a", encoding="utf-8") as f:
        f.write(entry)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dir", help="project / artifact directory")
    ap.add_argument("--framework", choices=["auto", "static", "eleventy", "astro", "next"], default="auto")
    ap.add_argument("--api", default=DEFAULT_API, help=f"sidecar API base for framework mode (default {DEFAULT_API})")
    ap.add_argument("--token", default="", help="shared secret stamped as data-cf-token (use when the server is exposed beyond localhost). Persisted to feedback/.cf-token.")
    ap.add_argument("--layout", help="explicit base-layout path (override auto-detect)")
    ap.add_argument("--remove", action="store_true", help="strip the tags/block instead of injecting")
    ap.add_argument("--recursive", "-r", action="store_true", help="(static mode) walk subdirectories")
    args = ap.parse_args()

    root = Path(args.dir).resolve()
    if not root.is_dir():
        print(f"ERROR: {root} is not a directory", file=sys.stderr)
        return 1

    framework = detect_framework(root) if args.framework == "auto" else args.framework
    api = args.api.rstrip("/")

    # ---------------- STATIC ----------------
    if framework == "static":
        htmls = find_html(root, args.recursive)
        if not htmls:
            print(f"No *.html files found in {root} (and not a detected framework).")
            print("If this is an Eleventy/Astro/Next project, pass --framework or run from its root.")
            return 0
        verb = "Removing tags from" if args.remove else "Injecting tags into"
        print(f"[static] {verb} {len(htmls)} file(s) under {root}:")
        if args.remove:
            for p in htmls:
                print(f"  {p.relative_to(root)}: {remove_static_one(p)}")
            stop_sidecar(root)
            return 0
        ensure_feedback_dir(root)
        pid = ensure_project_id(root)
        token = resolve_token(root, args.token)
        for p in htmls:
            print(f"  {p.relative_to(root)}: {inject_static_one(p, pid, token)}")
        ensure_gitignore(root)
        print(f"\nFeedback dir ready: {root / 'feedback'}")
        print(f"Project id: {pid}")
        print(f"Next: python lib/server.py {root} --port 5050   (serves pages + feedback API)")
        print("Running several projects at once? Give each its own --port.")
        return 0

    # ---------------- FRAMEWORK ----------------
    if args.layout:
        layout = Path(args.layout).resolve()
        if not layout.exists():
            print(f"ERROR: --layout {layout} does not exist", file=sys.stderr)
            return 1
        candidates = [layout]
    else:
        layout, candidates = find_layout(root, framework)

    if layout is None:
        print(f"[{framework}] Could not pick a base layout automatically.")
        if candidates:
            print("Candidates (re-run with --layout <path>):")
            for c in candidates:
                print(f"  {c.relative_to(root)}")
        else:
            print("No layout containing </body> found. Point --layout at your root layout")
            print("(the template every page wraps — e.g. src/_layouts/base.njk,")
            print(" src/layouts/Base.astro, app/layout.tsx).")
        return 2  # signal "needs human/agent decision"

    if args.remove:
        status = remove_framework(layout, framework)
        print(f"[{framework}] {layout.relative_to(root)}: {status}")
        stop_sidecar(root)
        return 0

    ensure_feedback_dir(root)
    pid = ensure_project_id(root)
    token = resolve_token(root, args.token)
    status = inject_framework(layout, framework, api, pid, token)
    print(f"[{framework}] {layout.relative_to(root)}: {status}")
    ensure_gitignore(root)
    sidecar_port = api.rsplit(":", 1)[-1] if ":" in api else "5050"
    print(f"\nFeedback dir ready: {root / 'feedback'}")
    print(f"Project id: {pid}")
    print("Dev-gated block injected — it will NOT appear in production builds.")
    if api == DEFAULT_API:
        print(f"\n⚠  Using the default sidecar {DEFAULT_API}. Running several projects")
        print(f"   at once? Each needs its OWN port, or they collide on {sidecar_port} and")
        print(f"   feedback lands in the wrong session. Re-run with e.g.:")
        print(f"     python inject.py {root} --api http://localhost:5051")
    print("Next, run BOTH:")
    print(f"  1. your framework dev server (it serves + live-reloads the pages)")
    print(f"  2. python lib/server.py {root} --port {sidecar_port}   (feedback API sidecar)")
    print(f"Then open the framework dev-server URL (NOT the sidecar port).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
