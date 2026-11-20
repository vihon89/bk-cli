import { createHash, createHmac, randomUUID } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { AuthError, storedCredential } from './credential-store.mjs';
import { isPlaceholderKey } from './origin.mjs';
import { prepareVideoUpload as prepareVideoUploadFile } from './video-env.mjs';

export class MediaError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export function requestSignal(timeoutMs, parent) {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!parent) return timeout;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([parent, timeout]);
  if (parent.aborted) return parent;
  // AbortSignal.any was added in Node 20.3. Keep cancellation on older Node 20 releases.
  const controller = new AbortController();
  const cancel = () => controller.abort(parent.reason);
  parent.addEventListener('abort', cancel, { once: true });
  timeout.addEventListener('abort', () => {
    parent.removeEventListener('abort', cancel);
    controller.abort(timeout.reason);
  }, { once: true });
  return controller.signal;
}
export function safeError(error) {
  return { code: error instanceof MediaError || error instanceof AuthError ? error.code : 'CLIENT_ERROR', message: error instanceof MediaError || error instanceof AuthError ? error.message : '客户端操作未完成；请检查本地配置或使用原操作 ID 重试。' };
}
export async function configFromSources(env = process.env, options = {}) {
  if (!isPlaceholderKey(env.MUBAI_API_KEY)) return configFromEnv(env);
  const profile = await storedCredential({ env, ...options });
  return configFromEnv({ ...env, MUBAI_BASE_URL: profile.base_url, MUBAI_API_KEY: profile.api_key,
    MUBAI_API_SECRET: '', MUBAI_ALLOW_HTTP_LOCALHOST: profile.allow_http_localhost ? '1' : env.MUBAI_ALLOW_HTTP_LOCALHOST });
}
export function configFromEnv(env = process.env) {
  let origin;
  try { origin = new URL(env.MUBAI_BASE_URL); } catch { throw new MediaError('CONFIG_REQUIRED', '请配置 MUBAI_BASE_URL 为网站 HTTPS 地址。'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/' ||
      (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && local && env.MUBAI_ALLOW_HTTP_LOCALHOST === '1'))) {
    throw new MediaError('INVALID_ORIGIN', '网站地址必须是无凭据、无路径和查询参数的 HTTPS origin。');
  }
  if (!env.MUBAI_API_KEY || /[\r\n]/.test(env.MUBAI_API_KEY)) throw new MediaError('CONFIG_REQUIRED', '请在本地环境变量中配置网站专用 MUBAI_API_KEY。');
  return { baseUrl: origin.origin, apiKey: env.MUBAI_API_KEY, apiSecret: env.MUBAI_API_SECRET || '',
    stateDir: env.MUBAI_STATE_DIR, assetRoot: env.MUBAI_ASSET_ROOT || '', resource: env.MUBAI_OAUTH_RESOURCE || '' };
}

