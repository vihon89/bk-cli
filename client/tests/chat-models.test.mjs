import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chatBaseUrl, chatKey } from '../src/chat-client.mjs';
import { syncChatModels } from '../src/chat-models.mjs';

const origin = 'https://bk.example.com';
const profile = { api_key: 'sk-mbag-' + '1'.repeat(64), api_app_id: 34 };
const models = [
  { id: 'bk-chat-3', display_name: 'BK 会话模型', images: true, tools: true, streaming: true },
  { id: 'bk-chat-4', display_name: 'BK 文本模型', images: false, tools: false, streaming: true },
];
const response = data => async (url, options) => {
  assert.equal(url, origin + '/openapi/agent/v1/chat/models');
  assert.equal(options.headers.Authorization, 'Bearer ' + profile.api_key);
  assert.equal(options.redirect, 'error');
  return Response.json({ data });
};

for (const [client, relative, getProvider, other] of [
  ['qwen', '.qwen/settings.json', config => config.modelProviders['bk-baokuan'], { modelProviders: { other: [{ id: 'mine' }] }, model: { name: 'mine' } }],
  ['openclaw', '.openclaw/openclaw.json', config => config.models.providers['bk-baokuan']?.models, { models: { providers: { other: { models: [{ id: 'mine' }] } } } }],
]) {
  test(client + ' syncs authorized models, preserves defaults and removes only managed rows', async t => {
    const home = await mkdtemp(path.join(tmpdir(), 'bk-chat-models-'));
    t.after(() => rm(home, { recursive: true, force: true }));
    const target = path.join(home, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(other));
    const read = async () => JSON.parse(await readFile(target, 'utf8'));
    const options = { home, client };
    assert.deepEqual(await syncChatModels(origin, profile, { ...options, fetchImpl: response(models), verifyOnly: true }), { mode: 'native', models: 2, changed: true });
    assert.deepEqual(await read(), other);
    await syncChatModels(origin, profile, { ...options, fetchImpl: response(models) });
    const config = await read();
    assert.deepEqual(getProvider(config).map(row => [row.id, row.name]), models.map(row => [row.id, row.display_name]));
    assert.ok(JSON.stringify(config).includes(chatKey(profile)));
    assert.ok(!JSON.stringify(config).includes(profile.api_key));
    assert.ok(JSON.stringify(config).includes(chatBaseUrl(origin)));
    assert.equal((await syncChatModels(origin, profile, { ...options, fetchImpl: response(models) })).changed, false);
    await syncChatModels(origin, profile, { ...options, fetchImpl: response([models[1]]) });
    assert.deepEqual(getProvider(await read()).map(row => row.id), ['bk-chat-4']);
    await syncChatModels(origin, { ...profile, api_app_id: 56 }, { ...options, remove: true });
    assert.equal(getProvider(await read()).length, 1);
    await syncChatModels(origin, profile, { ...options, remove: true });
    assert.equal(getProvider(await read()), undefined);
    if (client === 'qwen') assert.deepEqual((await read()).model, other.model);
    else assert.deepEqual((await read()).models.providers.other, other.models.providers.other);
  });
}

test('generic sync exports a scoped provider descriptor and validates all rows before writing', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'bk-chat-generic-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const options = { home, client: 'generic' };
  const result = await syncChatModels(origin, profile, { ...options, fetchImpl: response(models) });
  assert.equal(result.mode, 'provider_file');
  assert.equal(result.models, 2);
  assert.ok(!JSON.stringify(result).includes(chatKey(profile)));
  const before = await readFile(result.config_path, 'utf8');
  assert.equal(JSON.parse(before).api_key, chatKey(profile));
  await assert.rejects(syncChatModels(origin, profile, { ...options, fetchImpl: response([models[0], models[0]]) }), { code: 'CHAT_CATALOG_INVALID' });
  assert.equal(await readFile(result.config_path, 'utf8'), before);
  await syncChatModels(origin, profile, { ...options, fetchImpl: response([]) });
  await assert.rejects(readFile(result.config_path), { code: 'ENOENT' });
});

test('unknown native provider configuration is preserved byte for byte', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'bk-chat-collision-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const target = path.join(home, '.qwen', 'settings.json');
  const original = '{"modelProviders":{"bk-baokuan":[{"id":"my-own"}]}}';
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, original);
  await assert.rejects(syncChatModels(origin, profile, { client: 'qwen', home, fetchImpl: response(models) }), { code: 'CHAT_CONFIG_CONFLICT' });
  assert.equal(await readFile(target, 'utf8'), original);
});
