import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { AuthError, createCredentialStore, osVault, credentialIsCurrent, storedCredential } from '../src/credential-store.mjs';
import { authArguments, runAuth, deviceRequest } from '../src/device-auth.mjs';
import { websiteOrigin } from '../src/origin.mjs';
import { configFromSources } from '../src/client.mjs';
import { buildTools, executeTool } from '../src/tools.mjs';
import { syncChatModels } from '../src/chat-models.mjs';

const origin = 'https://website.example';
const token = () => ({ api_key: 'sk-mbag-' + 'a'.repeat(64), base_url: origin, api_app_id: 8, account_id: 7, expires_at: Math.floor(Date.now() / 1000) + 86400, service_enabled: false, receipt: 'b'.repeat(32) });
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'mubai auth 空格 ')); t.after(() => rm(directory, { recursive: true, force: true }));
  const secrets = new Map();
  const vault = { read: async id => secrets.get(id) ?? null, write: async (id, value) => { secrets.set(id, value); }, remove: async id => { secrets.delete(id); } };
  const store = createCredentialStore({ directory, vault });
  return { directory, secrets, vault, store };
}
const challenge = () => ({ device_code: 'd'.repeat(64), user_code: 'ABCD-EFGH', request_id: 'c'.repeat(32), verification_uri_complete: origin + '/home/#/ai-tool/authorize?request=' + 'c'.repeat(32), expires_in: 600, interval: 3, authorization_origin: origin, service_enabled: false });
const session = value => ({ connected: true, account_id: value.account_id, api_app_id: value.api_app_id, expires_at: value.expires_at, service_enabled: false, balance_score: 400 });

test('generic browser consent immediately syncs the approved chat catalog without printing a credential', async t => {
  const f = await fixture(t);
  const granted = token();
  const calls = [];
  const result = await runAuth('login', { baseUrl: origin, client: 'generic', chat: true, noBrowser: true, home: f.directory }, {
    env: {}, store: f.store,
    request: async (_site, endpoint, options) => {
      calls.push(endpoint);
      if (endpoint === 'start') {
        assert.equal(options.body.chat_models, true);
        assert.equal(options.body.client, 'generic');
        return challenge();
      }
      if (endpoint === 'token') return granted;
      if (endpoint === 'ack') return { ok: true };
      if (endpoint === 'session') return { ...session(granted), chat_authorized: true, chat_enabled: true };
      throw new Error('Unexpected request');
    },
    syncModels: (site, profile, settings) => syncChatModels(site, profile, { ...settings,
      fetchImpl: async () => Response.json({ data: [{ id: 'bk-chat-4', display_name: 'BK 同步模型', tools: true, images: false, streaming: true }] }),
    }),
  });
  assert.deepEqual(calls, ['start', 'token', 'ack', 'session']);
  assert.equal(result.chat_import_mode, 'provider_file');
  assert.equal(result.chat_models, 1);
  assert.ok(!JSON.stringify(result).includes(granted.api_key));
  assert.equal(JSON.parse(await readFile(result.chat_config_path, 'utf8')).models[0].name, 'BK 同步模型');
});

test('authorization origins and CLI arguments reject accidental private sites and secret arguments', () => {
  assert.equal(websiteOrigin('http://localhost:10040', { allowHttpLocalhost: true }), 'http://localhost:10040');
  assert.equal(websiteOrigin('http://127.0.0.1:18342', { allowHttpLocalhost: true }), 'http://127.0.0.1:18342');
  assert.throws(() => websiteOrigin('http://127.0.0.1:1023', { allowHttpLocalhost: true }));
  for (const value of ['http://localhost:10040', 'https://127.0.0.1', 'https://10.0.0.1', 'https://site.internal', 'https://site.example:18793']) assert.throws(() => websiteOrigin(value));
  assert.throws(() => websiteOrigin('http://localhost:18793', { allowHttpLocalhost: false }));
  assert.throws(() => authArguments(['--api-key', 'SECRET']));
  assert.throws(() => authArguments(['--client', 'codex', '--client', 'workbuddy']));
});

