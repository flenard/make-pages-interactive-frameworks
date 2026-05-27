---
name: make-pages-interactive
description: Turn a website into a live in-page commenting surface so the user can highlight text / click elements / drop notes directly on the rendered page, and the agent reads those comments and edits the source. Works on plain static HTML AND on Eleventy, Astro, and Next.js projects (dev-server companion mode). Trigger phrases — "make this page interactive", "make these pages interactive", "let me comment on this page", "add feedback to these pages", "make the site interactive".
---

# Make Pages Interactive (multi-framework fork)

Lets the user leave inline comments on a rendered page (text selections, element
selections, page-level notes). Comments POST to a local JSONL inbox; you (the
agent) Monitor that inbox, edit the **source**, append to `feedback/history.json`,
and the page reloads with a walkthrough of what changed.

> This is a fork of github.com/paraschopra/make-pages-interactive. The upstream
> assumes the file you view is the file you edit (plain static HTML). This fork
> adds **framework mode** for Eleventy / Astro / Next.js, where the served HTML
> is throwaway build output and real edits go to source templates.

## Two architectures (pick by detecting the project)

| | **Static** | **Framework (Eleventy / Astro / Next.js)** |
|---|---|---|
| Detect | folder of `*.html`, no framework config | `astro.config.*` / `next.config.*` / `eleventy.config.*` or `.eleventy.js` |
| What serves the pages | `lib/server.py` | the **framework's own dev server** (keeps live-reload) |
| Where tags are injected | every `*.html` (before `</head>`/`</body>`) | **once** into the base layout, **dev-gated** |
| What `server.py` does | serves pages **and** feedback API | runs as a **sidecar API only** (`/feedback`, `/feedback/history.json`, `/lib/*`) |
| You edit | the `.html` files | the **source templates** (`.njk` / `.astro` / `.tsx`) — never `_site`/`dist`/`.next` |

`scripts/inject.py` auto-detects which one and does the right thing.

## When to invoke

- "make this/these page(s) interactive", "add feedback", "let me comment on this page", "make the site interactive" → **Setup flow**
- "stop the feedback server" / "kill the server" → **Stop flow**
- "remove the feedback layer" / "make it static again" → **Removal flow**

## Setup flow

1. **Identify the target directory** (usually cwd or a folder the user named). If ambiguous, ask.
2. **Wire it up** (auto-detects static vs framework):
   ```
   python ~/.claude/skills/make-pages-interactive/scripts/inject.py <dir>
   ```
   - Add `--recursive` for static sites with pages in subfolders.
   - Force a mode with `--framework static|eleventy|astro|next` if detection is wrong.
   - Idempotent. Creates `<dir>/feedback/{inbox.jsonl,history.json}` and updates `.gitignore`.
   - **Exit code 2** = framework detected but the base layout was ambiguous. The
     script prints candidates; re-run with `--layout <path>` pointing at the root
     layout (the template every page wraps — e.g. `src/_layouts/base.njk`,
     `src/layouts/Base.astro`, `app/layout.tsx`).
3. **Pick the sidecar port (default 5050).** Check it first:
   ```
   curl -s --max-time 2 http://localhost:5050/info
   ```
   - JSON with `artifact_dir` matching this `<dir>` → reuse, skip to 5.
   - JSON with a *different* `artifact_dir` → port taken; use 5051/5052… (and pass `--api http://localhost:<port>` to inject.py so the tags match).
   - No response → 5050 is free.
4. **Start the sidecar** via Bash with `run_in_background: true`:
   ```
   python ~/.claude/skills/make-pages-interactive/lib/server.py <dir> --port <chosen>
   ```
   Auto-shuts-down on parent death or 10 min idle.
5. **Get the page in front of the user:**
   - **Static** → tell them the sidecar URL, e.g. `http://localhost:5050/index.html`.
   - **Framework** → start the project's **own dev server** (`npx @11ty/eleventy --serve`, `npm run dev` for Astro/Next — check `package.json` scripts) in the background, and give them **that** URL (e.g. `http://localhost:4321`, `:8080`, `:3000`). The feedback widget loads from the sidecar via the absolute `data-cf-api` URL; pages come from the framework. Do **not** send them to the sidecar port for framework projects.
6. **Monitor the inbox** so new comments notify you immediately:
   ```
   Monitor on path: <dir>/feedback/inbox.jsonl
   ```
   Do NOT poll — let the Monitor notification arrive.

