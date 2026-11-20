import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaClient, configFromEnv } from '../src/client.mjs';
import { MediaService } from '../src/service.mjs';
import { AccountOperationStore } from '../src/operation-store.mjs';
import { fixture, quoteInput } from './helpers.mjs';

function service(env) { const config = configFromEnv(env); const client = new MediaClient(config); return new MediaService(client, new AccountOperationStore(client, config)); }

test('batch creation binds original quotes; only website approval permits generation and retries fix batch', async t => {
  const f = await fixture(t); const api = service(f.env);
  const first = quoteInput.operation_id; const second = 'batch-operation-0002';
  await api.quote(quoteInput); await api.quote({ ...quoteInput, operation_id: second });
  await assert.rejects(api.createBatch({ operation_ids: [first, second], max_total_score: 30 }), { code: 'BUDGET_EXCEEDED' });
  const created = await api.createBatch({ operation_ids: [second, first], max_total_score: 50 });
  assert.equal(created.batch_id, 'ab_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'); assert.equal(created.status, 'pending');
  assert.equal(f.observed.batchCalls.length, 1);
  assert.deepEqual(new Set(f.observed.batchCalls[0].body.quote_ids), new Set(['q_1', 'q_2']));
  assert.equal((await api.createBatch({ operation_ids: [first, second], max_total_score: 50 })).replay, true);
  await assert.rejects(api.createBatch({ operation_ids: [first, second], max_total_score: 60 }), { code: 'OPERATION_CONFLICT' });
  await assert.rejects(api.submit('image', { operation_id: first, max_score: 25, batch_id: created.batch_id }), { code: 'BATCH_NOT_APPROVED' });
  assert.equal(f.observed.generationCalls.length, 0);
  f.observed.batchStatus = 'approved';
  f.observed.disconnectOnce = true;
  await assert.rejects(api.submit('image', { operation_id: first, max_score: 25, batch_id: created.batch_id }), { code: 'REQUEST_UNCERTAIN' });
  // Website revocation must stop new work while still allowing original-task recovery.
  f.observed.batchStatus = 'revoked';
  await assert.rejects(api.submit('image', { operation_id: second, max_score: 25, batch_id: created.batch_id }), { code: 'BATCH_NOT_APPROVED' });
  await assert.rejects(api.submit('image', { operation_id: first, max_score: 25, batch_id: 'ab_other' }), { code: 'OPERATION_CONFLICT' });
  await assert.rejects(api.submit('image', { operation_id: first, max_score: 25 }), { code: 'OPERATION_CONFLICT' });
  const recovered = await service(f.env).submit('image', { operation_id: first, max_score: 25, batch_id: created.batch_id });
  assert.equal(recovered.task_id, 'task_1'); assert.equal(f.observed.charges, 1);
  assert.equal(f.observed.generationCalls[0].body.batch_id, created.batch_id);
  assert.equal(f.observed.generationCalls[0].body.idempotency_key, f.observed.generationCalls[1].body.idempotency_key);
});

test('lost create response retries the original batch identity and refuses submitted/expired/duplicate quotes', async t => {
  const f = await fixture(t); const api = service(f.env);
  await api.quote(quoteInput);
  const batchArgs = { operation_ids: [quoteInput.operation_id], max_total_score: 30 };
  f.observed.batchDisconnectOnce = true;
  await assert.rejects(api.createBatch(batchArgs), { code: 'REQUEST_UNCERTAIN' });
  await service(f.env).createBatch(batchArgs);
  assert.equal(f.observed.batchCalls[0].body.idempotency_key, f.observed.batchCalls[1].body.idempotency_key);
  assert.equal(f.observed.batchCalls[0].header, f.observed.batchCalls[1].header);
  await assert.rejects(api.createBatch({ ...batchArgs, operation_ids: [quoteInput.operation_id, quoteInput.operation_id] }), { code: 'INVALID_ARGUMENTS' });
  const submitted = 'already-submitted';
  await api.quote({ ...quoteInput, operation_id: submitted });
  await api.submit('image', { operation_id: submitted, max_score: 30 });
  await assert.rejects(api.createBatch({ operation_ids: [submitted], max_total_score: 30 }), { code: 'BATCH_QUOTE_INVALID' });
  const expired = 'expired-operation';
  await api.quote({ ...quoteInput, operation_id: expired });
  await api.store.withOperation(expired, async (state, save) => save({ ...state, quote: { ...state.quote, expires_at: 1 } }));
  await assert.rejects(api.createBatch({ operation_ids: [expired], max_total_score: 30 }), { code: 'QUOTE_EXPIRED' });
});

test('uncertain submission with no admitted task cannot create new work after website revocation', async t => {
  const f = await fixture(t); const api = service(f.env);
  await api.quote(quoteInput);
  const batch = await api.createBatch({ operation_ids: [quoteInput.operation_id], max_total_score: 30 });
  f.observed.batchStatus = 'approved';
  const originalRequest = api.client.request.bind(api.client);
  api.client.request = async (method, route, ...args) => { if (route === '/generations') { const error = new Error('network before acceptance'); error.code = 'REQUEST_UNCERTAIN'; throw error; } return originalRequest(method, route, ...args); };
  const submit = { operation_id: quoteInput.operation_id, max_score: 30, batch_id: batch.batch_id };
  await assert.rejects(api.submit('image', submit), /network before acceptance/);
  f.observed.batchStatus = 'revoked';
  await assert.rejects(service(f.env).submit('image', submit), { code: 'AGENT_BATCH_NOT_APPROVED' });
  assert.equal(f.observed.charges, 0);
});
