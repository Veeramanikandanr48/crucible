import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ANNOTATE_LIMITS } from '../src/agent-annotate.js';
import { REVIEW_FILE_FORMAT } from '../src/review-link.js';

// The static review page of issue #924: one rendered view of a scene that a person opens on a phone or a laptop, pins with a short
// note each, and saves as a small JSON file (download or copy). It is the same marking the local scene_ask_user page does, with no
// server behind it: the page is index.html and frame.png, so any static host or a file on disk serves it. The marks come back
// to the agent through scene_ask_user with reviewFile.

const PAGE_CSS = `
*{box-sizing:border-box}
html,body{margin:0}
body{min-height:100vh;background:#182126;color:#e8eef0;font:15px/1.4 system-ui,sans-serif;display:flex;flex-direction:column;gap:12px;padding:12px}
h1{margin:0;font-size:18px;font-weight:600}
main{display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap}
.viewport{position:relative;overflow:hidden;border-radius:8px;flex:0 1 var(--width);max-width:100%;touch-action:none;cursor:crosshair;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent}
.stage{position:relative;line-height:0;transform-origin:0 0}
.stage img{width:100%;height:auto;display:block;pointer-events:none}
.pin{position:absolute;width:28px;height:28px;border-radius:50%;background:#ff5a4f;color:#fff;font:600 13px/28px system-ui,sans-serif;text-align:center;box-shadow:0 0 0 2px #fff;pointer-events:none;transform:translate(-50%,-50%) scale(var(--pin-scale,1))}
aside{flex:1 1 280px;max-width:420px;display:flex;flex-direction:column;gap:12px;user-select:none;-webkit-user-select:none}
.rows{display:flex;flex-direction:column;gap:8px}
.row{display:flex;gap:10px;align-items:center}
.badge{flex:none;width:26px;height:26px;border-radius:50%;background:#ff5a4f;color:#fff;font:600 13px/26px system-ui,sans-serif;text-align:center}
input{flex:1;min-width:0;height:44px;border:0;border-radius:6px;background:#26343b;color:inherit;padding:0 10px;font:inherit;user-select:text;-webkit-user-select:text}
input:focus{outline:2px solid #6fb7ff}
button{height:44px;border:0;border-radius:6px;padding:0 14px;font:inherit;color:inherit;background:#26343b;cursor:pointer;display:inline-flex;gap:8px;align-items:center;justify-content:center}
button.primary{background:#2f7dd1;color:#fff}
button.icon{width:44px;padding:0;flex:none;background:transparent}
button:disabled{opacity:.5;cursor:default}
svg{width:18px;height:18px;flex:none}
.actions{display:flex;gap:8px;flex-wrap:wrap}
.hint,.count{color:#9db0b8}
.saved{display:flex;gap:10px;align-items:center;color:#58d68d}
.saved[hidden]{display:none}
`;

const ICONS = {
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>',
  ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M7.5 12.5l3 3 6-6.5"/></svg>',
};