export class MediaClient {
  constructor(config) { this.config = config; }
  async request(method, endpoint, body, { timeoutMs = 45000, headers = {} } = {}) {
    if (!/^\/(account|models|local-render-results|assets|uploads\/[A-Za-z0-9_.-]{8,128}|skills\/discover|quotes|batches|batches\/[A-Za-z0-9_.-]+|generations|tasks\/[A-Za-z0-9_.-]+)$/.test(endpoint)) throw new MediaError('INVALID_ENDPOINT', '不支持的 API 路径。');
    const route = `/openapi/agent/v1${endpoint}`;
    const multipart = body instanceof FormData;
    const data = body === undefined ? undefined : multipart ? body : JSON.stringify(body);
    if (!multipart && data !== undefined && Buffer.byteLength(data, 'utf8') > 65536) throw new MediaError('REQUEST_TOO_LARGE', 'JSON 请求最多 65536 字节，请缩短参数或提示词。');
    const requestHeaders = { Authorization: `Bearer ${this.config.apiKey}`, Accept: 'application/json', ...headers };
    if (this.config.resource) requestHeaders['X-Agent-Resource'] = this.config.resource;
    if (!multipart && data !== undefined) requestHeaders['Content-Type'] = 'application/json';
    if (this.config.apiSecret) {
      if (multipart) throw new MediaError('SIGNED_UPLOAD_UNSUPPORTED', '首版上传不支持启用请求签名的 Key，请使用服务端允许的专用素材授权 Key。');
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const nonce = randomUUID();
      const digest = createHash('sha256').update(data || '').digest('hex');
      const signingKey = createHash('sha256').update(this.config.apiSecret).digest('hex');
      Object.assign(requestHeaders, { 'X-Mubai-Timestamp': timestamp, 'X-Mubai-Nonce': nonce,
        'X-Mubai-Signature': `sha256=${createHmac('sha256', signingKey).update([method, route, timestamp, nonce, digest].join('\n')).digest('hex')}` });
    }
    let response;
    try { response = await fetch(`${this.config.baseUrl}${route}`, { method, headers: requestHeaders, body: data, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) }); }
    catch { throw new MediaError('REQUEST_UNCERTAIN', '请求未获得可靠响应。提交可能已被接受，请保留原 operation_id 重试或查询，勿创建新操作。'); }
    const reader = response.body?.getReader();
    let count = 0; const chunks = [];
    try {
      if (reader) for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        count += value.byteLength;
        if (count > 4 * 1024 * 1024) { await reader.cancel(); throw new MediaError('INVALID_RESPONSE', '服务响应超过允许大小。'); }
        chunks.push(Buffer.from(value));
      }
    } catch (e) { if (e instanceof MediaError) throw e; throw new MediaError('REQUEST_UNCERTAIN', '响应读取中断；请保留原 operation_id。'); }
    let result;
    try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new MediaError('INVALID_RESPONSE', '服务未返回有效 JSON；已提交操作应使用原 operation_id 查询或重试。'); }
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new MediaError('INVALID_RESPONSE', '服务响应格式无效。');
    if (!response.ok || result.error) {
      const candidate = result.error?.code || result.code;
      const code = typeof candidate === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(candidate) ? candidate : `HTTP_${response.status}`;
      // Do not echo raw upstream messages, HTML, credentials or URLs into agent context.
      const selectionErrors = {
        AGENT_DEFAULT_MODEL_NOT_CONFIGURED: '网站尚未配置该类创作的默认模型，请联系管理员在模型配置台设置。',
        AGENT_DEFAULT_CONFIG_INVALID: '默认模型配置无效，请联系网站管理员。',
        AGENT_COMPARISON_SPEC_REQUIRED: '比较最低积分前，请明确图片比例和尺寸；视频还需明确时长。补齐后用新的操作ID重新报价。',
        AGENT_NO_COMPARABLE_MODEL: '当前授权内没有能按相同规格成功报价的模型，请核对素材、尺寸、时长与授权；不要自行降低规格。',
        AGENT_COMPARISON_INCOMPLETE: '报价比较未完成，无法确认最低积分；请稍后重新报价，不提交生成。',
        AGENT_COMPARISON_LIMIT: '可比较模型超过服务上限，请联系管理员缩小开放范围。'
      };
      // A valid app error envelope with HTTP 404 is required before retrying an absent upload.
      if (method === 'GET' && endpoint.startsWith('/uploads/') && ['AGENT_UPLOAD_NOT_FOUND', 'UPLOAD_NOT_FOUND'].includes(code)
          && (response.status !== 404 || result.error?.code !== code)) throw new MediaError('INVALID_RESPONSE', '上传状态查询响应格式无效。');
      throw new MediaError(code, selectionErrors[code] || `网站拒绝或未完成请求（${code}）。请检查账号、余额、授权及报价状态；保持原操作 ID。`);
    }
    if (!result || typeof result.data !== 'object' || result.data === null || Array.isArray(result.data)) throw new MediaError('INVALID_RESPONSE', '服务返回缺少 data 对象。');
    return result.data;
  }
  account() { return this.request('GET', '/account'); }
  async models(type) {
    const data = await this.request('GET', '/models');
    if (!Array.isArray(data.models)) throw new MediaError('INVALID_RESPONSE', '模型列表格式无效。');
    return { ...data, models: type ? data.models.filter(m => m.type === type) : data.models };
  }
  async upload(filePath) {
    if (!path.isAbsolute(filePath)) throw new MediaError('INVALID_FILE', 'file_path 必须是用户指定的本地绝对路径。');
    const { realpath } = await import('node:fs/promises');
    const file = await realpath(filePath);
    if (this.config.assetRoot) {
      const root = await realpath(this.config.assetRoot);
      const relative = path.relative(root, file);
      if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new MediaError('FILE_OUTSIDE_ROOT', '素材文件不在配置允许的目录中。');
    }
    const info = await stat(file);
    if (!info.isFile() || info.size <= 0 || info.size > 10 * 1024 * 1024) throw new MediaError('INVALID_FILE', '素材必须为不超过 10 MiB 的普通图片文件。');
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[path.extname(file).toLowerCase()];
    if (!mime) throw new MediaError('INVALID_FILE', '首版素材支持 PNG、JPEG、WebP。');
    const bytes = await readFile(file);
    if (bytes.length > 10 * 1024 * 1024) throw new MediaError('INVALID_FILE', '素材超出大小限制。');
    const form = new FormData(); form.append('file', new Blob([bytes], { type: mime }), path.basename(file));
    return this.request('POST', '/assets', form);
  }
  async task(taskId, timeoutMs) {
    if (!/^[A-Za-z0-9_.-]{1,160}$/.test(taskId)) throw new MediaError('INVALID_TASK', '任务编号格式无效。');
    const task = await this.request('GET', `/tasks/${taskId}`, undefined, { timeoutMs: timeoutMs || 45000 });
    const output = task.output?.[0];
    if (task.retouch_fidelity === 'source_pixels_preserved' &&
        output?.url === `/uploads/agent-media-retouch/${taskId}.png`) {
      output.url = new URL(output.url, this.config.baseUrl).href;
    }
    return task;
  }
  async prepareVideoUpload(filePath) {
    return prepareVideoUploadFile(filePath, { assetRoot: this.config.assetRoot });
  }
  // Large-file upload streams from disk via a lazy Blob; never buffers the whole video in memory.
  async uploadVideoFile(prepared, { operationId, description, idempotencyKey } = {}) {
    if (!operationId || !idempotencyKey) throw new MediaError('INVALID_ARGUMENTS', '上传缺少稳定的操作标识或幂等键。');
    const blob = await openAsBlob(prepared.file, { type: 'video/mp4' });
    const form = new FormData();
    form.append('media_type', 'video');
    form.append('operation_id', operationId);
    form.append('idempotency_key', idempotencyKey);
    if (description) form.append('description', description);
    form.append('file', blob, prepared.fileName);
    const result = await this.request('POST', '/assets', form, { timeoutMs: 600000 });
    if (result.sha256 && prepared.sha256 && result.sha256 !== prepared.sha256) {
      throw new MediaError('INVALID_RESPONSE', '服务端登记的文件校验值与本机不一致；请保留原 operation_id 重试或查询上传状态。');
    }
    return result;
  }
  uploadStatus(operationId) {
    if (!/^[A-Za-z0-9_.-]{8,128}$/.test(operationId)) throw new MediaError('INVALID_OPERATION_ID', 'operation_id 须为 8–128 位字母、数字、点、下划线或连字符。');
    return this.request('GET', `/uploads/${operationId}`);
  }
}
