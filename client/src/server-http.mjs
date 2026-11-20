#!/usr/bin/env node
import http from 'node:http';
import { credentialIsCurrent } from './credential-store.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildTools, executeTool } from './tools.mjs';
import { websiteOrigin } from './origin.mjs';

const scopes = ['account:read', 'models:read', 'tasks:read', 'assets:write', 'image:generate', 'video:generate'];
const loopback = host => ['127.0.0.1', '[::1]', 'localhost'].includes(host);

// Optional deployment entry point: no listener starts when this module is imported.
export function createRemoteServer(options) {
  const issuer = websiteOrigin(options.websiteOrigin, { allowHttpLocalhost: options.allowHttpLocalhost === true });
  const configured = new URL(options.resourceUrl);
  if (configured.username || configured.password || configured.pathname !== '/mcp' || configured.search || configured.hash || configured.protocol !== 'https:' && !(options.allowHttpLocalhost === true && configured.protocol === 'http:' && loopback(configured.hostname))) throw new Error('Remote resource must be an explicitly configured HTTPS /mcp URL.');
  const host = options.host || '127.0.0.1';
  if (!['127.0.0.1', '::1'].includes(host) && (!options.allowNonLoopbackBind || configured.protocol !== 'https:')) throw new Error('Non-loopback binding requires explicit permission and a public HTTPS resource.');
  if (!options.stateDir || !path.isAbsolute(options.stateDir)) throw new Error('Remote operation state requires a private absolute state directory.');
  const resource = () => {
    const value = new URL(configured);
    if (value.port === '0') { const address = server.address(); if (!address || typeof address === 'string') throw new Error('Listener is not ready.'); value.port = String(address.port); }
    return value;
  };
  const json = (res, status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }); res.end(JSON.stringify(body)); };
  const challenge = res => json(res, 401, { error: 'invalid_token' }, { 'WWW-Authenticate': `Bearer resource_metadata="${resource().origin}/.well-known/oauth-protected-resource", scope="${scopes.join(' ')}"` });
  const authenticate = options.authenticate || (async (token, resourceUri) => {
    const response = await (options.fetchSession || fetch)(`${issuer}/api/agent-oauth/session`, { headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, 'X-Agent-Resource': resourceUri }, redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('Inactive token');
    const bytes = []; let length = 0;
    for await (const chunk of response.body || []) { length += chunk.length; if (length > 65536) throw new Error('Oversized session'); bytes.push(chunk); }
    return JSON.parse(Buffer.concat(bytes).toString('utf8')).data;
  });
  const server = http.createServer(async (req, res) => {
    let mcp;
    try {
      const endpoint = resource();
      if (req.headers.host?.toLowerCase() !== endpoint.host.toLowerCase()) return json(res, 403, { error: 'invalid_host' });
      const origin = req.headers.origin;
      const origins = new Set([endpoint.origin, ...(options.allowedOrigins || [])]);
      if (origin !== undefined && (typeof origin !== 'string' || !origins.has(origin))) return json(res, 403, { error: 'invalid_origin' });
      if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, MCP-Protocol-Version, Mcp-Session-Id'); }
      if (['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'].includes(req.url)) {
        if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed' }, { Allow: 'GET' });
        return json(res, 200, { resource: endpoint.href, authorization_servers: [issuer], scopes_supported: scopes, bearer_methods_supported: ['header'], resource_name: 'BK爆款' });
      }
      if (req.url !== '/mcp') return json(res, 404, { error: 'not_found' });
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID', 'Cache-Control': 'no-store' }); return res.end(); }
      // Cookies never establish identity. Only an explicit bearer header is forwarded.
      const match = typeof req.headers.authorization === 'string' && /^Bearer (mbat_[a-f0-9]{64})$/.exec(req.headers.authorization);
      if (!match) return challenge(res);
      const token = match[1]; let session;
      try { session = await authenticate(token, endpoint.href); } catch { return challenge(res); }
      if (!session || session.active !== true || session.resource !== endpoint.href || !Number.isSafeInteger(session.account_id) || session.account_id <= 0 || !Number.isSafeInteger(session.api_app_id) || session.api_app_id <= 0 || !credentialIsCurrent(session)) return challenge(res);
      if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' }, { Allow: 'POST, OPTIONS' });
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'json_required' });
      const chunks = []; let length = 0;
      for await (const chunk of req) { length += chunk.length; if (length > 65536) return json(res, 413, { error: 'request_too_large' }); chunks.push(chunk); }
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(res, 400, { error: 'invalid_json' }); }
      const env = { MUBAI_BASE_URL: issuer, MUBAI_API_KEY: token, MUBAI_API_SECRET: '', MUBAI_STATE_DIR: options.stateDir, MUBAI_REMOTE_MODE: '1', MUBAI_OAUTH_RESOURCE: endpoint.href, ...(options.allowHttpLocalhost ? { MUBAI_ALLOW_HTTP_LOCALHOST: '1' } : {}) };
      mcp = new McpServer({ name: 'mubai-media', title: 'BK爆款', version: '0.4.1' }, {
        maxToolInputElements: 10000,
        instructions: [
          'BK爆款网站账号媒体工具。用户说「图片模型积分查询」，重新调用 list_models 查询图片目录，用主站公开名称逐个展示报价。',
          '用户未指定规格时，按 1:1、1K、单张、高画质、无参考图比较。用相同提示词和规格逐个指定模型调用 quote_generation，每个模型使用自己的操作编号。报告实际生效规格及未取得报价的模型。',
          '只查询报价时，到展示价格为止。生成须先报价并建立批次，由用户在网站批准，查询状态为 approved 后提交。保持原操作和批次编号恢复。',
          '远程素材仅使用用户已上传本站的 asset_id。禁止读取服务器本地路径或抓取任意 URL。',
        ].join(' '),
      });
      for (const def of (options.buildTools || buildTools)(env)) mcp.registerTool(def.name, { description: def.description, inputSchema: def.schema, annotations: def.annotations }, input => executeTool(def, input));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, enableDnsRebindingProtection: true, allowedHosts: [endpoint.host], allowedOrigins: [...origins] });
      await mcp.connect(transport);
      res.once('close', () => { void mcp.close().catch(() => {}); });
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) json(res, 500, { error: 'remote_request_failed' });
      else res.end();
      await mcp?.close().catch(() => {});
    }
  });
  server.requestTimeout = 60000; server.headersTimeout = 15000;
  return { server, host, resourceUrl: () => resource().href };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const remote = createRemoteServer({ websiteOrigin: process.env.MUBAI_WEBSITE_ORIGIN, resourceUrl: process.env.MUBAI_RESOURCE_URL, stateDir: process.env.MUBAI_STATE_DIR, host: process.env.MUBAI_HTTP_BIND || '127.0.0.1', allowNonLoopbackBind: process.env.MUBAI_HTTP_ALLOW_NON_LOOPBACK === '1', allowHttpLocalhost: process.env.MUBAI_ALLOW_HTTP_LOCALHOST === '1', allowedOrigins: (process.env.MUBAI_HTTP_ALLOWED_ORIGINS || '').split(',').filter(Boolean) });
    const port = Number(process.env.MUBAI_HTTP_PORT || 8787);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid listener port');
    remote.server.listen(port, remote.host, () => process.stderr.write('BK remote MCP listening; deployment and OAuth client acceptance remain required.\n'));
    remote.server.on('error', () => { process.stderr.write('BK remote MCP listener failed.\n'); process.exitCode = 1; });
  } catch { process.stderr.write('BK remote MCP requires explicit website/resource/state/bind configuration.\n'); process.exitCode = 1; }
}