## Responding to a feedback batch

When a new batch lands in `inbox.jsonl`:
- Read the entry. Each comment carries `cf_id`, `selector`, `tag`, `id`, `text_snippet`, and truncated `outer_html` — enough to locate the region.
- **Map rendered element → source.** This is the key framework skill: the comment describes the *rendered* DOM, but you edit the *source template*. Use `text_snippet` / `outer_html` / `id` to grep the source (`src/**`, components, content collections) for the matching markup. For repeated components, disambiguate with surrounding text and the user's comment. Never edit `_site/`, `dist/`, or `.next/`.
- Make the edit in source. Wrap each changed region with `<span data-cf-change="ch-<slug>">…</span>` (or add `data-cf-change="ch-<slug>"` to an existing wrapping element) so the post-reload tour can find it. One anchor per change. (These attributes render through to output fine in `.njk`/`.astro`/`.jsx`.)
- **Append** a batch object to `<dir>/feedback/history.json` (newest = last; the library walks from the end):
  ```json
  {
    "batch_id": "b-<timestamp-or-slug>",
    "timestamp": "<ISO 8601>",
    "comments": [ /* echo back the inbox comments you addressed */ ],
    "changes": [
      {
        "id": "ch-<slug>",
        "in_response_to": ["<cf_id / comment id from inbox>"],
        "anchor": "ch-<slug>",
        "title": "short, concrete",
        "description": "longer prose (kept for the record)"
      }
    ]
  }
  ```
- Framework dev servers live-reload on the source edit; the page also polls `history.json`, sees the new batch, and offers the walkthrough. Static pages reload via the poll. Scroll position is preserved.

## On startup in a directory that already has feedback

If `<dir>/feedback/inbox.jsonl` + `history.json` exist:
1. Scan inbox for comment ids.
2. Union of history's `changes[*].in_response_to` = already processed.
3. If unprocessed comments remain, tell the user the count and ask whether to process now.
4. Set up the Monitor either way.

## Stop flow

1. Find the sidecar port (you know it if you started it; else `curl -s http://localhost:5050/info`, try 5051/5052).
2. `lsof -ti:<port> | xargs kill` (`-9` only if a plain kill doesn't free it).
3. Also stop the framework dev server you backgrounded, if any.
4. Confirm `lsof -i :<port>` is silent.

Usually no manual stop is needed — the sidecar auto-exits on parent death or 10 min idle.

## Removal flow (clean, production-safe)

```
python ~/.claude/skills/make-pages-interactive/scripts/inject.py <dir> --remove
```
- Static → strips the tags from every `*.html`.
- Framework → removes the dev-gated block from the base layout (auto-detected, or pass `--layout`).
Leaves `feedback/` alone (delete manually if unwanted). Note the framework block is dev-gated anyway, so it never reached production.

## Files

```
~/.claude/skills/make-pages-interactive/
├── SKILL.md          # this file
├── LICENSE
├── lib/
│   ├── feedback.js   # client lib; API base read from data-cf-api (forked)
│   ├── feedback.css
│   └── server.py     # stdlib HTTP server / sidecar API (unchanged, CORS-enabled)
└── scripts/
    ├── inject.py     # framework-aware inject/remove (forked)
    └── update.py     # fork notice (no auto-update)
```

## Gotchas

- **Framework mode = run BOTH servers.** Framework dev server renders pages; Python sidecar handles feedback I/O. Send the user to the **framework** URL.
- The widget loads from `<api>/lib/feedback.js` and talks to `<api>/feedback`. The sidecar sends `Access-Control-Allow-Origin: *`, so cross-port works. If the widget never appears in framework mode: the sidecar isn't running, or `--api` didn't match the sidecar port.
- The injected framework block is **dev-gated** (`eleventy.env.runMode == "serve"` / `import.meta.env.DEV` / `process.env.NODE_ENV === "development"`) — it is absent from production builds by construction.
- Edit **source**, never build output (`_site`, `dist`, `.next`). Editing output is wiped on the next build.
- `history.json` order matters: **append**, don't prepend.
- `anchor` values must match a `data-cf-change` actually present in the rendered HTML, or you get "anchor not found" after reload.
- Astro `<script>` tags are bundled by default — the injected loader uses `is:inline` so Astro leaves the external sidecar URL alone.
```
