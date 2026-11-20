import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const release = JSON.parse(await readFile(path.join(root, 'dist/runtime/manifest.json'), 'utf8'));
const npm = process.env.npm_execpath;
const tarball = path.resolve(process.env.BK_TEST_PACKAGE || `bk-baokuan-cli-${pkg.version}.tgz`);
const isWindows = process.platform === 'win32';

test('npm tarball installs in isolation, verifies MCP, authorizes the mock site and completes the quick start', { timeout: 480000 }, async t => {
  assert.ok(npm, 'Run this test with npm run smoke:package');
  const home = await mkdtemp(path.join(await realpath(tmpdir()), 'bk-cli home 测试 '));
  const prefix = path.join(home, 'global');
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex') };
  for (const name of Object.keys(env)) if (/^(?:MUBAI_|BK_BAOKUAN_|CODEX_THREAD_ID$)/i.test(name)) delete env[name];
  const settings = { env, timeout: 250000, windowsHide: true };
  const config = '[unrelated]\nname = "keep"\n';
  const configPath = path.join(env.CODEX_HOME, 'config.toml');
  await mkdir(env.CODEX_HOME);
  await writeFile(configPath, config);
  await exec(process.execPath, [npm, 'install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-fund', '--no-audit', tarball], settings);
  const npmPath = path.join(prefix, ...(isWindows ? [] : ['bin']));
  const shim = isWindows
    ? await exec(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'mubai-media.cmd', '--version'], { ...settings, cwd: npmPath })
    : await exec(path.join(npmPath, 'mubai-media'), ['--version'], settings);
  assert.equal(shim.stdout.trim(), pkg.version);
  const entry = path.join(prefix, ...(isWindows ? [] : ['lib']), 'node_modules', '@bk-baokuan', 'cli', 'bin', 'mubai-media.mjs');
  const command = (...args) => exec(process.execPath, [entry, ...args], settings);
  const account = { account_id: 23, api_app_id: 41, expires_at: Math.floor(Date.now() / 1000) + 600, service_enabled: true };
  const key = 'sk-mbag-' + randomBytes(32).toString('hex');
  const requestId = '3'.repeat(32);
  const deviceCode = '5'.repeat(64);
  const receipt = '7'.repeat(32);
  let challenge, approved = false, charged = 0;
  const requests = [];
  const idempotency = new Set();
  const server = http.createServer(async (request, response) => {
    const route = request.url;
    requests.push(route);
    const send = (data, status = 200) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(status === 200 ? { data } : { error: { code: data } }));
    };
    const data = [];
    for await (const chunk of request) data.push(chunk);
    const body = /multipart\//.test(request.headers['content-type'] || '') ? null : data.length ? JSON.parse(Buffer.concat(data)) : null;
    try {
      if (route === '/api/agent-access/distribution') return send({ ...release, download_url: '/api/agent-access/download' });
      if (route === '/api/agent-access/device/start') {
        challenge = body.code_challenge;
        assert.equal(body.client, 'generic');
        return send({ device_code: deviceCode, user_code: 'TEST-1234', request_id: requestId, authorization_origin: origin,
          verification_uri_complete: `${origin}/home/#/ai-tool/authorize?request=${requestId}`, interval: 1, expires_in: 120 });
      }
      if (route === '/api/agent-access/device/token' || route === '/api/agent-access/device/ack') {
        assert.equal(body.device_code, deviceCode);
        assert.equal(createHash('sha256').update(body.code_verifier).digest('base64url'), challenge);
        if (!approved) return send('authorization_pending', 400);
        if (route.endsWith('/ack')) { assert.equal(body.receipt, receipt); return send({ acknowledged: true }); }
        return send({ ...account, api_key: key, base_url: origin, receipt });
      }
      assert.equal(request.headers.authorization === `Bearer ${key}`, true);
      if (route === '/api/agent-access/device/session') return send({ ...account, connected: true });
      if (route === '/api/agent-access/device/version') return send({ version: pkg.version });
      if (route === '/openapi/agent/v1/account') return send({ ...account, balance_score: 100 - charged * 12 });
      if (route === '/openapi/agent/v1/models') return send({ models: [{ id: 'public-image', type: 'image' }] });
      if (route === '/openapi/agent/v1/assets') { assert.ok(data.length); return send({ asset_id: 'fixture-asset' }); }
      if (route === '/openapi/agent/v1/quotes') return send({ quote_id: 'fixture-quote', total_score: 12, expires_at: account.expires_at });
      if (route === '/openapi/agent/v1/generations') {
        assert.equal(body.quote_id, 'fixture-quote');
        assert.ok(request.headers['idempotency-key']);
        if (!idempotency.has(request.headers['idempotency-key'])) charged++;
        idempotency.add(request.headers['idempotency-key']);
        return send({ task_id: 'fixture-task', status: 'queued', poll_after_seconds: 1 });
      }
      if (route === '/openapi/agent/v1/tasks/fixture-task') return send({ task_id: 'fixture-task', status: 'completed', output: [] });
      if (route === '/api/agent-access/device/revoke') return send({ revoked: true });
      send('unexpected_route', 404);
    } catch (error) {
      t.diagnostic(error.message);
      send('unexpected_request', 500);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const client of ['generic', 'generic', 'codex']) {
    const installed = await command('install', '--client', client, '--base-url', origin, '--allow-http-localhost');
    assert.match(installed.stdout, /未调用网站、未生成或扣费/);
  }
  assert.deepEqual(requests, [], 'Installing and discovering MCP tools must not contact the site');
  assert.ok((await readFile(configPath, 'utf8')).startsWith(config));
  const pointer = JSON.parse(await readFile(path.join(home, '.mubai-media-mcp', 'current.json')));
  assert.deepEqual(Object.keys(pointer.installs).sort(), ['codex', 'generic']);
  assert.equal(pointer.version, pkg.version);

  const login = ['login', '--client', 'generic', '--base-url', origin, '--allow-http-localhost', '--no-browser'];
  const pending = await command(...login);
  assert.match(pending.stdout, /TEST-1234/);
  assert.equal(lastJson(pending.stdout).data.authorization_pending, true);
  approved = true;
  const connected = await command(...login, '--wait');
  assert.equal(lastJson(connected.stdout).data.connected, true);
  assert.ok(!connected.stdout.includes(key) && !connected.stderr.includes(key));
  const status = await command('status', '--client', 'generic', '--verify');
  assert.equal(lastJson(status.stdout).data.connected, true);
  assert.equal(charged, 0);
  const input = async (tool, value) => {
    const file = path.join(home, `${tool}.json`);
    await writeFile(file, JSON.stringify(value));
    const result = lastJson((await command(tool, '--input', file)).stdout);
    assert.ok(result.data);
    return result.data;
  };
  const models = await input('list_models', { type: 'image' });
  assert.equal(models.models[0].id, 'public-image');
  const picture = path.join(home, 'product.png');
  await writeFile(picture, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nm1sAAAAASUVORK5CYII=', 'base64'));
  const asset = await input('upload_asset', { file_path: picture });
  const operationId = 'product-scene-0001';
  const quote = await input('quote_generation', { operation_id: operationId, type: 'image', model: models.models[0].id,
    prompt: '场景图', params: { ratio: '1:1', size: '1K' }, materials: [{ asset_id: asset.asset_id }] });
  assert.equal(quote.total_score, 12);
  assert.equal(charged, 0);
  const submit = { operation_id: operationId, max_score: 12 };
  const task = await input('generate_image', submit);
  assert.equal((await input('generate_image', submit)).task_id, task.task_id);
  assert.equal((await input('get_task', { task_id: task.task_id })).status, 'completed');
  assert.equal(charged, 1);
  assert.equal(lastJson((await command('logout', '--client', 'generic', '--revoke')).stdout).data.server_revoked, true);
});

function lastJson(text) {
  return JSON.parse(text.trim().split(/\r?\n/).at(-1));
}
