import { createHash } from 'node:crypto';
import { AuthError } from './credential-store.mjs';
import { requestSignal } from './client.mjs';

export const chatModelId = /^bk-chat-[1-9][0-9]{0,9}$/;
export const chatCredential = /^bkct_[1-9][0-9]{0,9}_[a-f0-9]{64}$/;
export const chatBaseUrl = origin => `${origin}/openapi/agent/chat/v1`;

export function chatKey(profile) {
  // Keep existing scoped tokens valid across connector upgrades.
  const digest = createHash('sha256').update('bk-workbuddy-chat-v1\0').update(profile.api_key).digest('hex');
  return `bkct_${profile.api_app_id}_${digest}`;
}

export async function requestChat(origin, profile, action, { signal, fetchImpl = fetch, body, requestId } = {}) {
  const endpoints = {
    models: '/openapi/agent/v1/chat/models',
    quote: '/openapi/agent/v1/chat/quotes',
    complete: '/openapi/agent/chat/v1/chat/completions',
  };
  const response = await fetchImpl(origin + endpoints[action], {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Accept: 'application/json', Authorization: `Bearer ${profile.api_key}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(requestId ? { 'Idempotency-Key': requestId } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error', credentials: 'omit',
    signal: requestSignal(action === 'complete' ? 135000 : 15000, signal),
  });
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body || []) {
    bytes += chunk.length;
    if (bytes > (action === 'complete' ? 4194304 : 1048576)) {
      throw new AuthError('CHAT_RESPONSE_INVALID', 'BK 对话响应超过可读取范围。');
    }
    chunks.push(chunk);
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AuthError('CHAT_RESPONSE_INVALID', 'BK 对话响应格式无效。'); }
  if (!response.ok) {
    const code = data?.error?.code;
    throw new AuthError(typeof code === 'string' && /^[A-Za-z0-9_]{2,64}$/.test(code) ? code : 'CHAT_UNAVAILABLE', 'BK 对话请求未完成。');
  }
  if (action === 'complete') return { reply: data, charged_score: Number(response.headers.get('x-bk-score-charged') || 0) };
  return data?.data;
}

export async function readChatCatalog(origin, profile, options) {
  const data = await requestChat(origin, profile, 'models', options);
  if (!Array.isArray(data) || data.length > 200) throw new AuthError('CHAT_CATALOG_INVALID', 'BK 模型列表格式无效。');
  const seen = new Set();
  return data.map(item => {
    const name = item?.display_name ?? item?.name;
    if (!item || typeof item.id !== 'string' || !chatModelId.test(item.id) || seen.has(item.id)
      || typeof name !== 'string' || !name.trim() || !/^[^\p{Cc}\p{Zl}\p{Zp}]{1,120}$/u.test(name)
      || item.streaming !== true || typeof item.tools !== 'boolean' || typeof item.images !== 'boolean') {
      throw new AuthError('CHAT_CATALOG_INVALID', 'BK 模型列表格式无效。');
    }
    seen.add(item.id);
    return { id: item.id, name, tools: item.tools, images: item.images };
  });
}
