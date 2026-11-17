// The scene_ask_user annotate view as an MCP Apps UI resource (issue #923), following the MCP Apps extension spec of
// 2026-01-26 (SEP-1865, github.com/modelcontextprotocol/ext-apps). A host that advertises the extension renders this page in a
// sandboxed iframe; the page needs no network and no remote asset: the scene picture arrives in the tool result as base64, and
// the marks go back through the host with a tools/call to scene_ask_user_submit. The protocol is a few postMessage JSON-RPC
// calls, written here instead of importing @modelcontextprotocol/ext-apps so the core gains no dependency.
import { annotateStyle } from './annotate-session.mjs';

export const MCP_APPS_EXTENSION_ID = 'io.modelcontextprotocol/ui';
export const MCP_APPS_MIME_TYPE = 'text/html;profile=mcp-app';
export const ANNOTATE_VIEW_URI = 'ui://crucible/annotate';
export const MCP_APPS_PROTOCOL_VERSION = '2026-01-26';
export const MAXIMUM_VIEW_BYTES = 32 * 1024;

/** True when the client's initialize capabilities list the MCP Apps extension with the HTML app mime type. */
export function clientSupportsMcpApps(capabilities) {
  const mimeTypes = capabilities?.extensions?.[MCP_APPS_EXTENSION_ID]?.mimeTypes;
  return Array.isArray(mimeTypes) && mimeTypes.includes(MCP_APPS_MIME_TYPE);
}

