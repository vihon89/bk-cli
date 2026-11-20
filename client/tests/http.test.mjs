import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createRemoteServer } from '../src/server-http.mjs';
import { buildTools } from '../src/tools.mjs';
import { fixture, quoteInput } from './helpers.mjs';

const tokenA = 'mbat_' + 'a'.repeat(64); const tokenB = 'mbat_' + 'b'.repeat(64);
test('default HTTP authentication checks issuer session with exact resource and no cookies on every request', async t => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'bk-session-test-')); t.after(() => rm(stateDir, { recursive: true, force: true }));
  let calls = 0; let wrongAudience = false; let permanent = false; let explicit = true;
  const remote = createRemoteServer({ websiteOrigin: 'https://website.example', resourceUrl: 'http://127.0.0.1:0/mcp', stateDir, allowHttpLocalhost: true, fetchSession: async (url, options) => {
    calls++; assert.equal(url, 'https://website.example/api/agent-oauth/session'); assert.equal(options.headers.Authorization, `Bearer ${tokenA}`); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); assert.equal(options.headers.Cookie, undefined);
    return new Response(JSON.stringify({ data: { active: true, account_id: 7, api_app_id: 11, resource: wrongAudience ? 'https://other.example/mcp' : options.headers['X-Agent-Resource'], expires_at: permanent ? 0 : Math.floor(Date.now() / 1000) + 600, non_expiring: permanent && explicit } }), { headers: { 'Content-Type': 'application/json' } });
  } });
  await new Promise(resolve => remote.server.listen(0, remote.host, resolve)); t.after(async () => { remote.server.closeAllConnections(); await new Promise(resolve => remote.server.close(resolve)); });
  const client = new Client({ name: 'real-session-path', version: '1' }); const transport = new StreamableHTTPClientTransport(new URL(remote.resourceUrl()), { requestInit: { headers: { Authorization: `Bearer ${tokenA}` } } });
  t.after(() => client.close()); await client.connect(transport); assert.equal((await client.listTools()).tools.length, 13); assert.ok(calls >= 2);
  permanent = true; await client.listTools(); explicit = false; await assert.rejects(client.listTools()); explicit = true;
  wrongAudience = true; await assert.rejects(client.listTools());
});
async function remoteFixture(t) {
  const f = await fixture(t); const sessions = []; const envs = []; let revoked = false;
  const remote = createRemoteServer({ websiteOrigin: 'https://website.example', resourceUrl: 'http://127.0.0.1:0/mcp', stateDir: f.temp, allowHttpLocalhost: true,
    authenticate: async (token, resource) => { sessions.push({ token, resource }); if (revoked || ![tokenA, tokenB].includes(token)) throw new Error('inactive'); return { active: true, resource, account_id: token === tokenA ? 7 : 8, api_app_id: token === tokenA ? 11 : 12, expires_at: Math.floor(Date.now() / 1000) + 600 }; },
    buildTools: env => { envs.push(env); return buildTools({ ...env, MUBAI_BASE_URL: f.env.MUBAI_BASE_URL, MUBAI_API_KEY: env.MUBAI_API_KEY === tokenA ? 'test-only-key' : 'other-account', MUBAI_ALLOW_HTTP_LOCALHOST: '1' }); }
  });
  await new Promise(resolve => remote.server.listen(0, remote.host, resolve));
  t.after(async () => { remote.server.closeAllConnections(); await new Promise(resolve => remote.server.close(resolve)); });
  const endpoint = remote.resourceUrl();
  const connect = async token => { const client = new Client({ name: 'remote-offline-test', version: '1' }); const transport = new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }); await client.connect(transport); t.after(() => client.close()); return client; };
  return { ...f, remote, endpoint, connect, sessions, envs, revoke: () => { revoked = true; } };
}

test('remote MCP challenges missing tokens, publishes resource discovery and blocks Origin/Host rebinding', async t => {
  const f = await remoteFixture(t);
  const missing = await fetch(f.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'website-session=ignored' }, body: '{}' });
  assert.equal(missing.status, 401); assert.match(missing.headers.get('www-authenticate'), /resource_metadata=/);
  const metadata = await (await fetch(new URL('/.well-known/oauth-protected-resource', f.endpoint))).json();
  assert.equal(metadata.resource, f.endpoint); assert.deepEqual(metadata.authorization_servers, ['https://website.example']);
  assert.equal((await fetch(f.endpoint, { method: 'POST', headers: { Origin: 'https://attacker.example', Authorization: `Bearer ${tokenA}` } })).status, 403);
  const badHostStatus = await new Promise((resolve, reject) => { const request = http.request(f.endpoint, { method: 'POST', headers: { Host: 'attacker.example', Authorization: `Bearer ${tokenA}` } }, response => { response.resume(); resolve(response.statusCode); }); request.once('error', reject); request.end(); });
  assert.equal(badHostStatus, 403);
  assert.equal(f.sessions.length, 0);
});

test('real SDK HTTP discovery and tools isolate accounts and block remote filesystem inputs', async t => {
  const f = await remoteFixture(t); const a = await f.connect(tokenA); const b = await f.connect(tokenB);
  const tools = await a.listTools(); assert.equal(tools.tools.length, 13);
  assert.match(tools.tools.find(tool => tool.name === 'upload_asset').description, /远程/);
  const call = async (client, name, args) => client.callTool({ name, arguments: args });
  const first = await call(a, 'quote_generation', quoteInput); assert.equal(first.isError, undefined);
  const second = await call(b, 'quote_generation', { ...quoteInput, prompt: 'different account payload' }); assert.equal(second.isError, undefined);
  assert.equal(f.observed.quotes, 2);
  const upload = await call(a, 'upload_asset', { file_path: 'C:/server-secret-file' });
  assert.equal(upload.structuredContent.error.code, 'REMOTE_UPLOAD_UNAVAILABLE'); assert.equal(f.observed.uploads, 0);
  const invalid = await call(a, 'quote_generation', { ...quoteInput, url: 'http://127.0.0.1/private' }); assert.equal(invalid.isError, true);
  assert.ok(f.envs.some(env => env.MUBAI_API_KEY === tokenA)); assert.ok(f.envs.some(env => env.MUBAI_API_KEY === tokenB));
  assert.ok(f.envs.every(env => env.MUBAI_OAUTH_RESOURCE === f.endpoint && env.MUBAI_API_SECRET === '' && env.MUBAI_REMOTE_MODE === '1'));
  assert.ok(f.observed.resourceHeaders.length > 0 && f.observed.resourceHeaders.every(value => value === f.endpoint));
  f.revoke(); await assert.rejects(a.listTools());
});

test('remote MCP rejects schema/JSON failures and unsafe deployment configuration', async t => {
  const f = await remoteFixture(t);
  const headers = { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  assert.equal((await fetch(f.endpoint, { method: 'POST', headers, body: 'invalid' })).status, 400);
  assert.equal((await fetch(f.endpoint, { method: 'POST', headers, body: JSON.stringify({ method: 42 }) })).status, 400);
  const stateDir = await mkdtemp(path.join(tmpdir(), 'bk-http-config-')); t.after(() => rm(stateDir, { recursive: true, force: true }));
  const base = { websiteOrigin: 'https://website.example', resourceUrl: 'https://mcp.example.com/mcp', stateDir };
  assert.throws(() => createRemoteServer({ ...base, host: '0.0.0.0' }));
  assert.throws(() => createRemoteServer({ ...base, resourceUrl: 'http://mcp.example.com/mcp' }));
  assert.throws(() => createRemoteServer({ ...base, resourceUrl: 'https://user:key@mcp.example.com/mcp' }));
});
