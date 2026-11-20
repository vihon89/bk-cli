import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyUpdate, checkUpdate, skipUpdate, withUpdateNotice } from '../src/updates.mjs';

const origin = 'http://localhost:10040';
async function installation(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'bk update test '));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = path.join(home, '.mubai-media-mcp');
  const runtimeDirectory = path.join(root, 'versions', '0.6.9');
  const currentPath = path.join(root, 'current.json');
  await mkdir(runtimeDirectory, { recursive: true });
  const setVersion = (version, extra = {}) => writeFile(currentPath, JSON.stringify({ schema: 1, version,
    installs: { workbuddy: { version, origin, allowHttpLocalhost: true, isolated: true, skill: 'all', ...extra } } }));
  await setVersion('0.6.9');
  return { home, root, runtimeDirectory, setVersion };
}

test('automatic check deduplicates requests and reports only the authorized installation, preserving business data', async t => {
  const fixture = await installation(t);
  const profile = { api_key: 'fixture-key', base_url: origin, expires_at: 0, non_expiring: true, chat_granted: true };
  let clock = 1000, releases = 0, reports = 0, syncs = 0;
  const options = { ...fixture, env: {}, now: () => clock, release: async url => {
    assert.equal(url, origin); releases++; return { version: '0.6.10' };
  }, store: { connection: async () => ({ origin }), read: async () => profile, locked: async (_origin, run) => run() },
  request: async (url, endpoint, { key, body }) => {
    assert.equal(url, origin); assert.equal(endpoint, 'version'); assert.equal(key, profile.api_key);
    assert.deepEqual(body, { version: '0.6.9' }); reports++;
  }, syncModels: async (_url, authorized, { home }) => {
    assert.equal(authorized, profile); assert.equal(home, fixture.home); syncs++;
  } };
  const result = { structuredContent: { data: { score: 100 } } };
  const [notice, check] = await Promise.all([withUpdateNotice(result, options), checkUpdate(options)]);
  assert.equal(check.status, 'update_available');
  assert.deepEqual(notice.structuredContent, { ...result.structuredContent, bk_update: check });
  assert.doesNotMatch(JSON.stringify(notice), /fixture-key/);
  assert.deepEqual([releases, reports, syncs], [1, 1, 1]);
  await checkUpdate(options);
  assert.equal(releases, 1);
  clock += 6 * 3600000;
  await checkUpdate(options);
  assert.deepEqual([releases, reports, syncs], [2, 2, 2]);
});

test('website recovery and restart verification distinguish authorization from local and service failures', async t => {
  const fixture = await installation(t);
  const version = '0.8.11';
  await fixture.setVersion(version, { verify_after_update: version });
  const profile = { api_key: 'fixture-secret', base_url: origin, non_expiring: true, expires_at: 0, chat_granted: true };
  let saved = profile;
  let modelError;
  let calls = 0;
  let authorizationStarts = 0;
  const options = {
    ...fixture, env: {}, maintain: false, platform: 'win32', force: true,
    release: async () => { throw new Error('offline'); },
    store: {
      diagnoseWindows: async () => ({ storage: 'ok' }),
      read: async () => {
        if (saved instanceof Error) throw saved;
        return saved;
      },
    },
    readModels: async () => { calls++; if (modelError) throw modelError; return [{ id: 'bk-chat-68' }]; },
    startAuthorization: async (command, args) => {
      authorizationStarts++;
      assert.equal(command, 'login');
      assert.equal(args.client, 'workbuddy');
      assert.equal(args.noWait && args.noBrowser && args.chat, true);
      return { authorization_pending: true, verification_url: origin + '/home/#/agent/access', user_code: 'TEST-CODE' };
    },
  };
  const before = await checkUpdate(options);
  assert.equal(before.status, 'restart_required');
  assert.equal(before.post_update_verification, undefined);
  assert.equal(calls, 0);
  options.runtimeDirectory = path.join(fixture.root, 'versions', version);
  const after = await checkUpdate(options);
  assert.equal(after.status, 'check_unavailable');
  assert.equal(after.install_guide_url, origin + '/api/agent-access/install-guide?skill=images');
  assert.equal(after.post_update_verification.chat_model_count, 1);
  assert.doesNotMatch(JSON.stringify(after), /fixture-secret/);
  assert.equal((await checkUpdate({ ...options, force: false })).post_update_verification, undefined);
  modelError = Object.assign(new Error(), { code: 'CHAT_SERVICE_DISABLED' });
  let verification = (await checkUpdate(options)).post_update_verification;
  assert.equal(verification.status, 'chat_check_unavailable');
  assert.equal(verification.authorization_guide_url, undefined);
  saved = Object.assign(new Error(), { code: 'WINDOWS_CREDENTIAL_READ_FAILED' });
  verification = (await checkUpdate(options)).post_update_verification;
  assert.equal(verification.status, 'credential_unreadable');
  assert.equal(verification.authorization_guide_url, undefined);
  assert.equal(authorizationStarts, 0);
  saved = null;
  verification = (await checkUpdate(options)).post_update_verification;
  assert.equal(verification.status, 'reauthorization_required');
  assert.equal(verification.authorization_guide_url, after.install_guide_url);
  assert.equal(verification.verification_url, origin + '/home/#/agent/access');
  assert.equal(authorizationStarts, 1);
});