test('browser failure and slow polling keep one proof; persist before ACK and validate disabled session', async t => {
  const f = await fixture(t); const granted = token(); const calls = []; const progress = []; let clock = Date.now(); let polls = 0;
  const request = async (site, endpoint, options) => {
    assert.equal(site, origin); calls.push({ endpoint, ...options });
    if (endpoint === 'start') { assert.match(options.body.code_challenge, /^[A-Za-z0-9_-]{43}$/); return challenge(); }
    if (endpoint === 'token') { polls++; if (polls <= 2) { const error = new AuthError(polls === 1 ? 'authorization_pending' : 'slow_down', 'fixture'); error.retryAfter = 9; throw error; } return granted; }
    if (endpoint === 'ack') { assert.equal((await f.store.read(origin)).api_key, granted.api_key); return { ok: true }; }
    if (endpoint === 'session') return session(granted);
    throw new Error('unexpected endpoint');
  };
  const result = await runAuth('login', { baseUrl: origin, client: 'codex', skill: 'all' }, { store: f.store, request, now: () => clock, sleep: async ms => { clock += ms; }, openBrowser: async () => false, progress: item => progress.push(item) });
  assert.equal(result.connected, true); assert.equal(result.service_enabled, false); assert.equal(result.balance_score, 400);
  assert.equal(calls.filter(call => call.endpoint === 'start').length, 1);
  assert.equal(new Set(calls.filter(call => call.endpoint === 'token').map(call => call.body.code_verifier)).size, 1);
  assert.equal(await f.store.pending(origin), null);
  const output = JSON.stringify({ result, progress });
  for (const secret of [granted.api_key, granted.receipt, challenge().device_code, calls.find(call => call.endpoint === 'token').body.code_verifier]) assert.ok(!output.includes(secret));
  assert.equal(progress[1].browser_opened, false);
});

test('lost ACK response recovers persisted receipt without minting a second challenge', async t => {
  const f = await fixture(t); const granted = token(); let starts = 0; let acknowledgements = 0;
  const request = async (_origin, endpoint) => {
    if (endpoint === 'start') { starts++; return challenge(); }
    if (endpoint === 'token') return granted;
    if (endpoint === 'ack') { if (++acknowledgements === 1) throw new AuthError('AUTH_NETWORK', 'fixture'); return { ok: true }; }
    return session(granted);
  };
  const options = { baseUrl: origin, client: 'codex', noBrowser: true };
  await assert.rejects(runAuth('login', options, { store: f.store, request }), { code: 'AUTH_NETWORK' });
  assert.equal((await f.store.pending(origin)).receipt, granted.receipt);
  const result = await runAuth('login', options, { store: f.store, request });
  assert.equal(result.reused, true); assert.equal(starts, 1); assert.equal(acknowledgements, 2);
});

test('vault write failure never acknowledges token; original proof can resume', async t => {
  const f = await fixture(t); let acknowledged = false;
  const request = async (_origin, endpoint) => { if (endpoint === 'start') return challenge(); if (endpoint === 'token') return token(); if (endpoint === 'ack') acknowledged = true; return {}; };
  const originalSave = f.store.save;
  f.store.save = async () => { throw new AuthError('SECURE_STORE_UNAVAILABLE', 'fixture'); };
  await assert.rejects(runAuth('login', { baseUrl: origin, client: 'workbuddy', noBrowser: true }, { store: f.store, request }), { code: 'SECURE_STORE_UNAVAILABLE' });
  assert.equal(acknowledged, false); assert.ok((await f.store.pending(origin)).code_verifier);
  f.store.save = originalSave;
});

