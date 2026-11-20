import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCredentialStore, credentialDirectory } from '../src/credential-store.mjs';
import { configFromSources } from '../src/client.mjs';
import { runAuth } from '../src/device-auth.mjs';
import { jsonConfiguration, HOST_ADAPTERS } from '../src/host-adapters.mjs';
import { codexAddition } from '../src/installer.mjs';
import { parse } from 'smol-toml';

test('same-origin host profiles isolate accounts, logout and legacy storage without copying tokens', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'BK client profiles ')); t.after(() => rm(directory, { recursive: true, force: true }));
  const values = new Map(); const vault = { read: async id => values.get(id) ?? null, write: async (id, value) => { values.set(id, value); }, remove: async id => { values.delete(id); } };
  const envFor = client => ({ MUBAI_CREDENTIAL_DIR: directory, ...(client ? { MUBAI_CLIENT_ID: client } : {}) });
  const createStore = options => createCredentialStore({ ...options, vault });
  const origin = 'https://website.example';
  const profile = (account, key) => ({ base_url: origin, account_id: account, api_app_id: account + 10, api_key: key, expires_at: Math.floor(Date.now() / 1000) + 600, granted_skill: 'all' });
  const legacy = createStore({ env: envFor() }); await legacy.save(origin, profile(99, 'LEGACY_TEST_KEY'));
  const codex = createStore({ env: envFor('codex') }); const workbuddy = createStore({ env: envFor('workbuddy') });
  assert.equal(await codex.read(origin), null); assert.equal(await workbuddy.read(origin), null);
  await assert.rejects(configFromSources(envFor('openclaw'), { store: createStore({ env: envFor('openclaw') }) }), { code: 'LOGIN_REQUIRED' });
  await codex.save(origin, profile(1, 'CODEX_TEST_KEY')); await workbuddy.save(origin, profile(2, 'WORKBUDDY_TEST_KEY'));
  assert.equal((await configFromSources(envFor('codex'), { store: codex })).apiKey, 'CODEX_TEST_KEY');
  assert.equal((await configFromSources(envFor('workbuddy'), { store: workbuddy })).apiKey, 'WORKBUDDY_TEST_KEY');
  const request = async (_origin, endpoint, options) => { assert.equal(endpoint, 'session'); assert.equal(options.key, 'WORKBUDDY_TEST_KEY'); return { connected: true, account_id: 2, api_app_id: 12, expires_at: (await workbuddy.read(origin)).expires_at, service_enabled: true }; };
  assert.equal((await runAuth('status', {}, { env: envFor('workbuddy'), createStore, request })).account_id, 2);
  await runAuth('logout', { client: 'codex' }, { env: envFor(), createStore });
  assert.equal(await codex.read(origin), null); assert.equal((await workbuddy.read(origin)).account_id, 2); assert.equal((await legacy.read(origin)).account_id, 99);
  assert.equal((await configFromSources(envFor(), { store: legacy })).apiKey, 'LEGACY_TEST_KEY');
  assert.equal(credentialDirectory({ env: envFor('codex') }), path.join(directory, 'clients', 'codex'));
  assert.throws(() => credentialDirectory({ env: envFor('../escape') }), { code: 'INVALID_CLIENT_PROFILE' });
  await assert.rejects(runAuth('status', { client: 'codex' }, { env: envFor('workbuddy'), createStore }), { code: 'CLIENT_PROFILE_CONFLICT' });
});

test('managed entries add only their non-secret profile, preserve existing settings, and reject explicit conflicts', () => {
  const launcher = '/managed/launch.mjs';
  const original = '# original comment\n[mcp_servers.mubai_media]\ncommand = ' + JSON.stringify(process.execPath) + '\nargs = [' + JSON.stringify(launcher) + ']\n[mcp_servers.mubai_media.env]\nMUBAI_BASE_URL = "https://website.example"\nMUBAI_API_KEY = "LOCAL_MANUAL_TEST_KEEP"\n[other]\nkeep = true\n';
  const migrated = codexAddition(original, parse(original), launcher, 'https://new.example'); const parsed = parse(migrated.text);
  assert.equal(parsed.mcp_servers.mubai_media.env.MUBAI_CLIENT_ID, 'codex'); assert.equal(parsed.mcp_servers.mubai_media.env.MUBAI_API_KEY, 'LOCAL_MANUAL_TEST_KEEP'); assert.equal(parsed.other.keep, true); assert.match(migrated.text, /original comment/);
  assert.equal(codexAddition(migrated.text, parsed, launcher, 'https://new.example').skipped, true);
  parsed.mcp_servers.mubai_media.env.MUBAI_CLIENT_ID = 'workbuddy'; assert.throws(() => codexAddition(migrated.text, parsed, launcher, 'https://new.example'), /profile conflicts/);
  const document = { other: { keep: 1 }, mcpServers: { mubai_media: { command: process.execPath, args: [launcher], env: { KEEP: 'value' } } } };
  const json = JSON.parse(jsonConfiguration(JSON.stringify(document), HOST_ADAPTERS.workbuddy, launcher, 'https://new.example', process.execPath).text);
  assert.equal(json.mcpServers.BK.env.MUBAI_CLIENT_ID, 'workbuddy'); assert.equal(json.mcpServers.BK.env.KEEP, 'value'); assert.equal(json.other.keep, 1);
  json.mcpServers.BK.env.MUBAI_CLIENT_ID = 'codex'; assert.throws(() => jsonConfiguration(JSON.stringify(json), HOST_ADAPTERS.workbuddy, launcher, 'https://new.example', process.execPath), /profile conflicts/);
});
