/* ============================================================================
 * HTML → Markdown Converter
 *
 * Loads an HTML file the user picks or drops, parses each <p> locally in the
 * browser, converts it to Markdown (YAML front matter + content hash), lets the
 * user exclude tabs, and renders/downloads the result. Nothing is uploaded.
 *
 * Performance: the file is parsed ONCE into a flat list of line entries
 * (parseLines). Tab toggles then only re-run buildBody() over that list — no
 * DOMParser, no regex, no cloning — so filtering is cheap.
 *
 * The conversion logic (romanizeKorean / escapeMarkdown / commentLine) is
 * adapted from a browser-console script; the only changes are that it reads
 * from the parsed input file instead of the live document, and takes the
 * title from the file name.
 * ==========================================================================*/


/* ─── CONVERSION LOGIC ─────────────────────────────────────────────────────*/

function romanizeKorean(text) {
  const CHO = ["g", "kk", "n", "d", "tt", "r", "m", "b", "pp", "s", "ss", "", "j", "jj", "ch", "k", "t", "p", "h"];
  const JUNG = ["a", "ae", "ya", "yae", "eo", "e", "yeo", "ye", "o", "wa", "wae", "oe", "yo", "u", "wo", "we", "wi", "yu", "eu", "ui", "i"];
  const JONG = ["", "k", "k", "ks", "n", "nj", "nh", "t", "l", "lk", "lm", "lb", "ls", "lt", "lp", "lh", "m", "p", "ps", "t", "t", "ng", "t", "t", "k", "t", "p", "t"];

  return text.split("").map(char => {
    const code = char.charCodeAt(0);

    if (code < 0xAC00 || code > 0xD7A3) return char;

    const syllable = code - 0xAC00;
    const cho = Math.floor(syllable / 588);
    const jung = Math.floor((syllable % 588) / 28);
    const jong = syllable % 28;

    return CHO[cho] + JUNG[jung] + JONG[jong];
  }).join("");
}

