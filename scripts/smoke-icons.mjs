// Renders every GLB of a folder as icons through the MCP server on the cpu backend and copies the files to --out.
//   node scripts/smoke-icons.mjs --assets <folder of .glb files> --out <folder> [--style clean|toon] [--scale fit|relative] [--size 128] [--twice]
// Checks each icon's alpha box against the frame (inside it, centred) and, with --twice, that a second job writes the same bytes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { mkdtemp } from 'node:fs/promises';

const argumentsGiven = process.argv.slice(2);
function option(name, fallback) {
  const index = argumentsGiven.indexOf(`--${name}`);
  return index < 0 ? fallback : argumentsGiven[index + 1];
}
const assets = resolve(option('assets', ''));
const output = resolve(option('out', 'artifacts/icons'));
const style = option('style', 'clean');
const scale = option('scale', 'fit');
const size = Number(option('size', 128));
const runTwice = argumentsGiven.includes('--twice');
const names = (await readdir(assets)).filter(name => name.endsWith('.glb')).sort();
assert.ok(names.length, `No .glb files in ${assets}.`);
const jobs = join(await mkdtemp(join(tmpdir(), 'crucible-icons-')), 'jobs');
const cli = resolve('bin/crucible-mcp.mjs');
const transport = new StdioClientTransport({ command: process.execPath, args: [cli, '--backend', 'cpu', '--memory', '256', '--assets', assets, '--jobs', jobs], stderr: 'pipe' });
let diagnostics = '';
transport.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-4096); });
const client = new Client({ name: 'crucible-icons-proof', version: '1' });

async function call(name, argumentsValue = {}) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout: 600000 });
  assert.equal(result.isError, undefined, result.content?.find(item => item.type === 'text')?.text);
  return result.structuredContent;
}

async function runJob() {
  const created = await call('scene_create', { recipe: { format: 'crucible.scene', schemaVersion: 1, geometries: [{ id: 'g', type: 'box' }], materials: [{ id: 'm' }], nodes: [{ id: 'n', geometry: 'g', material: 'm' }] } });
  const submitted = await call('scene_render_submit', { sessionId: created.sessionId, expectedRevision: 0, settings: { kind: 'icons', items: names, size, style, scale } });
  const deadline = Date.now() + 580000;
  for (;;) {
    const record = await call('scene_render_status', { jobId: submitted.jobId });
    if (['completed', 'failed', 'cancelled'].includes(record.state)) {
      assert.equal(record.state, 'completed', record.reason);
      break;
    }
    assert.ok(Date.now() < deadline, 'The icons job did not finish in time.');
    await new Promise(done => setTimeout(done, 500));
  }
  const result = await call('scene_render_result', { jobId: submitted.jobId });
  return { jobId: submitted.jobId, artifacts: result.artifacts };
}

const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex');
try {
  await client.connect(transport);
  const first = await runJob();
  await mkdir(output, { recursive: true });
  for (const artifact of first.artifacts) await copyFile(artifact.path, join(output, artifact.filename));
  const manifest = JSON.parse(await readFile(join(output, 'icons.json'), 'utf8'));
  for (const icon of manifest.icons) {
    const { x, y, width, height } = icon.bounds;
    assert.ok(x >= 1 && y >= 1 && x + width <= size - 1 && y + height <= size - 1, `${icon.name} touches the frame edge: ${JSON.stringify(icon.bounds)}`);
    console.log(icon.name.padEnd(28), JSON.stringify(icon.bounds), `view height ${icon.viewHeight}`);
  }
  if (runTwice) {
    const second = await runJob();
    for (const artifact of first.artifacts) {
      const other = second.artifacts.find(candidate => candidate.filename === artifact.filename);
      assert.equal(await digest(artifact.path), await digest(other.path), `${artifact.filename} differs between two runs`);
    }
    console.log(`${first.artifacts.length} files are byte-identical across two jobs`);
  }
  console.log(`wrote ${first.artifacts.length} files to ${output}`);
} catch (error) {
  console.error(error.message, diagnostics);
  process.exitCode = 1;
} finally {
  await client.close();
}