test('updates require version-specific approval, retain local records, and report pending restart', async t => {
  const fixture = await installation(t);
  const marker = path.join(fixture.root, 'operations.json');
  await writeFile(marker, 'existing task state');
  let called = 0;
  const options = { ...fixture, env: { MUBAI_API_KEY: 'test-environment-override' },
    install: async (settings, args, dependencies) => {
      called++;
      assert.equal(settings.origin, origin);
      assert.deepEqual(args, ['--client', 'workbuddy', '--skill', 'all', '--no-login', '--home', fixture.home]);
      assert.deepEqual(dependencies, { expectedVersion: '0.7.0', quiet: true });
      await fixture.setVersion('0.7.0');
      return { configuration_status: 'workbuddy_renamed' };
    } };
  await assert.rejects(applyUpdate({ ...options, version: '0.7.0' }), { code: 'UPDATE_CONFIRMATION_REQUIRED' });
  await assert.rejects(applyUpdate({ ...options, version: '0.6.1', confirm: true }), { code: 'UPDATE_DOWNGRADE' });
  assert.equal(called, 0);
  const result = await applyUpdate({ ...options, version: '0.7.0', confirm: true });
  assert.equal(result.status, 'updated');
  assert.equal(result.workbuddy_trust_required, true);
  assert.equal((await applyUpdate({ ...options, version: '0.7.0', confirm: true })).status, 'already_installed');
  assert.equal((await checkUpdate({ ...options, release: async () => ({ version: '0.7.0' }) })).status, 'restart_required');
  assert.equal(await readFile(marker, 'utf8'), 'existing task state');
  assert.equal(called, 1);
});

test('business reminders repeat until the user skips the offered release', async t => {
  const fixture = await installation(t);
  let latest = '0.6.10';
  const options = { ...fixture, env: {}, maintain: false, release: async () => ({ version: latest }) };
  const result = { structuredContent: { data: { score: 100 } } };
  assert.equal((await withUpdateNotice(result, options)).structuredContent.bk_update.latest_version, latest);
  assert.equal((await withUpdateNotice(result, options)).structuredContent.bk_update.latest_version, latest);
  await assert.rejects(skipUpdate({ ...options, version: latest }), { code: 'UPDATE_CONFIRMATION_REQUIRED' });
  await skipUpdate({ ...options, version: latest, confirm: true });
  assert.equal(await withUpdateNotice(result, options), result);
  assert.equal((await checkUpdate(options)).latest_version, latest);
  latest = '0.6.11';
  await checkUpdate({ ...options, force: true });
  assert.equal((await withUpdateNotice(result, options)).structuredContent.bk_update.latest_version, latest);
});