// The page script. It runs in the browser; `marks` holds { x, y, note } in the pixels of the rendered view.
const PAGE_SCRIPT = `(() => {
const config = JSON.parse(document.getElementById('review-config').textContent);
const viewport = document.getElementById('viewport');
const stage = document.getElementById('stage');
const frame = document.getElementById('frame');
const rows = document.getElementById('rows');
const count = document.getElementById('count');
const downloadButton = document.getElementById('download');
const copyButton = document.getElementById('copy');
const saved = document.getElementById('saved');
const marks = [];
const trashIcon = ${JSON.stringify(ICONS.trash)};
const TAP_DISTANCE = 10;
let zoom = 1;
let panX = 0;
let panY = 0;
function applyView() {
  stage.style.transform = 'translate(' + panX + 'px,' + panY + 'px) scale(' + zoom + ')';
  stage.style.setProperty('--pin-scale', String(1 / zoom));
}
function keepInside() {
  const box = viewport.getBoundingClientRect();
  panX = Math.min(0, Math.max(box.width * (1 - zoom), panX));
  panY = Math.min(0, Math.max(box.height * (1 - zoom), panY));
}
function render() {
  stage.querySelectorAll('.pin').forEach(pin => pin.remove());
  rows.textContent = '';
  marks.forEach((mark, index) => {
    const pin = document.createElement('div');
    pin.className = 'pin';
    pin.textContent = index + 1;
    pin.style.left = (mark.x / config.width * 100) + '%';
    pin.style.top = (mark.y / config.height * 100) + '%';
    stage.appendChild(pin);
    const row = document.createElement('div');
    row.className = 'row';
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = index + 1;
    const input = document.createElement('input');
    input.maxLength = config.maxNoteLength;
    input.value = mark.note;
    input.placeholder = 'What should change here?';
    input.addEventListener('input', () => { mark.note = input.value; });
    const remove = document.createElement('button');
    remove.className = 'icon';
    remove.setAttribute('aria-label', 'Remove pin ' + (index + 1));
    remove.innerHTML = trashIcon;
    remove.addEventListener('click', () => { marks.splice(index, 1); render(); });
    row.append(badge, input, remove);
    rows.appendChild(row);
  });
  count.textContent = marks.length + ' of ' + config.maxMarks + ' pins';
  downloadButton.disabled = marks.length === 0;
  copyButton.disabled = marks.length === 0;
}
function addPin(clientX, clientY) {
  if (marks.length >= config.maxMarks) return;
  const box = frame.getBoundingClientRect();
  const x = (clientX - box.left) / box.width * config.width;
  const y = (clientY - box.top) / box.height * config.height;
  if (x < 0 || y < 0 || x > config.width || y > config.height) return;
  marks.push({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, note: '' });
  render();
  rows.lastChild.querySelector('input').focus();
}
// One finger taps to pin. Two fingers pinch to zoom and drag to pan, and never drop a pin.
const pointers = new Map();
let tap = null;
let pinch = null;
function span() {
  const [first, second] = [...pointers.values()];
  return { distance: Math.hypot(first.x - second.x, first.y - second.y), x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
}
viewport.addEventListener('pointerdown', event => {
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pointers.size === 1) {
    tap = { id: event.pointerId, x: event.clientX, y: event.clientY, valid: true };
  } else {
    if (tap) tap.valid = false;
    if (pointers.size === 2) pinch = span();
  }
});
viewport.addEventListener('pointermove', event => {
  if (!pointers.has(event.pointerId)) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (tap && tap.id === event.pointerId && Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > TAP_DISTANCE) tap.valid = false;
  if (pointers.size !== 2 || !pinch) return;
  const next = span();
  const box = viewport.getBoundingClientRect();
  const nextZoom = Math.min(4, Math.max(1, zoom * next.distance / pinch.distance));
  const anchorX = pinch.x - box.left;
  const anchorY = pinch.y - box.top;
  panX = next.x - box.left - (anchorX - panX) * nextZoom / zoom;
  panY = next.y - box.top - (anchorY - panY) * nextZoom / zoom;
  zoom = nextZoom;
  pinch = next;
  keepInside();
  applyView();
});
function release(event) {
  if (!pointers.delete(event.pointerId)) return;
  if (pointers.size < 2) pinch = null;
  if (tap && tap.id === event.pointerId) {
    if (tap.valid && event.type === 'pointerup') addPin(event.clientX, event.clientY);
    tap = null;
  }
}
viewport.addEventListener('pointerup', release);
viewport.addEventListener('pointercancel', release);
function fileText() {
  return JSON.stringify({ format: config.format, version: 1, reviewId: config.reviewId, marks: marks.map(({ x, y, note }) => ({ x, y, note: note.trim() })) });
}
function showSaved() {
  saved.hidden = false;
}
downloadButton.addEventListener('click', () => {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([fileText()], { type: 'application/json' }));
  link.download = 'crucible-review.json';
  link.click();
  showSaved();
});
copyButton.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(fileText());
  } catch {
    const field = document.createElement('textarea');
    field.value = fileText();
    document.body.appendChild(field);
    field.select();
    document.execCommand('copy');
    field.remove();
  }
  showSaved();
});
window.crucibleReview = { marks, fileText };
render();
applyView();
})();`;

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
}

function jsonForScriptTag(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/** The review page for one rendered view. The reviewId ties the saved file to the export the server remembers. */
export function reviewPageHtml({ title, width, height, reviewId, maxMarks = ANNOTATE_LIMITS.maxMarks }) {
  const heading = escapeHtml(String(title ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 64) || 'Mark the scene');
  const config = { format: REVIEW_FILE_FORMAT, reviewId, width, height, maxMarks, maxNoteLength: ANNOTATE_LIMITS.maxNoteLength };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>${heading}</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<h1>${heading}</h1>
<main>
<div class="viewport" id="viewport" style="--width:${width}px"><div class="stage" id="stage"><img id="frame" src="frame.png" width="${width}" height="${height}" alt="Rendered scene"></div></div>
<aside>
<div class="hint">Tap the picture to drop a pin, then say what to change there. Two fingers zoom and move the picture.</div>
<div class="rows" id="rows"></div>
<div class="count" id="count"></div>
<div class="actions"><button class="primary" id="download">${ICONS.download}<span>Save file</span></button><button id="copy">${ICONS.copy}<span>Copy</span></button></div>
<div class="saved" id="saved" hidden>${ICONS.ok}<span>Saved. Send the file back to whoever asked.</span></div>
</aside>
</main>
<script type="application/json" id="review-config">${jsonForScriptTag(config)}</script>
<script>${PAGE_SCRIPT}</script>
</body>
</html>
`;
}

/**
 * Writes the review page of one frame into `outputDirectory` (created, must not hold a page already): index.html and frame.png.
 * `frame` is { data: base64 PNG, width, height }. Returns the summary scene_export_web reports.
 */
export async function writeReviewBuild({ frame, outputDirectory, title, reviewId }) {
  const html = reviewPageHtml({ title, width: frame.width, height: frame.height, reviewId });
  const png = Buffer.from(frame.data, 'base64');
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(join(outputDirectory, 'frame.png'), png);
  await writeFile(join(outputDirectory, 'index.html'), html);
  return { directory: outputDirectory, files: 2, bytes: png.length + Buffer.byteLength(html) };
}
