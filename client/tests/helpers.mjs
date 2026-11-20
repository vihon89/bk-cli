import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function fixture(t) {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'mubai-mcp-test-'));
  const observed = { quotes: 0, generationCalls: [], charges: 0, taskCalls: 0, uploads: 0, disconnectOnce: false, delaySubmit: 0, status: 'completed', owner: 7, batchCalls: [], batchStatus: 'pending', batchDisconnectOnce: false };
  const keys = new Map();
  const server = http.createServer(async (req, res) => {
    (observed.resourceHeaders ||= []).push(req.headers['x-agent-resource']);
    let raw = ''; for await (const chunk of req) raw += chunk.toString();
    const send = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' }); res.end(JSON.stringify(status >= 400 ? data : { data })); };
    if (!['Bearer test-only-key', 'Bearer rotated-test-key', 'Bearer other-account', 'Bearer reassigned-app-key'].includes(req.headers.authorization)) return send({ error: { code: 'invalid_api_key', message: 'test-only-key should not be echoed' } }, 401);
    const route = req.url.replace('/openapi/agent/v1', '');
    if (route === '/account') return send({ account_id: req.headers.authorization === 'Bearer reassigned-app-key' ? 24 : observed.owner, api_app_id: req.headers.authorization === 'Bearer other-account' ? 12 : 11, balance_score: 500, scopes: ['account:read', 'models:read', 'assets:write', 'image:generate', 'video:generate', 'tasks:read'], limits: { max_score: 100, daily_score: 500 } });
    if (route === '/models') return send({ models: [{ id: 'public-image', type: 'image', validation_schema: { ratio: ['1:1'] } }, { id: 'public-video', type: 'video' }] });
    if (req.method === 'POST' && route === '/skills/discover') {
      observed.lastSkillDiscovery = JSON.parse(raw);
      return send({ status: 'matched', skill: { id: 'reference.retouch' }, missing_inputs: [] });
    }
    if (route === '/assets') { observed.uploads++; observed.multipart = req.headers['content-type']; return send({ asset_id: 'asset_1' }); }
    if (route === '/quotes') { observed.quotes++; observed.lastQuote = JSON.parse(raw); return send({ quote_id: `q_${observed.quotes}`, total_score: 20, expires_at: Math.floor(Date.now() / 1000) + 600 }); }
    if (route === '/batches') { const body = JSON.parse(raw); observed.batchCalls.push({ body, header: req.headers['idempotency-key'] }); if (observed.batchDisconnectOnce) { observed.batchDisconnectOnce = false; req.socket.destroy(); return; } return send({ batch_id: 'ab_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', status: observed.batchStatus, verification_url: `http://127.0.0.1:${server.address().port}/home/#/ai-tool/authorize?batch=ab_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` }); }
    if (route === '/batches/ab_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') return send({ batch_id: 'ab_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', status: observed.batchStatus });
    if (route === '/generations') {
      const body = JSON.parse(raw); observed.generationCalls.push({ body, header: req.headers['idempotency-key'] });
      if (body.batch_id && observed.batchStatus !== 'approved' && !keys.has(body.idempotency_key)) return send({ error: { code: 'AGENT_BATCH_NOT_APPROVED' } }, 403);
      if (!keys.has(body.idempotency_key)) { keys.set(body.idempotency_key, `task_${keys.size + 1}`); observed.charges++; }
      if (observed.delaySubmit) await new Promise(resolve => setTimeout(resolve, observed.delaySubmit));
      if (observed.disconnectOnce) { observed.disconnectOnce = false; req.socket.destroy(); return; }
      return send({ task_id: keys.get(body.idempotency_key), status: 'queued', poll_after_seconds: 1 });
    }
    if (route.startsWith('/tasks/')) { observed.taskCalls++; return send({ task_id: route.split('/').pop(), status: observed.status, poll_after_seconds: 1, output: observed.status === 'completed' ? [{ type: 'image', url: 'https://assets.example.test/generated.png' }] : [], billing: { status: 'charged', score: 20 } }); }
    return send({ error: { code: 'not_found' } }, 404);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(temp, { recursive: true, force: true }); });
  const env = { ...process.env, MUBAI_BASE_URL: `http://127.0.0.1:${server.address().port}`, MUBAI_ALLOW_HTTP_LOCALHOST: '1', MUBAI_API_KEY: 'test-only-key', MUBAI_API_SECRET: '', MUBAI_STATE_DIR: temp, MUBAI_ASSET_ROOT: temp };
  return { temp, env, observed };
}

export const quoteInput = { operation_id: 'user-action-0001', type: 'image', model: 'public-image', prompt: '保持商品外观，生成场景图', params: { ratio: '1:1' }, materials: [] };
