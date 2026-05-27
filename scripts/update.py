"""
This is a LOCAL FORK of make-pages-interactive with multi-framework support
(static HTML + Eleventy + Astro + Next.js). It is not a git checkout, so there
is no upstream to pull from without losing the framework patches.

Upstream (single static-HTML version):
    https://github.com/paraschopra/make-pages-interactive

To compare against upstream, clone it elsewhere and diff lib/ + scripts/.
"""
import sys
from pathlib import Path

SKILL_DIR = Path(__file__).resolve().parent.parent


def main() -> int:
    print("This is a local fork (static + Eleventy/Astro/Next). No auto-update.")
    print(f"Skill dir: {SKILL_DIR}")
    print("Upstream:  https://github.com/paraschopra/make-pages-interactive")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