test('adding video to image authorization requests the union; all authorization then reuses without rotation', async t => {
  const f = await fixture(t); const granted = token(); await f.store.save(origin, { ...granted, granted_skill: 'images' });
  const starts = [];
  const request = async (_site, endpoint, options) => {
    if (endpoint === 'start') { starts.push(options.body.skill); return challenge(); }
    if (endpoint === 'token') return granted;
    if (endpoint === 'session') return session(granted);
    return { ok: true };
  };
  const result = await runAuth('login', { baseUrl: origin, client: 'codex', skill: 'video', noBrowser: true }, { store: f.store, request });
  assert.deepEqual(starts, ['all']); assert.equal(result.requested_skill_satisfied, true);
  const second = await runAuth('login', { baseUrl: origin, client: 'workbuddy', skill: 'images', noBrowser: true }, { store: f.store, request });
  assert.equal(second.reused, true); assert.equal(starts.length, 1);
});

test('both pending delivery and pending receipt finish the original request then authorize added Skill in one login', async t => {
  for (const receiptPending of [false, true]) {
    const f = await fixture(t); const granted = token(); const old = challenge(); const scopes = []; let delivered = 0;
    await f.store.savePending(origin, { schema: 1, ...old, requested_skill: 'images', client: 'codex', code_verifier: 'v'.repeat(43), expires_at_ms: Date.now() + 600000, ...(receiptPending ? { receipt: granted.receipt } : {}) });
    if (receiptPending) await f.store.save(origin, { ...granted, granted_skill: 'images' });
    const request = async (_site, endpoint, options) => {
      if (endpoint === 'start') { scopes.push(options.body.skill); return challenge(); }
      if (endpoint === 'token') { delivered++; return granted; }
      if (endpoint === 'session') return session(granted);
      return { ok: true };
    };
    const result = await runAuth('login', { baseUrl: origin, client: 'codex', skill: 'video', noBrowser: true }, { store: f.store, request });
    assert.equal(result.requested_skill_satisfied, true); assert.deepEqual(scopes, ['all']);
    assert.equal(delivered, receiptPending ? 1 : 2); assert.equal((await f.store.read(origin)).granted_skill, 'all');
  }
});

test('terminal pending ACK clears only pending proof and permits a fresh forced authorization', async t => {
  const f = await fixture(t); const granted = token(); let acknowledgements = 0; let starts = 0;
  await f.store.save(origin, { ...granted, granted_skill: 'images' });
  await f.store.savePending(origin, { schema: 1, ...challenge(), requested_skill: 'images', client: 'codex', code_verifier: 'v'.repeat(43), expires_at_ms: Date.now() + 600000, receipt: granted.receipt });
  const request = async (_site, endpoint) => {
    if (endpoint === 'ack' && acknowledgements++ === 0) throw new AuthError('INVALID_RECEIPT', 'fixture');
    if (endpoint === 'start') { starts++; return challenge(); }
    if (endpoint === 'token') return granted;
    if (endpoint === 'session') return session(granted);
    return { ok: true };
  };
  const result = await runAuth('login', { baseUrl: origin, client: 'codex', skill: 'all', force: true, noBrowser: true }, { store: f.store, request });
  assert.equal(result.connected, true); assert.equal(result.requested_skill_satisfied, true); assert.equal(starts, 1);
});

