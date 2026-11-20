import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'node:child_process';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fixture, quoteInput } from './helpers.mjs';

test('install verifier starts the specified launcher and rejects a broken installed pointer', async t => {
  const f = await fixture(t);
  const launcher = path.join(f.temp, 'launch.mjs');
  await writeFile(launcher, await readFile(new URL('../src/launcher.mjs', import.meta.url)));
  const current = path.join(f.temp, 'current.json');
  await writeFile(current, JSON.stringify({ schema: 1, version: '0.4.1' }));
  const directory = path.join(f.temp, 'versions', '0.4.1', 'src'); await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'server.mjs'), `await import(${JSON.stringify(new URL('../src/server.mjs', import.meta.url).href)});`);
  const verify = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/install-check.mjs', import.meta.url)), '--launcher', launcher], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = ''; child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', () => {}); child.once('error', reject); child.once('close', code => resolve({ code, stdout }));
  });
  const valid = await verify(); assert.equal(valid.code, 0); assert.equal(JSON.parse(valid.stdout).launcher_verified, true); assert.equal(JSON.parse(valid.stdout).tools, 18);
  await writeFile(current, JSON.stringify({ schema: 1, version: '../invalid' }));
  assert.notEqual((await verify()).code, 0);
  assert.equal(f.observed.generationCalls.length, 0);
});

test('SDK discovery needs no key and a tool call fails locally before any HTTP request', async t => {
  const f = await fixture(t);
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/server.mjs', import.meta.url))], env: { MUBAI_CREDENTIAL_DIR: path.join(f.temp, 'isolated-auth') }, stderr: 'pipe' });
  const client = new Client({ name: 'no-key-install-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 18);
  const result = await client.callTool({ name: 'get_account', arguments: {} });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'LOGIN_REQUIRED');
});

test('real SDK stdio handshake, tool schema and quote-submit-query roundtrip', async t => {
  const f = await fixture(t);
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/server.mjs', import.meta.url))], env: f.env, stderr: 'pipe' });
  const client = new Client({ name: 'local-contract-test', version: '1.0.0' });
  t.after(() => client.close());
  let stderr = ''; transport.stderr?.on('data', chunk => { stderr += chunk; });
  await client.connect(transport);
  const tools = await client.listTools(); assert.equal(tools.tools.length, 18);
  const names = tools.tools.map(x => x.name); assert.ok(names.includes('generate_video'));
  const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); assert.notEqual(r.isError, true, JSON.stringify(r)); return r.structuredContent.data; };
  assert.equal((await call('get_account')).balance_score, 500);
  assert.equal((await call('list_models', { type: 'video' })).models[0].id, 'public-video');
  const request = '把商品照片的背景换成白色，保留标识';
  const discovery = await call('discover_skills', { request, has_image: true });
  assert.equal(discovery.status, 'matched');
  assert.deepEqual(f.observed.lastSkillDiscovery, { request, has_image: true });
  const skillQuote = await call('quote_generation', {
    operation_id: 'user-action-skill',
    type: 'image',
    prompt: request,
    skill_id: discovery.skill.id,
    materials: [{ asset_id: 'asset_1' }],
  });
  assert.equal(skillQuote.total_score, 20);
  assert.equal(f.observed.lastQuote.skill_id, discovery.skill.id);
  assert.equal(f.observed.lastQuote.prompt, request);
  const quote = await call('quote_generation', { ...quoteInput, source_task_id: 'am_original' }); assert.equal(quote.total_score, 20);
  assert.equal(f.observed.lastQuote.source_task_id, 'am_original');
  const submitted = await call('generate_image', { operation_id: quoteInput.operation_id, max_score: 30 });
  const done = await call('get_task', { task_id: submitted.task_id }); assert.equal(done.status, 'completed'); assert.equal(done.output.length, 1);
  assert.equal(f.observed.charges, 1);
  assert.doesNotMatch(stderr, /test-only-key/);
});

test('CLI accepts a JSON file and returns one structured result', async t => {
  const f = await fixture(t); const input = path.join(f.temp, 'input.json'); await writeFile(input, JSON.stringify({ type: 'video' }));
  const proc = spawn(process.execPath, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), 'list_models', '--input', input], { env: f.env });
  let out = ''; let error = ''; proc.stdout.on('data', b => { out += b; }); proc.stderr.on('data', b => { error += b; });
  const code = await new Promise(resolve => proc.on('close', resolve)); assert.equal(code, 0, error); assert.equal(JSON.parse(out).data.models.length, 1);
});