const VIEW_SCRIPT = `(() => {
const submitTool = 'scene_ask_user_submit';
let limits = null;
let nonce = null;
const marks = [];
const stage = document.getElementById('stage');
const frame = document.getElementById('frame');
const rows = document.getElementById('rows');
const count = document.getElementById('count');
const hint = document.getElementById('hint');
const sendButton = document.getElementById('send');
const trash = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>';
let nextId = 1;
const waiting = new Map();
function post(message) { window.parent.postMessage({ jsonrpc: '2.0', ...message }, '*'); }
function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    post({ id, method, params });
  });
}
window.addEventListener('message', event => {
  const message = event.data;
  if (event.source !== window.parent || !message || message.jsonrpc !== '2.0') return;
  if (message.method === 'ui/notifications/tool-result') {
    showResult(message.params);
  } else if (message.id !== undefined && !message.method && waiting.has(message.id)) {
    const pending = waiting.get(message.id);
    waiting.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message || 'The host refused the request.'));
    else pending.resolve(message.result);
  }
});
function textOf(result) {
  const part = (result && result.content || []).find(item => item.type === 'text');
  return part ? part.text : '';
}
// The nonce travels in the result _meta, which the host gives the view and not the model.
function nonceOf(result) {
  const meta = result && result._meta && result._meta["crucible/annotate"];
  return meta && meta.nonce;
}
function render() {
  if (!limits) return;
  stage.querySelectorAll('.pin').forEach(pin => pin.remove());
  rows.textContent = '';
  marks.forEach((mark, index) => {
    const pin = document.createElement('div');
    pin.className = 'pin';
    pin.textContent = index + 1;
    pin.style.left = (mark.x / limits.view.width * 100) + '%';
    pin.style.top = (mark.y / limits.view.height * 100) + '%';
    stage.appendChild(pin);
    const row = document.createElement('div');
    row.className = 'row';
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = index + 1;
    const input = document.createElement('input');
    input.maxLength = limits.maxNoteLength;
    input.value = mark.note;
    input.placeholder = 'What should change here?';
    input.addEventListener('input', () => { mark.note = input.value; });
    const remove = document.createElement('button');
    remove.className = 'icon';
    remove.title = 'Remove pin';
    remove.setAttribute('aria-label', 'Remove pin ' + (index + 1));
    remove.innerHTML = trash;
    remove.addEventListener('click', () => { marks.splice(index, 1); render(); });
    row.append(badge, input, remove);
    rows.appendChild(row);
    mark.input = input;
  });
  count.textContent = marks.length + ' of ' + limits.maxMarks + ' pins';
  sendButton.disabled = marks.length === 0;
}
function showResult(result) {
  const image = (result.content || []).find(item => item.type === 'image');
  let details;
  try { details = JSON.parse(textOf(result)); } catch (error) { details = null; }
  if (!image || !details || details.outcome !== 'pending' || typeof nonceOf(result) !== 'string') {
    hint.textContent = (details && details.message) || 'This view has no scene to mark.';
    return;
  }
  limits = details;
  nonce = nonceOf(result);
  document.getElementById('title').textContent = details.prompt || 'Click the scene to mark what you mean';
  frame.width = details.view.width;
  frame.height = details.view.height;
  frame.src = 'data:image/png;base64,' + image.data;
  hint.textContent = 'Click the picture to drop a pin, then say what to change there.';
  render();
  reportSize();
}
function reportSize() {
  post({ method: 'ui/notifications/size-changed', params: { height: document.documentElement.scrollHeight } });
}
stage.addEventListener('click', event => {
  if (!limits || marks.length >= limits.maxMarks) return;
  const box = frame.getBoundingClientRect();
  marks.push({ x: (event.clientX - box.left) / box.width * limits.view.width, y: (event.clientY - box.top) / box.height * limits.view.height, note: '' });
  render();
  marks[marks.length - 1].input.focus();
  reportSize();
});
function markedImage() {
  const canvas = document.createElement('canvas');
  canvas.width = limits.view.width;
  canvas.height = limits.view.height;
  const context = canvas.getContext('2d');
  context.drawImage(frame, 0, 0, canvas.width, canvas.height);
  context.font = '600 15px system-ui, sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  marks.forEach((mark, index) => {
    context.beginPath();
    context.arc(mark.x, mark.y, 14, 0, Math.PI * 2);
    context.fillStyle = '#ff5a4f';
    context.fill();
    context.lineWidth = 2;
    context.strokeStyle = '#fff';
    context.stroke();
    context.fillStyle = '#fff';
    context.fillText(String(index + 1), mark.x, mark.y + 1);
  });
  return canvas.toDataURL('image/png').split(',')[1];
}
function finish(kind, text) {
  const icon = kind === 'ok'
    ? '<svg class="ok" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M7.5 12.5l3 3 6-6.5"/></svg>'
    : '<svg class="stop" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 12h8"/></svg>';
  document.getElementById('side').innerHTML = '<div class="done">' + icon + '<span>' + text + '</span></div>';
}
function tellChat(text) {
  return request('ui/message', { role: 'user', content: { type: 'text', text } }).catch(() => {});
}
sendButton.addEventListener('click', async () => {
  sendButton.disabled = true;
  try {
    const answer = await request('tools/call', { name: submitTool, arguments: { nonce, marks: marks.map(({ x, y, note }) => ({ x, y, note })), image: markedImage() } });
    if (answer.isError) throw new Error(textOf(answer) || 'The marks were refused.');
    finish('ok', 'Sent to the agent.');
    await tellChat('Marks from the scene annotate view: ' + textOf(answer));
  } catch (error) {
    sendButton.disabled = false;
    hint.textContent = error.message;
  }
});
document.getElementById('cancel').addEventListener('click', async () => {
  finish('stop', 'Cancelled.');
  await tellChat('I closed the scene annotate view without marking anything.');
});
request('ui/initialize', { appInfo: { name: 'crucible-annotate', version: '1.0.0' }, appCapabilities: {}, protocolVersion: '${MCP_APPS_PROTOCOL_VERSION}' })
  .then(() => post({ method: 'ui/notifications/initialized', params: {} }))
  .catch(error => { hint.textContent = error.message; });
})();`;

/** The whole page as one string: inline style and script, no remote reference, nothing taken from the model. */
export function annotateViewHtml() {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mark the scene</title><style>${annotateStyle(768)}</style></head><body>
<h1 id="title">Waiting for the scene</h1>
<main>
<div class="stage" id="stage"><img id="frame" width="768" height="512" alt="Rendered scene"></div>
<aside id="side">
<div class="hint" id="hint">Loading the view.</div>
<div id="rows" style="display:flex;flex-direction:column;gap:8px"></div>
<div class="count" id="count"></div>
<div class="actions"><button class="primary" id="send" disabled>Send</button><button id="cancel">Cancel</button></div>
</aside>
</main>
<script>${VIEW_SCRIPT}</script>
</body></html>`;
  if (Buffer.byteLength(html) > MAXIMUM_VIEW_BYTES) throw new RangeError(`The annotate view is larger than ${MAXIMUM_VIEW_BYTES} bytes.`);
  return html;
}