test('killed auth process lock is recovered without stealing a live lock and reuses the stored proof', async t => {
  const f = await fixture(t); const original = { schema: 1, ...challenge(), requested_skill: 'all', client: 'codex', code_verifier: 'v'.repeat(43), expires_at_ms: Date.now() + 600000 };
  await f.store.savePending(origin, original);
  const moduleUrl = new URL('../src/credential-store.mjs', import.meta.url).href;
  const script = `import {createCredentialStore} from ${JSON.stringify(moduleUrl)}; await createCredentialStore({directory:${JSON.stringify(f.directory)}}).locked(${JSON.stringify(origin)},async()=>{process.stdout.write('LOCKED\\n'); await new Promise(()=>setInterval(()=>{},1000));});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('child lock timeout')), 5000);
    child.stdout.once('data', () => { clearTimeout(deadline); resolve(); }); child.once('error', reject);
  });
  await assert.rejects(f.store.locked(origin, async () => {}), { code: 'AUTH_BUSY' });
  const stopped = new Promise(resolve => child.once('close', resolve)); child.kill('SIGKILL'); await stopped;
  let proof;
  const result = await runAuth('login', { baseUrl: origin, client: 'codex', skill: 'all', noBrowser: true }, { store: f.store, request: async (_site, endpoint, options) => {
    if (endpoint === 'start') throw new Error('must reuse original challenge');
    if (endpoint === 'token') { proof = options.body; return token(); }
    if (endpoint === 'session') return session(token());
    return { ok: true };
  } });
  assert.equal(result.connected, true); assert.equal(proof.code_verifier, original.code_verifier); assert.equal(proof.device_code, original.device_code);
});

test('denied request terminates and clears only pending proof; revoke uses authenticated empty JSON', async t => {
  const f = await fixture(t);
  await assert.rejects(runAuth('login', { baseUrl: origin, client: 'codex', noBrowser: true }, { store: f.store,
    request: async (_site, endpoint) => { if (endpoint === 'start') return challenge(); throw new AuthError('access_denied', 'fixture'); } }), { code: 'access_denied' });
  assert.equal(await f.store.pending(origin), null);
  await f.store.save(origin, token()); let revoked = false;
  const result = await runAuth('logout', { baseUrl: origin, revoke: true }, { store: f.store, request: async (_site, endpoint, options) => {
    assert.equal(endpoint, 'revoke'); assert.equal(options.key, token().api_key); assert.deepEqual(options.body, {}); revoked = true; return { ok: true };
  } });
  assert.equal(revoked, true); assert.equal(result.server_revoked, true); assert.equal(await f.store.read(origin), null);
});

test('logout removes only active account, never selects another or deletes operation state', async t => {
  const f = await fixture(t); const first = token(); const second = { ...token(), account_id: 9, api_app_id: 10, api_key: 'sk-mbag-' + 'e'.repeat(64) };
  await f.store.save(origin, first); await f.store.save(origin, second);
  const result = await runAuth('logout', { baseUrl: origin }, { store: f.store, request: async () => { throw new Error('local logout must not call website'); } });
  assert.equal(result.operation_records_preserved, true); assert.equal(await f.store.read(origin), null);
  assert.ok([...f.secrets.values()].some(value => value.includes(first.api_key)));
  assert.ok(![...f.secrets.values()].some(value => value.includes(second.api_key)));
});

test('legacy env key takes priority; placeholder key/origin resolve from current vault each time', async t => {
  const f = await fixture(t); const first = token(); await f.store.save(origin, first);
  const legacy = await configFromSources({ MUBAI_BASE_URL: origin, MUBAI_API_KEY: 'legacy-manual-key' }, { store: { connection: () => { throw new Error('do not access vault'); } } });
  assert.equal(legacy.apiKey, 'legacy-manual-key');
  const env = { MUBAI_BASE_URL: 'https://YOUR-WEBSITE.example', MUBAI_API_KEY: 'REPLACE_WITH_YOUR_WEBSITE_KEY_LOCALLY' };
  assert.equal((await configFromSources(env, { store: f.store })).apiKey, first.api_key);
  await f.store.logout(origin);
  await assert.rejects(configFromSources(env, { store: f.store }), { code: 'LOGIN_REQUIRED' });
});

test('device HTTP helper sends no cookies, refuses redirects and never exposes upstream secret errors', async () => {
  const fake = async (_url, options) => {
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); assert.equal(options.headers.Cookie, undefined);
    return new Response(JSON.stringify({ error: { code: 'invalid_token', message: 'SECRET_PROVIDER_MESSAGE' } }), { status: 401 });
  };
  await assert.rejects(deviceRequest(origin, 'session', { key: token().api_key, fetchImpl: fake }), error => error.code === 'invalid_token' && !error.message.includes('SECRET_PROVIDER_MESSAGE'));
});

test('macOS Keychain adapter puts secret only on stdin and supports read/delete using mocked OS commands', async t => {
  const f = await fixture(t); const calls = []; let stored = null;
  const run = async (command, args, input) => {
    calls.push({ command, args, input }); assert.equal(command, '/usr/bin/security');
    if (args[0] === '-i') { stored = input.match(/ -w ([A-Za-z0-9_-]+)\n$/)[1]; return { code: 0, output: '' }; }
    if (args[0] === 'find-generic-password') return { code: stored ? 0 : 44, output: stored || '' };
    stored = null; return { code: 0, output: '' };
  };
  const vault = osVault(f.directory, { platform: 'darwin', run }); const id = 'a'.repeat(64); const value = JSON.stringify(token());
  await vault.write(id, value); assert.equal(await vault.read(id), value); await vault.remove(id); assert.equal(await vault.read(id), null);
  assert.ok(calls.every(call => !JSON.stringify(call.args).includes(token().api_key) && !call.args.includes('-v')));
  assert.deepEqual(calls[0].args, ['-i', '-q']);
});

test('Windows DPAPI encrypts on disk and long-lived MCP tools stop using a logged-out key', { skip: process.platform !== 'win32' }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mubai dpapi isolated ')); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createCredentialStore({ directory }); const granted = token(); await store.save(origin, granted);
  for (const name of await readdir(directory)) assert.ok(!(await readFile(path.join(directory, name), 'utf8')).includes(granted.api_key));
  assert.equal((await store.read(origin)).api_key, granted.api_key);
  const originalFetch = globalThis.fetch; let requests = 0;
  globalThis.fetch = async (_url, options) => { requests++; assert.equal(options.headers.Authorization, 'Bearer ' + granted.api_key); return new Response(JSON.stringify({ data: { account_id: 7, api_app_id: 8, balance_score: 10 } }), { status: 200 }); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const def = buildTools({ MUBAI_CREDENTIAL_DIR: directory }).find(tool => tool.name === 'get_account');
  assert.equal((await executeTool(def, {})).isError, undefined);
  await store.logout(origin);
  const after = await executeTool(def, {});
  assert.equal(after.structuredContent.error.code, 'LOGIN_REQUIRED'); assert.equal(requests, 1);
});


test('no-wait authorization returns the matching code and link without polling; wait resumes the same proof', async t => {
  const f = await fixture(t), calls=[]; const granted={...token(),expires_at:0,non_expiring:true};
  const request=async (_site,endpoint,options)=>{
    calls.push(endpoint);
    if(endpoint==='start'){assert.equal(options.body.authorization_policy_version,2);return challenge();}
    if(endpoint==='token')return granted;
    if(endpoint==='session')return {...session(granted),non_expiring:true};
    return {ok:true};
  };
  const options={baseUrl:origin,client:'workbuddy',skill:'images',noBrowser:true,noWait:true};
  const first=await runAuth('login',options,{store:f.store,request});
  assert.equal(first.connected,false);assert.equal(first.authorization_pending,true);assert.equal(first.user_code,'ABCD-EFGH');assert.equal(first.verification_url,challenge().verification_uri_complete);
  assert.deepEqual(calls,['start']);assert.equal(await f.store.read(origin),null);
  assert.doesNotMatch(JSON.stringify(first),/device_code|code_verifier|api_key|receipt/);
  const resumed=await runAuth('login',options,{store:f.store,request});assert.equal(resumed.user_code,first.user_code);assert.deepEqual(calls,['start']);
  const complete=await runAuth('login',{...options,noWait:false,wait:true},{store:f.store,request});
  assert.equal(complete.connected,true);assert.equal(complete.expires_at,0);assert.equal(complete.non_expiring,true);assert.equal(await f.store.pending(origin),null);
  const credential=await storedCredential({env:{MUBAI_BASE_URL:origin},store:f.store});assert.equal(credential.expires_at,0);
});

test('zero expiry is valid only with the explicit non-expiring marker, and revocation still forces reauthorization', async t=>{
  assert.equal(credentialIsCurrent({expires_at:0}),false);assert.equal(credentialIsCurrent({expires_at:0,non_expiring:false}),false);
  assert.equal(credentialIsCurrent({expires_at:-1,non_expiring:true}),false);assert.equal(credentialIsCurrent({expires_at:0,non_expiring:true}),true);
  const f=await fixture(t);const granted={...token(),expires_at:0,non_expiring:true,granted_skill:'images'};await f.store.save(origin,granted);
  let starts=0;const request=async (_site,endpoint)=>{
    if(endpoint==='session')throw new AuthError('api_key_disabled','revoked');
    if(endpoint==='start'){starts++;return challenge();}
    throw Error('no token polling before consent');
  };
  const pending=await runAuth('login',{baseUrl:origin,client:'codex',skill:'images',noBrowser:true,noWait:true},{store:f.store,request});
  assert.equal(pending.authorization_pending,true);assert.equal(starts,1);assert.equal((await f.store.read(origin)).api_key,granted.api_key);
  await assert.rejects(storedCredential({env:{MUBAI_BASE_URL:origin},store:{read:async()=>({...granted,non_expiring:false})}}),{code:'LOGIN_REQUIRED'});
});

test('unmarked zero expiry from a token response never enters the secure store', async t=>{
  const f=await fixture(t);await assert.rejects(runAuth('login',{baseUrl:origin,client:'codex',noBrowser:true},{store:f.store,request:async (_site,endpoint)=>endpoint==='start'?challenge():({...token(),expires_at:0})}),{code:'AUTH_RESPONSE'});
  assert.equal(await f.store.read(origin),null);
  assert.throws(()=>authArguments(['--wait','--no-wait']),{code:'INVALID_ARGUMENTS'});
});


test('force plus split login completes one authorization, including a lost ACK response', async t=>{
  for(const dropAck of [false,true]){
    const f=await fixture(t);let starts=0,acks=0;
    const granted={...token(),expires_at:0,non_expiring:true};
    const request=async (_site,endpoint)=>{
      if(endpoint==='start'){starts++;return challenge();}
      if(endpoint==='token')return granted;
      if(endpoint==='ack'){acks++;if(dropAck&&acks===1)throw new AuthError('AUTH_NETWORK','response lost');return {ok:true};}
      if(endpoint==='session')return {...session(granted),non_expiring:true};
      throw Error('unexpected');
    };
    const args={baseUrl:origin,client:'workbuddy',skill:'all',force:true,noBrowser:true};
    const first=await runAuth('login',{...args,noWait:true},{store:f.store,request});assert.equal(first.authorization_pending,true);
    if(dropAck)await assert.rejects(runAuth('login',{...args,wait:true},{store:f.store,request}),{code:'AUTH_NETWORK'});
    const final=await runAuth('login',{...args,wait:true},{store:f.store,request});
    assert.equal(final.connected,true);assert.equal(starts,1);assert.equal(await f.store.pending(origin),null);
  }
});

test('Windows self-check separates save, readback and existing profile failures', async t => {
  const { directory } = await fixture(t);
  let failAction;
  const run = async (_cmd, _args, input) => {
    const {action, data} = JSON.parse(input);
    return action === failAction ? {code: 1, output: ''} : {code: 0, output: data};
  };
  const store = createCredentialStore({directory, env: {}, platform: 'win32', run});
  failAction = 'protect';
  assert.equal((await store.diagnoseWindows()).storage, 'WINDOWS_CREDENTIAL_SAVE_FAILED');
  failAction = 'unprotect';
  assert.equal((await store.diagnoseWindows()).storage, 'WINDOWS_CREDENTIAL_VERIFY_FAILED');
  failAction = undefined;
  await store.save(origin, token());
  const files = await readdir(directory);
  const active = files.find(name => name.endsWith('.vault'));
  const {writeFile} = await import('node:fs/promises');
  await writeFile(path.join(directory, active), 'broken');
  const report = await store.diagnoseWindows();
  assert.equal(report.storage, 'ok');
  assert.equal(report.authorization, 'read_failed');
  assert.equal(report.cleanup, 'ok');
  assert.deepEqual(await readdir(directory), files);
  assert.ok(!JSON.stringify(report).includes(token().api_key));
});
