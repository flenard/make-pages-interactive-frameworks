/*
 * Claude Feedback — drop-in in-page review library.
 *
 * Two modes for attaching a comment to a region of the page:
 *
 *   (1) Text-selection mode (always on): highlight any text. A "💬 comment"
 *       pill appears below the selection. Click it to open the editor.
 *
 *   (2) Element-selection mode (toggle): click the "select element" button in
 *       the panel. Hover any commentable element (images, tables, figures,
 *       paragraphs, sections, list items) to outline it. Click to select.
 *       Shift-click to add more elements to the selection. A floating popup
 *       gives you "comment" and "clear" buttons. Press Esc or toggle off to exit.
 *
 *   (3) General questions: "+ general" in the panel adds a comment that isn't
 *       tied to any region.
 *
 * Each comment carries rich anchor info so the agent can find the exact
 * region later: stable CSS selector, auto-assigned data-cf-id, element tag,
 * text snippet, and truncated outerHTML.
 *
 * The page polls feedback/history.json. New entries appear as inline
 * highlights and in the History tab; the agent attaches data-cf-change="ch-N"
 * markers in the HTML which the library uses for the "tour" walkthrough.
 */
(function () {
  if (window.__claudeFeedbackInit) return;
  window.__claudeFeedbackInit = true;

  // ---------------- Constants ----------------
  const LS_KEY = "cf-state-v1";
  // API base lets a framework dev server (Astro/Eleventy/Next) serve the pages
  // on one port while feedback I/O goes to the Python sidecar on another. Read
  // from the loader tag: <script src=".../feedback.js" data-cf-api="http://localhost:5050">.
  // Empty / absent → same-origin (plain static-HTML mode, served by server.py).
  // Resolve the loader <script> once so API base and project id come from the
  // same tag.
  const LOADER = document.currentScript
    || document.querySelector("script[data-cf-api]")
    || document.querySelector('script[src*="feedback.js"]');
  const API_BASE = (function () {
    const v = LOADER && LOADER.getAttribute("data-cf-api");
    return v ? v.replace(/\/+$/, "") : "";
  })();
  // Stable per-project id stamped by inject.py. Sent with every batch so the
  // server can reject feedback wired to the wrong project/port instead of it
  // landing in the wrong Claude session's inbox.
  const PROJECT_ID = (LOADER && LOADER.getAttribute("data-cf-project")) || "";
  // Optional shared secret, only present when the server runs non-localhost
  // (--host + --token). Sent as X-CF-Token; the server 401s without it.
  const CF_TOKEN = (LOADER && LOADER.getAttribute("data-cf-token")) || "";
  const HISTORY_URL = API_BASE + "/feedback/history.json";
  const NOTES_URL = API_BASE + "/feedback/notes.json";
  const FEEDBACK_URL = API_BASE + "/feedback";
  const POLL_INTERVAL_MS = 4000;
  // One-tap chips that prefill the editor with common feedback, so you don't
  // retype "too big" for the hundredth time. They append (don't replace) so you
  // can stack/qualify them, then edit.
  const QUICK_REACTIONS = [
    "👍 looks good", "too big", "too small", "wrong colour",
    "move up", "move down", "tighten spacing", "needs more contrast",
  ];
  const OUTER_HTML_MAX = 600;
  const TEXT_SNIPPET_MAX = 220;

  // Selectors that we consider "commentable" — i.e. you can click them in
  // element-selection mode. Anything that's a meaningful block of content.
  const COMMENTABLE_TAGS = new Set([
    "P", "H1", "H2", "H3", "H4", "H5", "H6",
    "UL", "OL", "LI", "DL",
    "TABLE", "TR",
    "FIGURE", "IMG", "SVG", "CANVAS", "VIDEO",
    "BLOCKQUOTE", "PRE",
    // Layout / semantic containers — without these, generic wrapper blocks
    // (the bulk of most pages) can't be selected and clicks snap to the wrong
    // ancestor. findCommentableAncestor returns the NEAREST match walking up,
    // so granularity stays tight (you get the clicked block, not the body).
    // Supersedes the earlier landmark-only addition + COMMENTABLE_CLASSES grid
    // list: the any-class gate in isCommentable() covers those cases generally.
    "SECTION", "ARTICLE", "DIV", "MAIN", "HEADER", "FOOTER", "NAV", "ASIDE",
    "FORM", "BUTTON", "A",
  ]);

  // ---------------- State ----------------
  let pending = [];
  let history = [];
  let lastHistoryString = "";
  let pollTimer = null;
  // Track which change ids we've already observed in history.json. A change is
  // only "new" if it appears in a fetch that's not the FIRST one — i.e., it
  // arrived while the page was open. Plain refreshes never surface a "new"
  // toast.
  let isFirstHistoryFetch = true;
  let knownChangeIds = new Set();

  // Agent → page notes (clarifying questions / blockers), polled from
  // feedback/notes.json. Seen ids persist so a note only toasts once.
  let notes = [];
  let lastNotesString = "";
  let seenNoteIds = new Set();

  // Selection-mode state
  let savedTextSelection = null;   // {range, quote, anchor}

  // Element-mode state
  let elementMode = false;
  let selectedElements = [];        // ordered

  // Tour state
  let tourState = null;

  // "I just submitted a batch" state — persists across reloads via localStorage.
  // Cleared when history.json has a change.in_response_to matching any of these ids.
  // Shape: { comment_ids: [], submitted_at: ISO, pending_snapshot: [comments] }
  let lastSubmittedBatch = null;
  let staleTimer = null;
  let isBatchStale = false;
  // Longer than the raw "first-network-roundtrip" timeout — most real agent
  // edits involve multiple tool calls (read, edit, append history, rebuild)
  // and can easily take 30–60s. We also push this timer back whenever
  // history.json content changes (any change is proof of life from the
  // agent), so the deadline only fires if the file is genuinely untouched.
  const STALE_AFTER_MS = 90000;

  // "Changes ready, reload to see" state. Activated when truly-new changes
  // arrive (the user has likely switched tabs to do other work). Surfaces a
  // 🔔 prefix in the tab title and a top-center banner; press R to reload.
  // Reload persists an auto-tour flag so the walkthrough opens automatically
  // on the next page load.
  let originalTitle = "";
  let pendingReload = false;
  let pendingReloadCount = 0;

  // ---------------- LocalStorage ----------------
  function loadLS() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || "{}"); } catch { return {}; }
  }
  function saveLS() {
    const cur = loadLS();
    cur.pending = pending;
    cur.lastSubmittedBatch = lastSubmittedBatch;
    localStorage.setItem(LS_KEY, JSON.stringify(cur));
  }

  // ---------------- Anchors ----------------
  function assignAnchors() {
    let n = 0;
    const used = new Set();
    document.querySelectorAll("body *").forEach((el) => {
      if (insideOurUI(el)) return;
      if (el.dataset.cfId) { used.add(el.dataset.cfId); return; }
      if (!isCommentable(el)) return;
      el.dataset.cfId = durableId(el, used);
    });
  }

  // A content-derived, stable anchor id: tag + short hash of the trimmed text.
  // Unlike the old positional "el-N", this survives reloads and DOM reordering
  // as long as the element's text is unchanged — so a comment still resolves if
  // the page is refreshed before the agent processes it, and the [data-cf-id]
  // selector handed to the agent stays meaningful. Collisions (identical text,
  // e.g. repeated buttons) get a numeric suffix.
  function durableId(el, used) {
    const tag = el.tagName.toLowerCase();
    const text = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120);
    let base = text ? tag + "-" + shortHash(tag + "|" + text) : tag + "-x";
    let id = base, i = 2;
    while (used.has(id)) id = base + "-" + (i++);
    used.add(id);
    return id;
  }

  // Tiny deterministic string hash (djb2 → base36). Not crypto — just a stable
  // short label.
  function shortHash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(36).slice(0, 6);
  }

  function isCommentable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (insideOurUI(el)) return false;
    if (COMMENTABLE_TAGS.has(el.tagName)) return true;
    // Any element with a class is likely a meaningful styled block.
    if (el.classList && el.classList.length > 0) return true;
    // Also consider any element with an id (likely a meaningful section)
    if (el.id && el.id.length > 0 && !el.id.startsWith("cf-")) return true;
    return false;
  }

  function findCommentableAncestor(node) {
    let el = node && node.nodeType === 3 ? node.parentElement : node;
    while (el && el !== document.body && el !== document.documentElement) {
      if (insideOurUI(el)) return null;
      if (el.dataset && el.dataset.cfId) return el;
      if (isCommentable(el)) return el;
      el = el.parentElement;
    }
    return null;
  }

  function insideOurUI(el) {
    if (!el || !el.closest) return false;
    return !!el.closest("#claude-feedback-root, .cf-editor, .cf-selection-popup, .cf-tour-bar, .cf-toast");
  }

  function stableSelector(el) {
    if (!el) return "";
    if (el.id) return "#" + CSS.escape(el.id);
    if (el.dataset && el.dataset.cfId) return '[data-cf-id="' + el.dataset.cfId + '"]';
    // walk up for an id or data-cf-id
    let cur = el.parentElement;
    let suffix = " > " + el.tagName.toLowerCase();
    let path = el.tagName.toLowerCase();
    while (cur && cur !== document.body) {
      if (cur.id) return "#" + CSS.escape(cur.id) + " " + path;
      if (cur.dataset && cur.dataset.cfId) return '[data-cf-id="' + cur.dataset.cfId + '"] ' + path;
      const idx = Array.prototype.indexOf.call(cur.children, el) + 1;
      path = cur.tagName.toLowerCase() + ":nth-child(" + idx + ") > " + path;
      el = cur;
      cur = cur.parentElement;
    }
    return path;
  }

  function anchorInfo(el) {
    if (!el) return null;
    return {
      cf_id: el.dataset.cfId || null,
      selector: stableSelector(el),
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      text_snippet: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, TEXT_SNIPPET_MAX),
      outer_html: truncate(el.outerHTML, OUTER_HTML_MAX),
      styles: computedStyles(el),
    };
  }

  // A small, curated slice of the rendered styling so the agent can act on
  // visual feedback ("too big", "wrong color", "tighten the spacing") without
  // guessing from markup alone. Dependency-free — pure getComputedStyle + rect.
  function computedStyles(el) {
    try {
      const cs = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        width: Math.round(r.width) + "px",
        height: Math.round(r.height) + "px",
        font_size: cs.fontSize,
        font_weight: cs.fontWeight,
        font_family: (cs.fontFamily || "").split(",")[0].replace(/["']/g, "").trim(),
        line_height: cs.lineHeight,
        color: cs.color,
        background: cs.backgroundColor,
        display: cs.display,
        margin: cs.margin,
        padding: cs.padding,
      };
    } catch (e) {
      return null;
    }
  }

  function truncate(s, n) {
    if (!s) return "";
    if (s.length <= n) return s;
    return s.slice(0, n) + "…";
  }

  // ---------------- UI: build DOM ----------------
  function buildUI() {
    const root = document.createElement("div");
    root.id = "claude-feedback-root";
    root.innerHTML = [
      '<div class="cf-launcher">',
      '  <button id="cf-toggle" class="cf-btn-primary" title="Feedback (press F)">',
      '    <span>feedback</span> <span class="cf-kbd-hint">F</span> <span id="cf-badge"></span>',
      '  </button>',
      '</div>',
      '<div id="cf-panel" class="cf-panel" aria-hidden="true">',
      '  <div class="cf-panel-header">',
      '    <strong>Feedback</strong>',
      '    <span class="cf-header-hint">F · P · H · T · ? · Esc</span>',
      '    <button id="cf-close" class="cf-icon-btn" aria-label="Close">×</button>',
      '  </div>',
      // agent → page back-channel (clarifying questions / "can\'t do that")
      '  <div id="cf-notes" class="cf-notes" hidden></div>',
      '  <div class="cf-tabs">',
      '    <button data-tab="pending" class="cf-tab cf-tab-active" title="Pending (P)">Pending <span class="cf-kbd-hint">P</span></button>',
      '    <button data-tab="history" class="cf-tab" title="History (H)">History <span class="cf-kbd-hint">H</span></button>',
      '  </div>',
      '  <div id="cf-tab-pending" class="cf-tab-pane cf-tab-pane-active">',
      '    <div id="cf-pending-list" class="cf-list"></div>',
      '    <div class="cf-panel-actions">',
      '      <button id="cf-elem-toggle" class="cf-btn">🎯 select element</button>',
      '      <button id="cf-add-general" class="cf-btn">+ general</button>',
      '    </div>',
      '    <div class="cf-panel-actions" style="margin-top:6px;">',
      '      <button id="cf-submit" class="cf-btn-primary" disabled>submit batch</button>',
      '    </div>',
      '    <p class="cf-hint">Highlight any text to comment on it. Or click <em>select element</em>, then click any block on the page (image, table, paragraph, section). Shift-click to add more elements. Esc cancels.</p>',
      '  </div>',
      '  <div id="cf-tab-history" class="cf-tab-pane">',
      '    <div id="cf-history-list" class="cf-list"></div>',
      '    <div class="cf-panel-actions">',
      '      <button id="cf-tour" class="cf-btn" disabled title="Start tour (T)">start tour <span class="cf-kbd-hint">T</span></button>',
      '    </div>',
      '  </div>',
      '</div>',
      // text-selection popup
      '<div id="cf-selection-popup" class="cf-selection-popup">',
      '  <button id="cf-popup-comment" class="cf-btn-primary cf-btn-small">💬 comment</button>',
      '</div>',
      // element-selection popup
      '<div id="cf-elem-popup" class="cf-selection-popup">',
      '  <button id="cf-elem-popup-comment" class="cf-btn-primary cf-btn-small">💬 comment</button>',
      '  <button id="cf-elem-popup-clear"   class="cf-btn cf-btn-small">clear</button>',
      '</div>',
      // editor
      '<div id="cf-editor" class="cf-editor" role="dialog" aria-label="Comment editor">',
      '  <div class="cf-editor-quote" id="cf-editor-quote"></div>',
      '  <div id="cf-editor-reactions" class="cf-reactions"></div>',
      '  <textarea id="cf-editor-text" placeholder="your comment or question…" rows="3"></textarea>',
      '  <div class="cf-editor-actions">',
      '    <button id="cf-editor-cancel" class="cf-btn cf-btn-small">cancel</button>',
      '    <button id="cf-editor-save" class="cf-btn-primary cf-btn-small">add (⌘↵)</button>',
      '  </div>',
      '</div>',
      // tour bar
      '<div id="cf-tour-bar" class="cf-tour-bar">',
      '  <button id="cf-tour-prev" class="cf-btn cf-btn-small" title="Prev (←)">← prev</button>',
      '  <span id="cf-tour-label" class="cf-tour-label"></span>',
      '  <button id="cf-tour-next" class="cf-btn cf-btn-small" title="Next (→)">next →</button>',
      '  <button id="cf-tour-exit" class="cf-btn cf-btn-small" title="Exit (Esc)">exit</button>',
      '</div>',
      '<div id="cf-toast" class="cf-toast"></div>',
      // "Changes ready, reload to see" banner — persistent, top-center
      '<div id="cf-reload-banner" class="cf-reload-banner" role="status" aria-live="polite">',
      '  <span class="cf-reload-bell" aria-hidden="true">🔔</span>',
      '  <span id="cf-reload-msg" class="cf-reload-msg">Changes ready, reload to see</span>',
      '  <button id="cf-reload-now" class="cf-btn-primary cf-btn-small" title="Reload (R)">reload <span class="cf-kbd-hint">R</span></button>',
      '</div>'
    ].join("");
    document.body.appendChild(root);
  }

  const $ = (id) => document.getElementById(id);

  function showToast(msg, ms = 2500) {
    const t = $("cf-toast");
    t.textContent = msg;
    t.classList.add("cf-visible");
    clearTimeout(t._timeout);
    t._timeout = setTimeout(() => t.classList.remove("cf-visible"), ms);
  }

  // ---------------- Text selection ----------------
  function onSelectionChange() {
    if (elementMode) { hideTextPopup(); return; }
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) { hideTextPopup(); return; }
    const txt = sel.toString().trim();
    if (txt.length < 2) { hideTextPopup(); return; }
    const node = sel.anchorNode;
    if (node && insideOurUI(node.nodeType === 3 ? node.parentElement : node)) {
      hideTextPopup();
      return;
    }
    showTextPopup(sel);
  }

  function showTextPopup(selection) {
    const popup = $("cf-selection-popup");
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    popup.style.top = (window.scrollY + rect.bottom + 6) + "px";
    popup.style.left = (window.scrollX + rect.left + rect.width / 2 - 50) + "px";
    popup.classList.add("cf-visible");
    // SNAPSHOT the relevant state immediately — don't rely on live selection later
    const anchorEl = findCommentableAncestor(range.startContainer);
    savedTextSelection = {
      range: range.cloneRange(),
      quote: selection.toString().trim(),
      anchor: anchorInfo(anchorEl),
    };
  }

  function hideTextPopup() {
    $("cf-selection-popup").classList.remove("cf-visible");
  }

  // ---------------- Element selection ----------------
  function toggleElementMode() {
    elementMode = !elementMode;
    document.body.classList.toggle("cf-elem-mode", elementMode);
    const btn = $("cf-elem-toggle");
    btn.classList.toggle("cf-active", elementMode);
    btn.textContent = elementMode ? "✓ element mode (on)" : "🎯 select element";
    if (!elementMode) {
      clearElementSelection();
      hideElemPopup();
    } else {
      hideTextPopup();
      showToast("Click anything (image, table, paragraph). Shift-click adds. Esc exits.", 3500);
    }
  }

  function clearElementSelection() {
    selectedElements.forEach(el => el.classList.remove("cf-elem-selected"));
    selectedElements = [];
    document.querySelectorAll(".cf-elem-hover").forEach(el => el.classList.remove("cf-elem-hover"));
  }

  function onElemMouseOver(e) {
    if (!elementMode) return;
    if (insideOurUI(e.target)) return;
    const el = findCommentableAncestor(e.target);
    document.querySelectorAll(".cf-elem-hover").forEach(x => x.classList.remove("cf-elem-hover"));
    if (el && !selectedElements.includes(el)) el.classList.add("cf-elem-hover");
  }

  function onElemMouseOut(e) {
    if (!elementMode) return;
    if (insideOurUI(e.target)) return;
    document.querySelectorAll(".cf-elem-hover").forEach(x => x.classList.remove("cf-elem-hover"));
  }

  function onElemClick(e) {
    if (!elementMode) return;
    if (insideOurUI(e.target)) return;
    const el = findCommentableAncestor(e.target);
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    if (!e.shiftKey) {
      // single select: clear others
      selectedElements.forEach(x => { if (x !== el) x.classList.remove("cf-elem-selected"); });
      selectedElements = [];
    }
    const idx = selectedElements.indexOf(el);
    if (idx === -1) {
      selectedElements.push(el);
      el.classList.add("cf-elem-selected");
      el.classList.remove("cf-elem-hover");
    } else {
      selectedElements.splice(idx, 1);
      el.classList.remove("cf-elem-selected");
    }
    if (selectedElements.length > 0) {
      showElemPopup(selectedElements[selectedElements.length - 1]);
    } else {
      hideElemPopup();
    }
  }

  function showElemPopup(nearEl) {
    const popup = $("cf-elem-popup");
    const r = nearEl.getBoundingClientRect();
    popup.style.top = (window.scrollY + r.bottom + 6) + "px";
    popup.style.left = (window.scrollX + r.left + Math.min(r.width / 2, 120)) + "px";
    popup.classList.add("cf-visible");
  }
  function hideElemPopup() {
    $("cf-elem-popup").classList.remove("cf-visible");
  }

  // ---------------- Comment editor ----------------
  function openTextCommentEditor() {
    if (!savedTextSelection) return;
    const editor = $("cf-editor");
    const quoteEl = $("cf-editor-quote");
    quoteEl.classList.remove("cf-comment-general");
    quoteEl.textContent = '"' + savedTextSelection.quote + '"';
    editor._payload = {
      type: "selection",
      comment: "",
      quote: savedTextSelection.quote,
      anchor: savedTextSelection.anchor,
    };
    positionEditor(savedTextSelection.range.getBoundingClientRect());
    editor.classList.add("cf-visible");
    hideTextPopup();
    setTimeout(() => $("cf-editor-text").focus(), 50);
  }

  function openElementCommentEditor() {
    if (selectedElements.length === 0) return;
    const editor = $("cf-editor");
    const quoteEl = $("cf-editor-quote");
    quoteEl.classList.remove("cf-comment-general");
    const elements = selectedElements.map(el => anchorInfo(el));
    // Build a compact summary for the quote display
    quoteEl.innerHTML = elements.map(e => `<div>${escapeHtml(e.tag)}${e.id ? "#" + escapeHtml(e.id) : ""}${e.cf_id ? " <span style='opacity:0.5'>(" + e.cf_id + ")</span>" : ""} — <span style="opacity:0.7">${escapeHtml(e.text_snippet.slice(0, 80))}${e.text_snippet.length > 80 ? "…" : ""}</span></div>`).join("");
    editor._payload = {
      type: "elements",
      comment: "",
      elements,
    };
    positionEditor(selectedElements[selectedElements.length - 1].getBoundingClientRect());
    editor.classList.add("cf-visible");
    hideElemPopup();
    setTimeout(() => $("cf-editor-text").focus(), 50);
  }

  function openGeneralEditor() {
    const editor = $("cf-editor");
    const quoteEl = $("cf-editor-quote");
    quoteEl.classList.add("cf-comment-general");
    quoteEl.textContent = "General question";
    editor._payload = { type: "general", comment: "" };
    // The editor is position: fixed → viewport coords, NO scrollY
    editor.style.top = Math.max(12, window.innerHeight / 2 - 100) + "px";
    editor.style.left = Math.max(12, window.innerWidth / 2 - 160) + "px";
    editor.classList.add("cf-visible");
    setTimeout(() => $("cf-editor-text").focus(), 50);
  }

  // Reply to a previously-applied change — threads the new comment to the
  // change id so the agent gets "this is feedback on the edit you just made"
  // rather than a fresh, context-free request.
  function openReplyEditor(ch) {
    const editor = $("cf-editor");
    const quoteEl = $("cf-editor-quote");
    quoteEl.classList.remove("cf-comment-general");
    quoteEl.innerHTML = `<span style="opacity:0.7">↳ replying to:</span> ${escapeHtml(ch.title || ch.id)}`;
    editor._payload = {
      type: "reply",
      comment: "",
      in_reply_to: ch.id,
      ref_title: ch.title || ch.id,
      anchor: ch.anchor || ch.id,
    };
    editor.style.top = Math.max(12, window.innerHeight / 2 - 100) + "px";
    editor.style.left = Math.max(12, window.innerWidth / 2 - 160) + "px";
    editor.classList.add("cf-visible");
    setTimeout(() => $("cf-editor-text").focus(), 50);
  }

  function positionEditor(rect) {
    // CRITICAL: .cf-editor is position:fixed → coords are VIEWPORT coords, no scroll offset.
    const editor = $("cf-editor");
    const width = 320;
    const estimatedHeight = 200;
    let top = rect.bottom + 12;
    // If that pushes the editor off the bottom, flip above the selection
    if (top + estimatedHeight > window.innerHeight - 12) {
      top = rect.top - estimatedHeight - 12;
    }
    top = Math.max(12, Math.min(top, window.innerHeight - estimatedHeight - 12));
    let left = rect.left + Math.min(rect.width / 2, 200) - width / 2;
    left = Math.max(12, Math.min(left, window.innerWidth - width - 12));
    editor.style.top = top + "px";
    editor.style.left = left + "px";
  }

  function closeEditor() {
    const editor = $("cf-editor");
    editor.classList.remove("cf-visible");
    $("cf-editor-text").value = "";
    editor._payload = null;
  }

  function saveEditorComment() {
    const editor = $("cf-editor");
    const text = $("cf-editor-text").value.trim();
    if (!text || !editor._payload) return;
    const payload = editor._payload;
    payload.id = "c-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
    payload.comment = text;
    payload.created_at = new Date().toISOString();
    pending.push(payload);
    saveLS();
    renderPending();
    closeEditor();
    // Exit element mode after committing (less surprising than staying in)
    if (payload.type === "elements") {
      clearElementSelection();
      if (elementMode) toggleElementMode();
    } else if (payload.type === "selection") {
      window.getSelection().removeAllRanges();
      savedTextSelection = null;
    }
    openPanel();
    setActiveTab("pending");
    showToast("comment added");
  }

  // ---------------- Pending list ----------------
  function renderPending() {
    const list = $("cf-pending-list");
    list.innerHTML = "";

    // Show a "Claude is processing…" banner while we wait for the agent to
    // respond to the most recent batch. Cleared when history.json has an
    // in_response_to matching any of our submitted comment ids.
    if (lastSubmittedBatch) {
      const banner = document.createElement("div");
      banner.className = "cf-processing-banner" + (isBatchStale ? " cf-processing-stale" : "");
      const submittedAgo = relTime(lastSubmittedBatch.submitted_at);
      const n = lastSubmittedBatch.comment_ids.length;
      const submittedList = lastSubmittedBatch.pending_snapshot.map(c =>
        `<div class="cf-comment-quote" style="margin-top:4px;">${escapeHtml(c.comment)}</div>`
      ).join("");

      if (isBatchStale) {
        banner.innerHTML = `
          <div class="cf-processing-row">
            <div class="cf-stale-icon" aria-hidden="true">⚠</div>
            <div class="cf-processing-body">
              <strong>No agent picked this up yet</strong>
              <span class="cf-processing-meta">${n} comment${n === 1 ? "" : "s"} · submitted ${submittedAgo}</span>
            </div>
          </div>
          <div class="cf-processing-status">
            Your batch is saved in <code>feedback/inbox.jsonl</code> but no Claude Code session appears to be watching this directory. To process it: open a terminal here, run <code>claude</code>, and ask it to <em>"process pending feedback in this directory"</em>. Claude will scan the inbox and pick up your comments.
          </div>
          <details class="cf-processing-details">
            <summary>show what you submitted</summary>
            ${submittedList}
          </details>
          <div style="margin-top:8px; display:flex; gap:6px;">
            <button class="cf-btn cf-btn-small" id="cf-dismiss-stale">dismiss</button>
            <button class="cf-btn cf-btn-small" id="cf-keep-waiting">keep waiting</button>
          </div>
        `;
      } else {
        banner.innerHTML = `
          <div class="cf-processing-row">
            <div class="cf-spinner" aria-hidden="true"></div>
            <div class="cf-processing-body">
              <strong>Claude is processing…</strong>
              <span class="cf-processing-meta">${n} comment${n === 1 ? "" : "s"} · submitted ${submittedAgo}</span>
            </div>
          </div>
          <details class="cf-processing-details">
            <summary>show what you submitted</summary>
            ${submittedList}
          </details>
        `;
      }
      list.appendChild(banner);
      // Wire dismiss/keep-waiting after the banner is in the DOM
      if (isBatchStale) {
        const dis = document.getElementById("cf-dismiss-stale");
        const wait = document.getElementById("cf-keep-waiting");
        if (dis) dis.addEventListener("click", () => {
          // Drop the banner; the inbox entry remains for the agent to pick up later
          lastSubmittedBatch = null;
          isBatchStale = false;
          if (staleTimer) { clearTimeout(staleTimer); staleTimer = null; }
          saveLS();
          syncTitle();
          renderPending();
        });
        if (wait) wait.addEventListener("click", () => {
          // Reset the staleness flag; restart the timer
          isBatchStale = false;
          if (staleTimer) clearTimeout(staleTimer);
          staleTimer = setTimeout(() => {
            if (lastSubmittedBatch && !lastBatchProcessed()) {
              isBatchStale = true;
              renderPending();
            }
          }, STALE_AFTER_MS);
          renderPending();
        });
      }
    }

    pending.forEach((c) => {
      const item = document.createElement("div");
      item.className = "cf-comment-item";
      const quote = document.createElement("div");
      quote.className = "cf-comment-quote";
      if (c.type === "general") {
        quote.classList.add("cf-comment-general");
        quote.textContent = "general question";
      } else if (c.type === "reply") {
        quote.classList.add("cf-comment-general");
        quote.textContent = "↳ reply: " + (c.ref_title || c.in_reply_to || "");
      } else if (c.type === "revert") {
        quote.classList.add("cf-comment-general");
        quote.textContent = "⏪ revert: " + (c.ref_title || c.target_batch_id || c.target_commit || "");
      } else if (c.type === "elements") {
        quote.innerHTML = c.elements.map(e =>
          `<div>${escapeHtml(e.tag)}${e.id ? "#" + escapeHtml(e.id) : ""} — <span style="opacity:0.7">${escapeHtml(e.text_snippet.slice(0, 60))}${e.text_snippet.length > 60 ? "…" : ""}</span></div>`
        ).join("");
      } else {
        quote.textContent = '"' + (c.quote || "") + '"';
      }
      const body = document.createElement("div");
      body.className = "cf-comment-body";
      body.textContent = c.comment;
      const meta = document.createElement("div");
      meta.className = "cf-comment-meta";
      const ts = document.createElement("span");
      ts.textContent = relTime(c.created_at);
      const del = document.createElement("button");
      del.className = "cf-comment-delete";
      del.textContent = "remove";
      del.addEventListener("click", () => {
        pending = pending.filter((x) => x.id !== c.id);
        saveLS();
        renderPending();
      });
      meta.appendChild(ts);
      meta.appendChild(del);
      item.appendChild(quote);
      item.appendChild(body);
      item.appendChild(meta);
      list.appendChild(item);
    });
    $("cf-submit").disabled = pending.length === 0;
    updateBadge();
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function relTime(iso) {
    const d = new Date(iso);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return "just now";
    if (diff < 3600) return Math.floor(diff / 60) + "m ago";
    return d.toLocaleTimeString();
  }

  function updateBadge() {
    const badge = $("cf-badge");
    // Badge counts only pending comments. Once submitted, the processing
    // banner is the visible state — no need to also bump the badge.
    badge.textContent = pending.length > 0 ? String(pending.length) : "";
  }

  // Queue a one-click revert request for an applied batch. Routed through the
  // normal pending → submit flow so it shares project-id/token handling; the
  // agent runs `git revert <target_commit>` when it picks it up.
  function addRevertRequest(b) {
    pending.push({
      type: "revert",
      id: "c-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
      comment: "Revert this batch (git revert " + String(b.commit).slice(0, 8) + ").",
      target_commit: b.commit,
      target_batch_id: b.batch_id || null,
      ref_title: (b.changes && b.changes[0] && b.changes[0].title) || b.batch_id || String(b.commit).slice(0, 8),
      created_at: new Date().toISOString(),
    });
    saveLS();
    renderPending();
    openPanel();
    setActiveTab("pending");
    showToast("revert queued — press submit to apply", 3500);
  }

  // Viewport context so the agent knows which breakpoint a complaint is about
  // ("this is broken" at 375px vs 1440px are different bugs).
  function viewportInfo() {
    const w = window.innerWidth;
    const label = w < 640 ? "mobile" : w < 1024 ? "tablet" : "desktop";
    return { width: w, height: window.innerHeight, label };
  }

  // ---------------- Submit batch ----------------
  async function submitBatch() {
    if (!pending.length) return;
    const snapshot = pending.slice();
    const commentIds = snapshot.map(c => c.id);
    const batch = {
      submitted_at: new Date().toISOString(),
      project: PROJECT_ID,
      page_url: location.href,
      viewport: viewportInfo(),
      comments: snapshot,
    };
    try {
      const headers = { "Content-Type": "application/json" };
      if (PROJECT_ID) headers["X-CF-Project"] = PROJECT_ID;
      if (CF_TOKEN) headers["X-CF-Token"] = CF_TOKEN;
      const resp = await fetch(FEEDBACK_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(batch),
      });
      if (resp.status === 401) {
        showToast("⚠ Rejected: missing/invalid feedback token. Re-run inject.py with the server's --token so the page carries it. Your comments are kept.", 12000);
        return;
      }
      if (resp.status === 409) {
        // Cross-wired: this page belongs to one project but the server on the
        // far end of data-cf-api serves another. Keep pending intact so nothing
        // is lost, and tell the user exactly what to fix.
        let info = {};
        try { info = await resp.json(); } catch {}
        const where = info.port ? ":" + info.port : (API_BASE || "this origin");
        showToast(
          `⚠ Wrong project: this page is "${info.got || PROJECT_ID}" but the server at ` +
          `${where} serves "${info.expected || "another project"}". ` +
          `Point data-cf-api at the right port — your comments are kept.`,
          12000
        );
        return;
      }
      if (!resp.ok) throw new Error("server returned " + resp.status);
      lastSubmittedBatch = {
        comment_ids: commentIds,
        submitted_at: batch.submitted_at,
        pending_snapshot: snapshot,
      };
      isBatchStale = false;
      pending = [];
      saveLS();
      syncTitle();
      renderPending();
      showToast("batch sent — Claude is processing", 3500);
      // Warn the user if no agent picks up the batch within STALE_AFTER_MS
      if (staleTimer) clearTimeout(staleTimer);
      staleTimer = setTimeout(() => {
        if (lastSubmittedBatch && !lastBatchProcessed()) {
          isBatchStale = true;
          renderPending();
        }
      }, STALE_AFTER_MS);
    } catch (e) {
      console.error(e);
      showToast("failed to send: " + e.message, 4500);
    }
  }

  // ---------------- Agent → page notes ----------------
  async function fetchNotes() {
    try {
      const resp = await fetch(NOTES_URL + "?t=" + Date.now());
      if (!resp.ok) return;
      const text = await resp.text();
      if (text === lastNotesString) return;
      lastNotesString = text;
      const parsed = JSON.parse(text);
      notes = Array.isArray(parsed) ? parsed : [];
      renderNotes();
    } catch (e) { /* notes.json may not exist yet — ignore */ }
  }

  function renderNotes() {
    const box = $("cf-notes");
    if (!box) return;
    const active = notes.filter(n => n && n.id && !dismissedNote(n.id));
    if (active.length === 0) { box.hidden = true; box.innerHTML = ""; return; }
    box.hidden = false;
    box.innerHTML = "";
    // Surface a toast + open the panel the first time a note is seen.
    const fresh = active.filter(n => !seenNoteIds.has(n.id));
    if (fresh.length) {
      fresh.forEach(n => seenNoteIds.add(n.id));
      showToast("💬 Claude left a note", 3500);
      openPanel();
    }
    active.forEach((n) => {
      const item = document.createElement("div");
      const kind = n.type === "question" ? "question" : n.type === "blocked" ? "blocked" : "info";
      item.className = "cf-note cf-note-" + kind;
      const icon = kind === "question" ? "❓" : kind === "blocked" ? "🚫" : "💬";
      const msg = document.createElement("div");
      msg.className = "cf-note-msg";
      msg.textContent = icon + " " + (n.text || "");
      const dismiss = document.createElement("button");
      dismiss.className = "cf-comment-delete";
      dismiss.textContent = "dismiss";
      dismiss.addEventListener("click", () => { dismissNote(n.id); renderNotes(); });
      item.appendChild(msg);
      item.appendChild(dismiss);
      box.appendChild(item);
    });
  }

  function dismissedNote(id) {
    const ls = loadLS();
    return (ls.dismissedNotes || []).includes(id);
  }
  function dismissNote(id) {
    const ls = loadLS();
    const d = new Set(ls.dismissedNotes || []);
    d.add(id);
    ls.dismissedNotes = Array.from(d).slice(-200);  // bound the list
    localStorage.setItem(LS_KEY, JSON.stringify(ls));
  }

  // ---------------- Title sync ----------------
  // The tab title reflects what state the batch is in, so the user can tell
  // at a glance from another tab. Precedence (highest first):
  //   🔔  changes ready (pendingReload active)
  //   ⏳  agent is processing a submitted batch
  //   (no prefix) — idle
  function syncTitle() {
    if (!originalTitle) return;
    let prefix = "";
    if (pendingReload) prefix = "🔔 ";
    else if (lastSubmittedBatch) prefix = "⏳ ";
    document.title = prefix + originalTitle;
  }

  // ---------------- Pending-reload state ----------------
  function setPendingReload(addCount) {
    pendingReloadCount += addCount;
    const n = pendingReloadCount;
    const msg = `${n} change${n === 1 ? "" : "s"} ready, reload to see`;
    $("cf-reload-msg").textContent = msg;
    $("cf-reload-banner").classList.add("cf-visible");
    if (!pendingReload) {
      pendingReload = true;
      if (!originalTitle) originalTitle = document.title;
    }
    syncTitle();
  }

  function doReload() {
    if (!pendingReload) return;
    sessionStorage.setItem("cf-scroll-y", String(window.scrollY));
    sessionStorage.setItem("cf-auto-tour", "1");
    // Restore the title before unload so the OS tab-list briefly sees the
    // clean version (mostly cosmetic; the new page sets its own title anyway).
    if (originalTitle) document.title = originalTitle;
    location.reload();
  }

  function lastBatchProcessed() {
    if (!lastSubmittedBatch) return true;
    const mine = new Set(lastSubmittedBatch.comment_ids);
    for (const b of history) {
      for (const ch of (b.changes || [])) {
        for (const cid of (ch.in_response_to || [])) {
          if (mine.has(cid)) return true;
        }
      }
    }
    return false;
  }


  // ---------------- History / polling ----------------
  async function fetchHistory() {
    try {
      const resp = await fetch(HISTORY_URL + "?t=" + Date.now());
      if (!resp.ok) return;
      const text = await resp.text();
      if (text === lastHistoryString) return;
      lastHistoryString = text;
      // history.json changed → an agent is alive and writing. Push the stale
      // warning back so users don't see "no agent picked this up" while the
      // agent is actively working (just slower than the raw timeout).
      if (lastSubmittedBatch && !isBatchStale) {
        if (staleTimer) clearTimeout(staleTimer);
        staleTimer = setTimeout(() => {
          if (lastSubmittedBatch && !lastBatchProcessed()) {
            isBatchStale = true;
            renderPending();
          }
        }, STALE_AFTER_MS);
      }
      const parsed = JSON.parse(text);
      history = Array.isArray(parsed) ? parsed : [];
      onHistoryUpdated();
    } catch (e) { /* network glitch */ }
  }

  function onHistoryUpdated() {
    renderHistory();
    updateBadge();
    // If we were waiting on a batch and history has now caught up, clear banner.
    // (The "Changes ready" UI takes over from the processing-banner; no toast.)
    if (lastSubmittedBatch && lastBatchProcessed()) {
      lastSubmittedBatch = null;
      isBatchStale = false;
      if (staleTimer) { clearTimeout(staleTimer); staleTimer = null; }
      saveLS();
      renderPending();
    }

    // Identify genuinely-new changes (arrived since the previous poll).
    const all = flattenChanges();
    const trulyNew = all.filter(ch => !knownChangeIds.has(ch.id));
    knownChangeIds = new Set(all.map(ch => ch.id));

    if (isFirstHistoryFetch) {
      // First fetch on page load — establish baseline silently. No toast,
      // no reload. Any changes already in history are already on the page.
      isFirstHistoryFetch = false;
      // If we just reloaded in response to a "Changes ready" banner, verify
      // the expected anchors actually materialized. Any still missing means
      // the agent's history.json doesn't match the HTML — surface that loudly
      // instead of letting the user trigger reload after reload.
      const expected = sessionStorage.getItem("cf-last-reload-anchors");
      if (expected) {
        sessionStorage.removeItem("cf-last-reload-anchors");
        const stillMissing = expected.split("|").filter(a => a && !findAnchorNode(a));
        if (stillMissing.length > 0) {
          console.error("[cf] anchor still missing after reload:", stillMissing);
          showToast(`⚠ anchor${stillMissing.length === 1 ? "" : "s"} not found: ${stillMissing.join(", ")}. Likely a typo in history.json or the HTML.`, 10000);
        }
      }
      return;
    }
    if (trulyNew.length === 0) {
      syncTitle();
      return;
    }

    // Live update — content arrived while the page was open. The user has
    // likely switched tabs, so surface a 🔔 + persistent banner instead of
    // hijacking the page with an auto-reload. Stash the expected anchors so
    // the post-reload first-fetch can detect a stale history.json.
    const missing = trulyNew.filter(ch => !findAnchorNode(ch.anchor || ch.id));
    if (missing.length > 0) {
      const missingIds = missing.map(ch => ch.anchor || ch.id).sort().join("|");
      sessionStorage.setItem("cf-last-reload-anchors", missingIds);
    } else {
      sessionStorage.removeItem("cf-last-reload-anchors");
    }
    setPendingReload(trulyNew.length);
  }

  function flattenChanges() {
    const out = [];
    for (const b of history) {
      for (const ch of (b.changes || [])) {
        out.push(Object.assign({ batch_id: b.batch_id, batch_ts: b.timestamp, comments: b.comments || [] }, ch));
      }
    }
    return out;
  }

  function findAnchorNode(anchor) {
    // Use ~= (whitespace-separated word match) so an element can carry multiple
    // anchors at once, e.g. data-cf-change="ch-foo ch-bar".
    return document.querySelector(`[data-cf-change~="${CSS.escape(anchor)}"]`);
  }

  function renderHistory() {
    const list = $("cf-history-list");
    list.innerHTML = "";
    // Newest batch first
    for (let i = history.length - 1; i >= 0; i--) {
      const b = history[i];
      const item = document.createElement("div");
      item.className = "cf-history-batch";

      // Compact batch header (just timestamp, very small) + optional revert.
      const header = document.createElement("div");
      header.className = "cf-history-batch-header";
      header.textContent = (b.timestamp || ("Batch #" + (i + 1))).replace("T", " ");
      // If the agent recorded a git commit for this batch, offer a one-click
      // revert. The request goes through the inbox like any comment; the agent
      // runs `git revert <sha>`.
      if (b.commit) {
        const rev = document.createElement("button");
        rev.className = "cf-comment-delete";
        rev.style.marginLeft = "8px";
        rev.textContent = "⏪ revert";
        rev.title = "Ask Claude to git-revert this batch (" + String(b.commit).slice(0, 8) + ")";
        rev.addEventListener("click", (e) => {
          e.stopPropagation();
          addRevertRequest(b);
        });
        header.appendChild(rev);
      }
      item.appendChild(header);

      (b.changes || []).forEach((ch) => {
        const row = document.createElement("div");
        row.className = "cf-history-change";
        row.dataset.changeId = ch.id;
        const t = document.createElement("div");
        t.className = "cf-history-change-title";
        t.textContent = ch.title || ch.id;
        row.appendChild(t);
        // "asked: <comment>" — the user's prompts (description omitted; the
        // page content itself shows what changed).
        const responded = (ch.in_response_to || []).map((cid) => (b.comments || []).find((c) => c.id === cid)).filter(Boolean);
        responded.forEach((c) => {
          const q = document.createElement("div");
          q.className = "cf-history-change-quote";
          q.textContent = "asked: " + c.comment;
          row.appendChild(q);
        });
        // Reply affordance — threads a follow-up to this exact change.
        const reply = document.createElement("button");
        reply.className = "cf-comment-delete";
        reply.textContent = "↳ reply";
        reply.title = "Comment on this change (threads to the agent as a follow-up)";
        reply.addEventListener("click", (e) => {
          e.stopPropagation();
          openReplyEditor(ch);
        });
        row.appendChild(reply);
        row.addEventListener("click", () => focusChange(ch));
        item.appendChild(row);
      });

      list.appendChild(item);
    }
    $("cf-tour").disabled = flattenChanges().length === 0;
  }

  function focusChange(ch) {
    const anchor = ch.anchor || ch.id;
    const node = findAnchorNode(anchor);
    if (!node) {
      showToast(`couldn't find region for change "${anchor}"`, 3500);
      return;
    }
    document.querySelectorAll(".cf-change-active").forEach((el) => el.classList.remove("cf-change-active"));
    node.classList.add("cf-change-active");
    node.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  // ---------------- Tour ----------------
  // Tour walks the FULL change history (all batches). The label shows N/M
  // absolute position. Start position is always the FIRST change of the
  // LATEST batch — so after a fresh batch the tour drops you straight onto
  // the newest content (e.g. 4/4 if the last batch added a single change).
  function startTour() {
    const all = flattenChanges();
    if (!all.length) return;
    let startIdx = 0;
    if (history.length > 0) {
      // Find the last batch that actually has changes
      for (let i = history.length - 1; i >= 0; i--) {
        const b = history[i];
        if (b.changes && b.changes.length > 0) {
          const firstOfLast = b.changes[0];
          const idx = all.findIndex(c => c.id === firstOfLast.id);
          if (idx >= 0) startIdx = idx;
          break;
        }
      }
    }
    tourState = { changes: all, index: startIdx };
    $("cf-tour-bar").classList.add("cf-visible");
    closePanel();
    tourStep(0);
  }
  function tourStep(delta) {
    if (!tourState) return;
    tourState.index = Math.max(0, Math.min(tourState.changes.length - 1, tourState.index + delta));
    const ch = tourState.changes[tourState.index];
    focusChange(ch);
    $("cf-tour-label").textContent = `${tourState.index + 1} / ${tourState.changes.length}`;
    $("cf-tour-prev").disabled = tourState.index === 0;
    $("cf-tour-next").disabled = tourState.index === tourState.changes.length - 1;
  }
  function exitTour() {
    tourState = null;
    $("cf-tour-bar").classList.remove("cf-visible");
    document.querySelectorAll(".cf-change-active").forEach((el) => el.classList.remove("cf-change-active"));
  }

  // ---------------- Panel ----------------
  function openPanel() { $("cf-panel").classList.add("cf-open"); }
  function closePanel() { $("cf-panel").classList.remove("cf-open"); }
  function togglePanel() {
    const p = $("cf-panel");
    if (p.classList.contains("cf-open")) closePanel(); else openPanel();
  }
  function setActiveTab(name) {
    document.querySelectorAll(".cf-tab").forEach((t) => t.classList.toggle("cf-tab-active", t.dataset.tab === name));
    document.querySelectorAll(".cf-tab-pane").forEach((p) => p.classList.toggle("cf-tab-pane-active", p.id === "cf-tab-" + name));
  }

  // ---------------- Event wiring ----------------
  function bindEvents() {
    $("cf-toggle").addEventListener("click", togglePanel);
    $("cf-close").addEventListener("click", closePanel);
    $("cf-add-general").addEventListener("click", openGeneralEditor);
    $("cf-submit").addEventListener("click", submitBatch);
    $("cf-elem-toggle").addEventListener("click", toggleElementMode);

    // CRITICAL FIX: mousedown.preventDefault keeps the text selection alive
    // through the click. Without it, the browser clears the selection on
    // mousedown, which causes our saved range to look invalid.
    const popupBtn = $("cf-popup-comment");
    popupBtn.addEventListener("mousedown", (e) => e.preventDefault());
    popupBtn.addEventListener("click", openTextCommentEditor);

    $("cf-elem-popup-comment").addEventListener("click", openElementCommentEditor);
    $("cf-elem-popup-clear").addEventListener("click", () => {
      clearElementSelection();
      hideElemPopup();
    });

    $("cf-editor-cancel").addEventListener("click", closeEditor);
    $("cf-editor-save").addEventListener("click", saveEditorComment);
    $("cf-editor-text").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveEditorComment();
      if (e.key === "Escape") closeEditor();
    });

    // Quick-reaction chips — append to the textarea so they stack and stay
    // editable.
    const reactions = $("cf-editor-reactions");
    QUICK_REACTIONS.forEach((label) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "cf-chip";
      chip.textContent = label;
      chip.addEventListener("mousedown", (e) => e.preventDefault());  // keep textarea focus
      chip.addEventListener("click", () => {
        const ta = $("cf-editor-text");
        ta.value = ta.value.trim() ? ta.value.trim() + "; " + label : label;
        ta.focus();
      });
      reactions.appendChild(chip);
    });

    document.querySelectorAll(".cf-tab").forEach((t) => t.addEventListener("click", () => setActiveTab(t.dataset.tab)));
    $("cf-tour").addEventListener("click", startTour);
    $("cf-tour-prev").addEventListener("click", () => tourStep(-1));
    $("cf-tour-next").addEventListener("click", () => tourStep(1));
    $("cf-tour-exit").addEventListener("click", exitTour);
    $("cf-reload-now").addEventListener("click", doReload);

    // If the page is reloaded any other way (browser refresh, Cmd-R), still
    // carry the auto-tour flag forward so the user's mental model holds:
    // "changes ready" → reload → tour opens.
    window.addEventListener("beforeunload", () => {
      if (pendingReload) {
        sessionStorage.setItem("cf-auto-tour", "1");
        sessionStorage.setItem("cf-scroll-y", String(window.scrollY));
      }
    });

    document.addEventListener("selectionchange", debounce(onSelectionChange, 120));

    // Element-mode interactions
    document.addEventListener("mouseover", onElemMouseOver);
    document.addEventListener("mouseout", onElemMouseOut);
    document.addEventListener("click", onElemClick, true);  // capture phase

    document.addEventListener("keydown", (e) => {
      // Esc is always-on (works inside text inputs too)
      if (e.key === "Escape") {
        if ($("cf-editor").classList.contains("cf-visible")) closeEditor();
        else if (elementMode) toggleElementMode();
        else if (tourState) exitTour();
        else closePanel();
        return;
      }
      // Tour arrows: only while tour is active
      if (tourState && !isTypingTarget(e.target) && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.key === "ArrowLeft")  { e.preventDefault(); tourStep(-1); return; }
        if (e.key === "ArrowRight") { e.preventDefault(); tourStep(1);  return; }
      }
      // Single-letter shortcuts only when not typing and no modifiers held
      if (isTypingTarget(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case "f": case "F":
          e.preventDefault(); togglePanel(); break;
        case "p": case "P":
          e.preventDefault(); openPanel(); setActiveTab("pending"); break;
        case "h": case "H":
          e.preventDefault(); openPanel(); setActiveTab("history"); break;
        case "t": case "T":
          e.preventDefault();
          if (!$("cf-tour").disabled) startTour();
          break;
        case "r": case "R":
          if (pendingReload) { e.preventDefault(); doReload(); }
          break;
        case "?":
          e.preventDefault();
          showToast("F: feedback · P: pending · H: history · T: tour · R: reload when changes ready · ←/→: tour nav · Esc: close", 6500);
          break;
      }
    });
  }

  function isTypingTarget(el) {
    if (!el) return false;
    const tag = (el.tagName || "").toLowerCase();
    return tag === "input" || tag === "textarea" || el.isContentEditable;
  }

  function debounce(fn, ms) {
    let t = null;
    return function (...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), ms); };
  }

  // ---------------- Bootstrap ----------------
  function init() {
    originalTitle = document.title;
    assignAnchors();
    buildUI();
    bindEvents();
    const ls = loadLS();
    pending = ls.pending || [];
    lastSubmittedBatch = ls.lastSubmittedBatch || null;
    syncTitle();
    renderPending();
    const shouldAutoTour = sessionStorage.getItem("cf-auto-tour") === "1";
    if (shouldAutoTour) sessionStorage.removeItem("cf-auto-tour");
    fetchHistory().then(() => {
      if (shouldAutoTour && flattenChanges().length > 0) {
        setTimeout(startTour, 250);
      }
    });
    fetchNotes();
    pollTimer = setInterval(() => { fetchHistory(); fetchNotes(); }, POLL_INTERVAL_MS);
    // Restore scroll position after a reload triggered by the "changes ready" flow
    const sy = sessionStorage.getItem("cf-scroll-y");
    if (sy) {
      sessionStorage.removeItem("cf-scroll-y");
      setTimeout(() => window.scrollTo(0, parseInt(sy, 10)), 0);
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
