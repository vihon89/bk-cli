import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaService } from '../src/service.mjs';
import { buildTools } from '../src/tools.mjs';

test('public model name flows unchanged to quote and replays freeze the selected model', async () => {
  let saved; let calls = 0;
  const service = new MediaService({ request: async (_method, _route, body) => { calls++; assert.equal(body.model_name, '商品创作'); assert.equal(body.model, undefined); return { quote_id: 'quote-public-name', total_score: 10, expires_at: 9999999999, model: 'bk-42' }; } }, { withOperation: async (_id, action) => action(saved, async value => { saved = value; }) });
  const input = { operation_id: 'model-name-operation', type: 'image', model_name: '商品创作', prompt: 'test', params: {}, materials: [] };
  const schema = buildTools().find(tool => tool.name === 'quote_generation').schema;
  assert.equal(schema.safeParse(input).success, true);
  assert.equal((await service.quote(input)).model, 'bk-42');
  assert.equal((await service.quote(input)).replay, true);
  assert.equal(calls, 1);
  await assert.rejects(service.quote({ ...input, model: 'bk-42' }), { code: 'INVALID_ARGUMENTS' });
  assert.equal(calls, 1);
});
