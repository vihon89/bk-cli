import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MediaClient, configFromEnv, safeError } from '../src/client.mjs';
import { MediaService } from '../src/service.mjs';
import { AccountOperationStore } from '../src/operation-store.mjs';
import { fixture, quoteInput } from './helpers.mjs';
import { buildTools } from '../src/tools.mjs';

test('optional model selection freezes the chosen quote across default changes and retry', async t => {
  const f = await fixture(t); const api = service(f.env); const request = api.client.request.bind(api.client);
  let quotes = 0;
  api.client.request = async (method, endpoint, body, options) => {
    if (endpoint !== '/quotes') return request(method, endpoint, body, options);
    quotes++;
    assert.equal(body.model, undefined);
    assert.equal(body.model_strategy, 'cheapest');
    return {quote_id:'aq_test',total_score:30,expires_at:Date.now()+600000,model:'bk-2',selection:{strategy:'cheapest',compared_models:4},effective_params:{n:1,ratio:'1:1',size:'1024x1024'}};
  };
  const input = {...quoteInput,model_strategy:'cheapest'}; delete input.model;
  const first = await api.quote(input);
  const replay = await api.quote(input);
  assert.equal(quotes, 1);
  assert.equal(replay.model, 'bk-2');
  assert.deepEqual(replay.effective_params, first.effective_params);
  assert.deepEqual(replay.selection, first.selection);
  await assert.rejects(api.quote({...input,model_strategy:'default'}),e=>e.code==='OPERATION_CONFLICT');
  assert.equal(f.observed.charges,0);
  const schema=buildTools({}).find(t=>t.name==='quote_generation').schema;
  assert.equal(schema.safeParse(input).success,true);
  assert.equal(schema.safeParse({...input,model_strategy:'random'}).success,false);
});

function service(env) { const config = configFromEnv(env); const client = new MediaClient(config); return new MediaService(client, new AccountOperationStore(client, config)); }

test('UTF-8 prompt, material count and request bytes match gateway limits', async t => {
  const f = await fixture(t); const api = service(f.env);
  await assert.rejects(api.quote({ ...quoteInput, prompt: '图'.repeat(10667) }), e => e.code === 'INVALID_ARGUMENTS');
  await assert.rejects(api.quote({ ...quoteInput, materials: Array(9).fill({ asset_id: 'asset_test' }) }), e => e.code === 'INVALID_ARGUMENTS');
  await assert.rejects(api.client.request('POST', '/quotes', { prompt: 'x'.repeat(65536) }), e => e.code === 'REQUEST_TOO_LARGE');
  assert.equal(f.observed.quotes, 0);
  assert.equal(f.observed.charges, 0);
});

