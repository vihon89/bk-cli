import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { syncWorkBuddyModels } from '../src/workbuddy-models.mjs';

const origin = 'http://localhost:10040';
const profile = { api_key: 'sk-mbag-' + 'a'.repeat(64), api_app_id: 10 };
const first = { id: 'bk-chat-68', name: 'BK 对话 68', display_name: '对话模型（旗舰）', tools: true, images: false, streaming: true };
const second = { id: 'bk-chat-74', name: 'BK 对话 74', tools: false, images: true, streaming: true };

test('sync imports all allowed models, updates owned entries, preserves other providers and removes revoked entries', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'bk-workbuddy 模型 '));
  await mkdir(path.join(home, '.workbuddy'));
  const target = path.join(home, '.workbuddy', 'models.json');
  t.after(async () => {
    await unlink(target);
    await rmdir(path.dirname(target));
    await rmdir(home);
  });
  const other = { id: 'existing', name: 'Existing', vendor: 'another', apiKey: 'fixture-other-credential' };
  await writeFile(target, JSON.stringify([other]));
  let models = [first, second];
  const fetchImpl = async (url, options) => {
    assert.equal(url, origin + '/openapi/agent/v1/chat/models');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${profile.api_key}`);
    return Response.json({ data: models });
  };
  const sync = () => syncWorkBuddyModels(origin, profile, { home, fetchImpl });
  assert.deepEqual(await sync(), { models: 2, changed: true });
  const installed = await readFile(target, 'utf8');
  assert.ok(!installed.includes(profile.api_key));
  const rows = JSON.parse(installed);
  assert.deepEqual(rows[0], other);
  assert.equal(rows[1].name, first.display_name);
  assert.equal(rows[2].name, second.name);
  assert.equal(rows[1].supportsToolCall, true);
  assert.equal(rows[2].supportsImages, true);
  assert.equal(rows[1].url, origin + '/v1/chat/completions');
  assert.match(rows[1].apiKey, /^bkct_10_[a-f0-9]{64}$/);
  assert.deepEqual(await sync(), { models: 2, changed: false });
  models = [{ ...first, display_name: '对话模型（进阶）' }, second];
  assert.deepEqual(await syncWorkBuddyModels(origin, profile, { home, fetchImpl, verifyOnly: true }), { models: 2, changed: true });
  assert.equal(await readFile(target, 'utf8'), installed);
  assert.deepEqual(await sync(), { models: 2, changed: true });
  const renamed = JSON.parse(await readFile(target, 'utf8'))[1];
  assert.deepEqual(renamed, { ...rows[1], name: '对话模型（进阶）' });
  models = [second];
  assert.deepEqual(await sync(), { models: 1, changed: true });
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')).map(item => item.id), [other.id, second.id]);
  assert.deepEqual(await syncWorkBuddyModels(origin, profile, { home, remove: true }), { models: 0, changed: true });
  assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), [other]);
  const edited = JSON.stringify([{ ...other, id: second.id }]);
  await writeFile(target, edited);
  await assert.rejects(sync, { code: 'WORKBUDDY_MODEL_CONFLICT' });
  assert.equal(await readFile(target, 'utf8'), edited);
});
