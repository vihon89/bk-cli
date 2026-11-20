import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { safeError, MediaError } from '../src/client.mjs';
import { AuthError } from '../src/credential-store.mjs';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
async function isolated(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'mubai CLI auth 空格 '));
  t.after(() => rm(home, { recursive: true, force: true }));
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) if (key.toUpperCase().startsWith('MUBAI_')) delete environment[key];
  environment.MUBAI_CREDENTIAL_DIR = path.join(home, '.mubai-media-mcp/auth');
  return { home, run: args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  }) };
}

test('real CLI invalid auth arguments retain INVALID_ARGUMENTS and never echo forbidden key input', async t => {
  const f = await isolated(t); const secret = 'FIXTURE_ONLY_DO_NOT_ECHO_KEY';
  const result = await f.run(['login', '--home', f.home, '--api-key', secret]);
  assert.equal(result.code, 1); assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_ARGUMENTS');
  assert.ok(!(result.stdout + result.stderr).includes(secret)); assert.doesNotMatch(result.stderr, /操作 ID/);
});

test('real CLI unconnected auth and business commands clearly request login without website access', async t => {
  const f = await isolated(t);
  for (const command of [['login', '--home', f.home], ['status', '--home', f.home], ['get_account']]) {
    const result = await f.run(command);
    assert.equal(result.code, 1);
    const output = JSON.parse(result.stderr || result.stdout);
    assert.equal(output.error.code, 'LOGIN_REQUIRED'); assert.match(output.error.message, /login|登录/);
    assert.doesNotMatch(output.error.message, /操作 ID/);
  }
});

test('real CLI invalid authorization origin is a static configuration error with no URL credential echo', async t => {
  const f = await isolated(t); const secret = 'FIXTURE_PASSWORD_NEVER_ECHO';
  const result = await f.run(['login', '--home', f.home, '--client', 'codex', '--base-url', `https://user:${secret}@website.example`]);
  assert.equal(result.code, 1); assert.equal(JSON.parse(result.stderr).error.code, 'INVALID_ORIGIN');
  assert.ok(!(result.stdout + result.stderr).includes(secret)); assert.doesNotMatch(result.stderr, /操作 ID/);
});

test('safeError preserves only trusted auth/media errors and redacts forged or raw network errors', () => {
  for (const code of ['access_denied', 'expired_token', 'LOGIN_REQUIRED']) {
    assert.deepEqual(safeError(new AuthError(code, '请重新运行 login。')), { code, message: '请重新运行 login。' });
  }
  assert.equal(safeError(new MediaError('LIMIT_EXCEEDED', '预算不足。')).code, 'LIMIT_EXCEEDED');
  for (const error of [new Error('RAW_NETWORK_FIXTURE_SECRET'), { code: 'access_denied', message: 'RAW_NETWORK_FIXTURE_SECRET' }]) {
    const result = safeError(error); assert.equal(result.code, 'CLIENT_ERROR'); assert.ok(!JSON.stringify(result).includes('RAW_NETWORK_FIXTURE_SECRET'));
  }
});
