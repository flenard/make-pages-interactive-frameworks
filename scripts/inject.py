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
import re
import sys
from pathlib import Path

DEFAULT_API = "http://localhost:5050"
BLOCK_MARK = "cf-feedback-dev"  # inner anchor for idempotency + removal

# ---------- static-mode tags (same-origin; server.py serves /lib + /feedback) ----------
CSS_TAG = '<link rel="stylesheet" href="/lib/feedback.css">'
JS_TAG = '<script src="/lib/feedback.js" defer data-cf-api=""></script>'
CSS_MARKER = "/lib/feedback.css"
JS_MARKER = "/lib/feedback.js"

CSS_REMOVE_RE = re.compile(
    r'[ \t]*<link[^>]*href=["\']/lib/feedback\.css["\'][^>]*>\s*\n?', re.IGNORECASE
)
JS_REMOVE_RE = re.compile(
    r'[ \t]*<script[^>]*src=["\']/lib/feedback\.js["\'][^>]*></script>\s*\n?', re.IGNORECASE
)

# ---------- framework block builders (dev-gated) ----------
def block_eleventy(api: str) -> str:
    return (
        f'{{% if eleventy.env.runMode == "serve" %}}<!-- {BLOCK_MARK} -->\n'
        f'  <link rel="stylesheet" href="{api}/lib/feedback.css">\n'
        f'  <script src="{api}/lib/feedback.js" defer data-cf-api="{api}"></script>\n'
        f'  <!-- /{BLOCK_MARK} -->{{% endif %}}\n'
    )


def block_astro(api: str) -> str:
    return (
        f'{{import.meta.env.DEV && (<>{{/* {BLOCK_MARK} */}}\n'
        f'  <link rel="stylesheet" href="{api}/lib/feedback.css" />\n'
        f'  <script is:inline defer src="{api}/lib/feedback.js" data-cf-api="{api}"></script>\n'
        f'</>)}}\n'
    )


def block_next(api: str) -> str:
    return (
        f'{{process.env.NODE_ENV === "development" && (<>{{/* {BLOCK_MARK} */}}\n'
        f'  {{/* eslint-disable-next-line @next/next/no-sync-scripts */}}\n'
        f'  <link rel="stylesheet" href="{api}/lib/feedback.css" />\n'
        f'  <script src="{api}/lib/feedback.js" defer data-cf-api="{api}" />\n'
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
def inject_static_one(path: Path) -> str:
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
            text = text.replace("</body>", f"  {JS_TAG}\n</body>", 1)
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
def inject_framework(layout: Path, framework: str, api: str) -> str:
    text = layout.read_text(encoding="utf-8")
    if BLOCK_MARK in text:
        return "skipped (already wired)"
    if "</body>" not in text:
        return "skipped (no </body> in layout)"
    block = BLOCK_BUILD[framework](api)
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


def ensure_gitignore(root: Path) -> None:
    gi = root / ".gitignore"
    entry = "\n# make-pages-interactive (local feedback runtime)\nfeedback/inbox.jsonl\nfeedback/history.json\nfeedback/lastseen.json\n"
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
        action = remove_static_one if args.remove else inject_static_one
        verb = "Removing tags from" if args.remove else "Injecting tags into"
        print(f"[static] {verb} {len(htmls)} file(s) under {root}:")
        for p in htmls:
            print(f"  {p.relative_to(root)}: {action(p)}")
        if not args.remove:
            ensure_feedback_dir(root)
            ensure_gitignore(root)
            print(f"\nFeedback dir ready: {root / 'feedback'}")
            print(f"Next: python lib/server.py {root} --port 5050   (serves pages + feedback API)")
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
        return 0

    status = inject_framework(layout, framework, api)
    print(f"[{framework}] {layout.relative_to(root)}: {status}")
    ensure_feedback_dir(root)
    ensure_gitignore(root)
    print(f"\nFeedback dir ready: {root / 'feedback'}")
    print("Dev-gated block injected — it will NOT appear in production builds.")
    print("Next, run BOTH:")
    print(f"  1. your framework dev server (it serves + live-reloads the pages)")
    print(f"  2. python lib/server.py {root} --port {api.rsplit(':', 1)[-1] if ':' in api else '5050'}   (feedback API sidecar)")
    print(f"Then open the framework dev-server URL (NOT the sidecar port).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