function escapeMarkdown(text) {
  return text
    .replace(/&(?!(?:[a-zA-Z]+|#\d+|#x[a-fA-F0-9]+);)/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\\/g, "\\\\")   // escape backslash first
    .replace(/([_{}\[\]<>()#+\~\:])/g, "\\$1");
}

function commentLine(text, newName, cname, isComment, isSecret) {
  // Skip the line entirely if it has no visible content (avoids empty
  // <p class="comment"></p>). Strips normal whitespace AND zero-width /
  // invisible characters that .trim() leaves behind but render as nothing.
  if (!text || text.replace(/[\s​‌‍⁠﻿]/g, "") === "") return;
  if (cname === "system") return `<p class="system">${text}</p>`;
  const nameslot = newName ? `<name>${isComment ? cname.trim() : escapeMarkdown(cname.trim())}</name>` : '';
  if (isSecret) return `<p class="comment secret">${nameslot}${text}</p>`;
  return isComment
    ? `<p class="comment">${nameslot}${text}</p>`
    : `${nameslot}${escapeMarkdown(text)}`;
}

// Replicate p.innerText.trim() for a DOMParser document (which isn't rendered,
// so real innerText returns ""). innerText collapses runs of whitespace —
// including the source's newlines and indentation between inline <span>s — to
// single spaces, and only turns rendered line breaks (<br>) into newlines.
function paragraphText(p) {
  // Fast path: most <p> have no <br>, so skip the expensive deep clone and just
  // collapse whitespace like innerText does.
  if (p.getElementsByTagName("br").length === 0) {
    return (p.textContent || "").replace(/\s+/g, " ").trim();
  }
  // Slow path (only when <br> present): mark real breaks, collapse the rest.
  const clone = p.cloneNode(true);
  const BR = String.fromCharCode(1); // sentinel marking real <br> line breaks
  clone.querySelectorAll("br").forEach(br => br.replaceWith(BR));
  return (clone.textContent || "")
    .replace(/\s+/g, " ")   // collapse all whitespace (incl. source newlines)
    .split(BR)              // restore only genuine <br> breaks
    .map(s => s.trim())
    .join("\n")
    .trim();
}

/* Parse the HTML ONCE into a flat list of line entries + the set of tabs.
 * Each entry is either a matched "[tab] name :rest" line or a plain line;
 * isComment/isSecret carry forward to plain lines exactly as in the original. */
function parseLines(content) {
  const doc = new DOMParser().parseFromString(content, "text/html");
  const tabs = new Set();
  const entries = [];
  let currentTab = "";
  let isComment = false;
  let isSecret = false;

  Array.from(doc.querySelectorAll("p")).forEach(p => {
    const innerText = paragraphText(p);
    if (!innerText) return;
    innerText.split("\n").forEach(line => {
      const match = line.match(/^\[([^\[]*)\] (.*?) :(.*)$/);
      if (match) {
        const [, tab, cname, rest] = match;
        currentTab = tab;
        tabs.add(tab);
        // Everything is a comment EXCEPT the main tab (main / 메인 / メイン).
        isComment = !/^\[(main|메인|メイン)\] /.test(line);
        isSecret = /^\[(비밀.*)\] /.test(line);
        entries.push({ matched: true, tab, name: cname, rest, isComment, isSecret });
      } else {
        entries.push({ matched: false, tab: currentTab, line, isComment, isSecret });
      }
    });
  });

  return { tabs: Array.from(tabs), entries };
}

// How many rendered messages to show in the live preview (download is full).
const PREVIEW_CAP = 500;

/* Build the Markdown body pieces from pre-parsed entries, skipping excluded
 * tabs. Returns an array of rendered pieces (one per output line). Redundancy
 * collapse (prevTab/prevName) is recomputed over the filtered stream so it
 * stays correct after exclusions. Pure array work — fast. */
function buildBody(entries, excludedTabs) {
  let prevTab = "";
  let prevName = "";
  const out = [];
  for (const e of entries) {
    if (excludedTabs.has(e.tab)) continue; // omit excluded tab (and its continuation lines)
    let piece;
    if (e.matched) {
      const newName = !(prevTab === e.tab && prevName === e.name);
      if (newName) { prevTab = e.tab; prevName = e.name; }
      piece = commentLine(e.rest, newName, e.name, e.isComment, e.isSecret);
    } else {
      piece = commentLine(e.line, false, prevName, e.isComment, e.isSecret);
    }
    if (piece) out.push(piece);
  }
  return out;
}

function wrapBody(body) {
  // Blank lines around the tags let the Markdown processor parse the inner content.
  return `<section class="commentedLog">\n\n${body}\n\n</section>`;
}

function frontMatter(title, pubDate) {
  return `---\ntitle: "${title}"\npubDate: ${pubDate}\ntags: \n---\n\n`;
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

/* Assemble the result from parsed data + exclusions. `markdown` is the full
 * document (downloaded); `previewMarkdown` is capped to PREVIEW_CAP messages so
 * the live render stays fast on large logs. */
async function buildResult(parsed, title, pubDate, excludedTabs) {
  const pieces = buildBody(parsed.entries, excludedTabs);
  const bodyContent = pieces.join("\n\n");

  const fm = frontMatter(title, pubDate);
  const markdown = `${fm}${wrapBody(bodyContent)}\n`;

  // Capped copy for the preview only.
  const total = pieces.length;
  const shown = Math.min(total, PREVIEW_CAP);
  const previewBody = pieces.slice(0, shown).join("\n\n");
  const previewMarkdown = `${fm}${wrapBody(previewBody)}\n`;

  const shortHash = (await sha256Hex(bodyContent)).slice(0, 8);
  const romanTitle = romanizeKorean(title || "document");
  const safeTitle = romanTitle.replace(/[^\w\d]+/g, "_").split("_").filter(Boolean).slice(0, 3).join("_").toLowerCase();

  return {
    markdown,
    previewMarkdown,
    total,
    shown,
    capped: total > shown,
    filename: `${safeTitle}_${shortHash}.md`,
    mime: "text/markdown",
    tabs: parsed.tabs,
  };
}

/* ==========================================================================
 * Plumbing below — you usually don't need to touch this.
 * ==========================================================================*/

const els = {
  dropzone: document.getElementById("dropzone"),
  fileInput: document.getElementById("file-input"),
  filelistSection: document.getElementById("filelist-section"),
  filelist: document.getElementById("filelist"),
  runBtn: document.getElementById("run-btn"),
  downloadMd: document.getElementById("download-md"),
  downloadHtml: document.getElementById("download-html"),
  clearBtn: document.getElementById("clear-btn"),
  status: document.getElementById("status"),
  tabsSection: document.getElementById("tabs-section"),
  tabs: document.getElementById("tabs"),
  resultsSection: document.getElementById("results-section"),
  results: document.getElementById("results"),
  viewRendered: document.getElementById("view-rendered"),
  viewSource: document.getElementById("view-source"),
};

let selectedFile = null;   // one File at a time
let cachedContent = null;  // text of selectedFile
let parsed = null;         // { tabs, entries } — parsed ONCE per file
let docTitle = "";
let docDate = "";
let lastResult = null;     // { name, ok, result?, error? }
let viewMode = "rendered";
let renderedDirty = true;  // true when the rendered view needs (re)building
let timing = { parse: 0, render: 0 };  // last parse / markdown-render times (ms)

/* ---- File selection (one file at a time; a new pick replaces the old) ---- */

function addFiles(fileList) {
  const incoming = Array.from(fileList);
  if (incoming.length === 0) return;
  selectedFile = incoming[0];
  cachedContent = null;
  parsed = null;
  lastResult = null;
  els.results.innerHTML = "";
  els.resultsSection.hidden = true;
  els.tabs.innerHTML = "";
  els.tabsSection.hidden = true;
  renderFileList();
  syncButtons();
  setStatus(
    incoming.length > 1
      ? `한 번에 하나의 파일만 등록해주세요. “${selectedFile.name}” 로딩 완료.`
      : `“${selectedFile.name}” 로딩 완료.`
  );
}

function renderFileList() {
  els.filelist.innerHTML = "";
  if (selectedFile) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "file-name";
    name.textContent = selectedFile.name;
    const size = document.createElement("span");
    size.className = "file-size";
    size.textContent = formatBytes(selectedFile.size);
    li.append(name, size);
    els.filelist.appendChild(li);
  }
  els.filelistSection.hidden = !selectedFile;
}

function clearAll() {
  selectedFile = null;
  cachedContent = null;
  parsed = null;
  lastResult = null;
  els.fileInput.value = "";
  renderFileList();
  els.results.innerHTML = "";
  els.resultsSection.hidden = true;
  els.tabs.innerHTML = "";
  els.tabsSection.hidden = true;
  setStatus("");
  syncButtons();
}

/* ---- Running ---- */

function readFile(file) {
  return file.text();
}

async function run() {
  if (!selectedFile) return;
  els.runBtn.disabled = true;
  setStatus("Parsing…");
  try {
    cachedContent = await readFile(selectedFile);
    const t0 = performance.now();
    parsed = parseLines(cachedContent); // parse ONCE
    timing.parse = Math.round(performance.now() - t0);
  } catch (err) {
    showError(err);
    return;
  }
  docTitle = selectedFile.name.replace(/\.[^.]+$/, "").replace(/\%20/g, " ");
  docDate = new Date().toISOString().slice(0, 10);
  renderTabs(parsed.tabs);
  await convert();
}

// Re-convert using the current tab selection. Cheap: only buildBody + hash.
async function convert() {
  if (!parsed) return;
  try {
    const result = await buildResult(parsed, docTitle, docDate, getExcludedTabs());
    applyResult(result);
  } catch (err) {
    showError(err);
  }
}

function applyResult(result) {
  lastResult = { name: selectedFile.name, ok: true, result };
  renderResultCard(result.filename, result.markdown, false);
  refreshStatus();
  syncButtons();
}

function refreshStatus() {
  const parts = [];
  if (timing.parse) parts.push(`parsed ${timing.parse}ms`);
  if (viewMode === "rendered" && timing.render) parts.push(`rendered ${timing.render}ms`);
  const timings = parts.length ? ` (${parts.join(", ")})` : "";
  setStatus(`출력 완료 ${timings}`);
}

function showError(err) {
  const message = err && err.message ? err.message : String(err);
  lastResult = { name: selectedFile ? selectedFile.name : "", ok: false, error: message };
  renderResultCard(selectedFile ? selectedFile.name : "error", message, true);
  setStatus("변환 실패.");
  syncButtons();
}

/* ---- Tab filter ---- */

function isMainTab(tab) {
  return /^(main|메인|メイン)$/.test(tab);
}

function renderTabs(tabList) {
  els.tabs.innerHTML = "";
  if (!tabList || tabList.length === 0) {
    els.tabsSection.hidden = true;
    return;
  }
  // Main tabs first (stable: preserve original order within each group).
  const sorted = [
    ...tabList.filter(isMainTab),
    ...tabList.filter((t) => !isMainTab(t)),
  ];
  for (const tab of sorted) {
    const label = document.createElement("label");
    label.className = "tab-toggle" + (isMainTab(tab) ? " is-main" : "");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = true;      // rendered by default
    cb.value = tab;
    cb.addEventListener("change", () => {
      label.classList.toggle("is-excluded", !cb.checked);
      convert();
    });
    const span = document.createElement("span");
    span.className = "tab-name";
    span.textContent = tab;
    label.append(cb, span);
    els.tabs.appendChild(label);
  }
  els.tabsSection.hidden = false;
}

function getExcludedTabs() {
  return new Set(
    Array.from(els.tabs.querySelectorAll("input[type=checkbox]"))
      .filter((cb) => !cb.checked)
      .map((cb) => cb.value)
  );
}

/* ---- Result rendering (rendered + source views) ---- */

function renderResultCard(name, body, isError) {
  els.results.innerHTML = "";
  const card = document.createElement("div");
  card.className = "result-card" + (isError ? " is-error" : "");

  const title = document.createElement("p");
  title.className = "result-card__name";
  title.textContent = name;
  card.append(title);

  if (!isError) {
    const rendered = document.createElement("div");
    rendered.className = "result-card__rendered prose";
    card.append(rendered);
    // Only pay the marked cost when the rendered view is actually visible.
    renderedDirty = true;
    els.resultsSection.hidden = false;
    els.results.appendChild(card);
    if (viewMode === "rendered") ensureRendered();
    else ensureSource();
    syncViewClasses();
    return;
  }

  const pre = document.createElement("pre");
  pre.className = "result-card__source";
  pre.textContent = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  card.append(pre);
  els.resultsSection.hidden = false;
  els.results.appendChild(card);

  // Source pre for the successful path is added lazily too (see ensureSource).
  syncViewClasses();
}

// Build the rendered markdown view on demand (and cache until content changes).
function ensureRendered() {
  if (!lastResult || !lastResult.ok || !renderedDirty) return;
  const target = els.results.querySelector(".result-card__rendered");
  const r = lastResult.result;
  const t0 = performance.now();
  if (target) {
    let html = renderMarkdown(r.previewMarkdown);
    if (r.capped) {
      html +=
        `<p class="preview-note">미리보기는 맨 처음 ${r.shown}개 메시지만 출력합니다. ` +
        `전체 ${r.total}개 메시지는 다운로드해서 확인하세요.</p>`;
    }
    target.innerHTML = html;
  }
  timing.render = Math.round(performance.now() - t0);
  ensureSource();
  renderedDirty = false;
}

// Make sure the source <pre> exists (built once alongside the rendered view).
function ensureSource() {
  if (!lastResult || !lastResult.ok) return;
  const card = els.results.querySelector(".result-card");
  if (!card || card.querySelector(".result-card__source")) return;
  const pre = document.createElement("pre");
  pre.className = "result-card__source";
  pre.textContent = lastResult.result.markdown;
  card.append(pre);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Render the .md string to HTML for the preview: pull the YAML front matter out
// into a small header, then render the body with marked.
function renderMarkdown(md) {
  let body = md;
  let header = "";
  const fm = md.match(/^---\n([\s\S]*?)\n---\n?/);
  if (fm) {
    body = md.slice(fm[0].length);
    const title = (fm[1].match(/^title:\s*"?(.*?)"?\s*$/m) || [])[1] || "";
    const date = (fm[1].match(/^pubDate:\s*(.*?)\s*$/m) || [])[1] || "";
    header =
      `<div class="md-frontmatter">` +
      (title ? `<div class="md-title">${escapeHtml(title)}</div>` : "") +
      (date ? `<div class="md-date">${escapeHtml(date)}</div>` : "") +
      `</div>`;
  }
  const html =
    typeof marked !== "undefined" && marked.parse
      ? marked.parse(body)
      : `<pre>${escapeHtml(body)}</pre>`;
  return header + html;
}

/* ---- View toggle (rendered / source) ---- */

function setView(mode) {
  viewMode = mode;
  if (mode === "rendered") ensureRendered();
  else ensureSource();
  syncViewClasses();
  if (lastResult && lastResult.ok) refreshStatus();
}

function syncViewClasses() {
  els.results.classList.toggle("show-source", viewMode === "source");
  els.viewRendered.classList.toggle("is-active", viewMode === "rendered");
  els.viewSource.classList.toggle("is-active", viewMode === "source");
}

/* ---- Download ---- */

function saveBlob(data, mime, filename) {
  const blob = new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function downloadMd() {
  if (!lastResult || !lastResult.ok) return;
  const { markdown, filename } = lastResult.result;
  saveBlob(markdown, "text/markdown", filename);
}

// Export the FULL rendered document (not the capped preview) as standalone HTML.
// Rendering is synchronous and can be heavy, so show a spinner and yield a frame
// so the browser paints it before the render blocks the main thread.
async function downloadHtml() {
  if (!lastResult || !lastResult.ok) return;
  const btn = els.downloadHtml;
  btn.classList.add("is-busy");
  // Two rAFs guarantee a paint before the blocking work starts.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  try {
    const { markdown, filename } = lastResult.result;
    const html = buildExportHtml(markdown, docTitle);
    saveBlob(html, "text/html", filename.replace(/\.md$/, "") + ".html");
  } finally {
    btn.classList.remove("is-busy");
  }
}

// Self-contained stylesheet for the exported HTML (mirrors the app's theme +
// commentedLog layout so the file looks right on its own, light or dark).
const EXPORT_CSS = `
:root{--bg:#fff;--text-primary:rgba(0,0,0,.85);--text-secondary:rgba(0,0,0,.4);--text-tertiary:rgba(0,0,0,.24);--border:rgba(0,0,0,.1);--code-bg:rgba(0,0,0,.04);--mark:#f3ffc4;--radius:6px;--sans:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;--mono:"SF Mono",SFMono-Regular,ui-monospace,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#1c1c1c;--text-primary:rgba(255,255,255,.9);--text-secondary:rgba(255,255,255,.4);--text-tertiary:rgba(255,255,255,.24);--border:rgba(255,255,255,.1);--code-bg:rgba(255,255,255,.04);--mark:#545b37}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text-primary);font-family:var(--sans);font-size:.9375rem;line-height:1.6;letter-spacing:-.01em;-webkit-font-smoothing:antialiased}
.prose{max-width:720px;margin:0 auto;padding:3rem 1.25rem 5rem;line-height:1.6}
.prose p{margin:.6em 0;overflow-wrap:anywhere}
.prose h1,.prose h2,.prose h3{font-weight:500;letter-spacing:-.02em;margin:1.2em 0 .5em}
.prose a{color:var(--text-primary)}
.prose code{font-family:var(--mono);font-size:.85em;background:var(--code-bg);padding:.1em .3em;border-radius:4px}
.prose pre{background:var(--code-bg);padding:.75rem;border-radius:var(--radius);overflow-x:auto}
.md-frontmatter{margin-bottom:1rem;padding-bottom:.75rem;border-bottom:1px solid var(--border)}
.md-title{font-size:1.15rem;font-weight:500;letter-spacing:-.02em}
.md-date{color:var(--text-secondary);font-size:.8125rem;margin-top:.15rem}
.prose name{color:var(--text-secondary);margin-right:1em}
.prose .commentedLog{display:grid;grid-auto-columns:calc(50% - 1rem) calc(50% - 1rem);column-gap:2rem}
@media (max-width:768px){.prose .commentedLog{display:block}}
.prose .commentedLog p{margin:.5em 0;height:fit-content}
.prose .commentedLog>p:not(.comment){grid-column-start:1;grid-column-end:2}
.prose .commentedLog>p.system{grid-column-start:2}
.prose .commentedLog>p.comment{grid-column-start:2;background:var(--code-bg);border-radius:1em 1em 0 1em;padding:.25em .75em;color:var(--text-secondary)}
.prose .commentedLog p.comment name{color:var(--text-tertiary)}
.prose .commentedLog>p.comment.secret{background-color:var(--mark)}
.prose p.system{border-left:2px solid var(--border);margin:0 0 .5em .125em;padding:0 0 0 1.375em;color:var(--text-secondary)}
`;

function buildExportHtml(fullMarkdown, title) {
  const body = renderMarkdown(fullMarkdown); // renders the complete document
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title || "document")}</title>
<style>${EXPORT_CSS}</style>
</head>
<body>
<main class="prose">
${body}
</main>
</body>
</html>
`;
}

/* ---- Helpers ---- */

function syncButtons() {
  const hasFile = !!selectedFile;
  const hasDownloadable = !!(lastResult && lastResult.ok);
  els.runBtn.disabled = !hasFile;
  els.clearBtn.disabled = !hasFile && !lastResult;
  els.downloadMd.disabled = !hasDownloadable;
  els.downloadHtml.disabled = !hasDownloadable;
}

function setStatus(msg) {
  els.status.textContent = msg;
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const n = bytes / Math.pow(1024, i);
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/* ---- Wiring ---- */

els.dropzone.addEventListener("click", () => els.fileInput.click());
els.dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    els.fileInput.click();
  }
});
els.fileInput.addEventListener("change", (e) => addFiles(e.target.files));

["dragenter", "dragover"].forEach((evt) =>
  els.dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    els.dropzone.classList.add("is-dragover");
  })
);
["dragleave", "dragend", "drop"].forEach((evt) =>
  els.dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    els.dropzone.classList.remove("is-dragover");
  })
);
els.dropzone.addEventListener("drop", (e) => {
  if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
});

els.runBtn.addEventListener("click", run);
els.downloadMd.addEventListener("click", downloadMd);
els.downloadHtml.addEventListener("click", downloadHtml);
els.clearBtn.addEventListener("click", clearAll);
els.viewRendered.addEventListener("click", () => setView("rendered"));
els.viewSource.addEventListener("click", () => setView("source"));

window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());