test('origin and key configuration fail closed', () => {
  for (const base of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/private', 'https://example.com/?token=x']) assert.throws(() => configFromEnv({ MUBAI_BASE_URL: base, MUBAI_API_KEY: 'x' }), /HTTPS/);
  assert.throws(() => configFromEnv({ MUBAI_BASE_URL: 'https://example.com' }), /MUBAI_API_KEY/);
});

test('lost submission response is retried with persisted identity across process instances', async t => {
  const f = await fixture(t); const first = service(f.env);
  await first.quote(quoteInput); f.observed.disconnectOnce = true;
  await assert.rejects(first.submit('image', { operation_id: quoteInput.operation_id, max_score: 30 }), e => e.code === 'REQUEST_UNCERTAIN');
  const second = service(f.env);
  const result = await second.submit('image', { operation_id: quoteInput.operation_id, max_score: 30 });
  assert.equal(result.task_id, 'task_1');
  assert.equal(f.observed.charges, 1);
  assert.equal(f.observed.quotes, 1);
  assert.equal(f.observed.generationCalls.length, 2);
  assert.deepEqual(f.observed.generationCalls[0], f.observed.generationCalls[1]);
  assert.equal(f.observed.generationCalls[0].header, f.observed.generationCalls[0].body.idempotency_key);
  await second.submit('image', { operation_id: quoteInput.operation_id, max_score: 30 });
  assert.equal(f.observed.generationCalls.length, 2, 'completed submission is locally replayed');
});

test('changed payload, type, budget and insufficient budget cannot create an extra charge', async t => {
  const f = await fixture(t); const api = service(f.env);
  await api.quote(quoteInput);
  await assert.rejects(api.quote({ ...quoteInput, prompt: 'new content' }), e => e.code === 'OPERATION_CONFLICT');
  await assert.rejects(api.submit('video', { operation_id: quoteInput.operation_id, max_score: 30 }), e => e.code === 'TYPE_MISMATCH');
  await assert.rejects(api.submit('image', { operation_id: quoteInput.operation_id, max_score: 19 }), e => e.code === 'BUDGET_EXCEEDED');
  assert.equal(f.observed.charges, 0);
  await api.submit('image', { operation_id: quoteInput.operation_id, max_score: 30 });
  await assert.rejects(api.submit('image', { operation_id: quoteInput.operation_id, max_score: 40 }), e => e.code === 'OPERATION_CONFLICT');
  assert.equal(f.observed.charges, 1);
});

test('same operation is serialized across two client instances', async t => {
  const f = await fixture(t); const first = service(f.env); const second = service(f.env);
  await first.quote(quoteInput); f.observed.delaySubmit = 100;
  const results = await Promise.allSettled([first.submit('image', { operation_id: quoteInput.operation_id, max_score: 30 }), second.submit('image', { operation_id: quoteInput.operation_id, max_score: 30 })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'OPERATION_BUSY');
  assert.equal(f.observed.charges, 1);
});

test('completed or uncertain tasks stop polling without generating again', async t => {
  const f = await fixture(t); const api = service(f.env);
  assert.equal((await api.wait({ task_id: 'task_1', max_wait_seconds: 1 })).status, 'completed');
  f.observed.status = 'unknown';
  assert.equal((await api.wait({ task_id: 'task_1', max_wait_seconds: 1 })).status, 'unknown');
  f.observed.status = 'running';
  assert.equal((await api.wait({ task_id: 'task_1', max_wait_seconds: 1 })).polling_stopped, true);
  assert.equal(f.observed.taskCalls, 3);
  assert.equal(f.observed.generationCalls.length, 0);
});

test('local image upload is multipart and unrelated files are rejected', async t => {
  const f = await fixture(t); const client = new MediaClient(configFromEnv(f.env));
  const file = path.join(f.temp, 'product.png'); await writeFile(file, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal((await client.upload(file)).asset_id, 'asset_1');
  assert.match(f.observed.multipart, /^multipart\/form-data; boundary=/);
  await assert.rejects(client.upload('relative.png'), e => e.code === 'INVALID_FILE');
  const wrong = path.join(f.temp, 'private.txt'); await writeFile(wrong, 'data');
  await assert.rejects(client.upload(wrong), e => e.code === 'INVALID_FILE');
  assert.equal(f.observed.uploads, 1);
});

test('HTTP error messages never echo a credential or raw provider body', async t => {
  const f = await fixture(t); const client = new MediaClient(configFromEnv({ ...f.env, MUBAI_API_KEY: 'wrong' }));
  await assert.rejects(client.account(), e => { assert.equal(e.code, 'invalid_api_key'); assert.doesNotMatch(JSON.stringify(safeError(e)), /test-only-key/); return true; });
});

test('account-scoped operation stores do not cross website keys', async t => {
  const f = await fixture(t);
  const configA = configFromEnv(f.env); const configB = configFromEnv({ ...f.env, MUBAI_API_KEY: 'other-account' });
  const a = new AccountOperationStore(new MediaClient(configA), configA); const b = new AccountOperationStore(new MediaClient(configB), configB);
  await a.withOperation('operation-0001', async (_, save) => save({ task_id: 'task_1' }));
  await b.withOperation('operation-0001', state => assert.equal(state, null));
});

test('key rotation preserves the original operation and billing identity', async t => {
  const f = await fixture(t); const first = service(f.env);
  await first.quote(quoteInput); f.observed.disconnectOnce = true;
  await assert.rejects(first.submit('image', { operation_id: quoteInput.operation_id, max_score: 30 }));
  const rotated = service({ ...f.env, MUBAI_API_KEY: 'rotated-test-key' });
  assert.equal((await rotated.submit('image', { operation_id: quoteInput.operation_id, max_score: 30 })).task_id, 'task_1');
  assert.equal(f.observed.charges, 1); assert.equal(f.observed.quotes, 1);
  assert.equal(f.observed.generationCalls[0].body.idempotency_key, f.observed.generationCalls[1].body.idempotency_key);
});

test('reassigning an app to a different owner cannot replay the old owner state', async t => {
  const f = await fixture(t); const original = service(f.env);
  await original.quote(quoteInput); await original.submit('image', { operation_id: quoteInput.operation_id, max_score: 30 });
  const reassigned = service({ ...f.env, MUBAI_API_KEY: 'reassigned-app-key' });
  await assert.rejects(reassigned.submit('image', { operation_id: quoteInput.operation_id, max_score: 30 }), e => e.code === 'QUOTE_REQUIRED');
  f.observed.owner = 24;
  await assert.rejects(original.submit('image', { operation_id: quoteInput.operation_id, max_score: 30 }), e => e.code === 'QUOTE_REQUIRED');
  assert.equal(f.observed.charges, 1);
});
