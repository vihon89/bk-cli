import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { OperationStore, payloadHash } from '../src/operation-store.mjs';

test('live operation locks stay protected; killed process restores original operation identity', async t => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'BK operation recovery '));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const options = { stateDir, identity: 'test-account' }; const operation = 'recover-operation';
  const script = `import {OperationStore} from ${JSON.stringify(new URL('../src/operation-store.mjs', import.meta.url).href)}; await new OperationStore(${JSON.stringify(options)}).withOperation(${JSON.stringify(operation)},async(_state,save)=>{await save({state:'submitting',idempotency_key:'ORIGINAL_KEY'});process.stdout.write('READY');await new Promise(()=>{setInterval(()=>{},1000)});});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('child fault boundary timeout')), 10000); child.stdout.on('data', chunk => { if (chunk.toString().includes('READY')) { clearTimeout(timer); resolve(); } }); child.once('error', reject); });
  const store = new OperationStore(options);
  await assert.rejects(store.withOperation(operation, () => assert.fail('live lock stolen')), { code: 'OPERATION_BUSY' });
  const stopped = new Promise(resolve => child.once('close', resolve)); child.kill('SIGKILL'); await stopped;
  const result = await store.withOperation(operation, state => state);
  assert.deepEqual(result, { state: 'submitting', idempotency_key: 'ORIGINAL_KEY' });
  assert.equal(JSON.parse(await readFile(path.join(store.directory, payloadHash(operation) + '.json'))).idempotency_key, 'ORIGINAL_KEY');
});

test('legacy and unverifiable lock ownership never gets reclaimed by age', async t => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'BK ambiguous recovery '));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const store = new OperationStore({ stateDir, identity: 'test-account' });
  await mkdir(store.directory);
  const legacy = path.join(store.directory, payloadHash('legacy-operation') + '.json.lock');
  await writeFile(legacy, JSON.stringify({ pid: 99999999, started_at: 0 }));
  await assert.rejects(store.withOperation('legacy-operation', () => {}), { code: 'OPERATION_BUSY' });
  assert.equal(JSON.parse(await readFile(legacy)).pid, 99999999);
});
