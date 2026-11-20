import { supportsClient } from './host-adapters.mjs';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { AuthError, createCredentialStore, credentialClient, credentialIsCurrent } from './credential-store.mjs';
import { websiteOrigin, isPlaceholderKey } from './origin.mjs';
import { syncChatModels } from './chat-models.mjs';
import { requestSignal } from './client.mjs';

export function authArguments(argv) {
  const values = { '--base-url': 'baseUrl', '--home': 'home', '--client': 'client', '--skill': 'skill' };
  const flags = { '--no-browser': 'noBrowser', '--revoke': 'revoke', '--force': 'force', '--wait': 'wait', '--no-wait': 'noWait', '--allow-http-localhost': 'allowHttpLocalhost', '--chat': 'chat', '--auto-complete': 'autoComplete', '--verify': 'verify' };
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const name = values[argv[i]] || flags[argv[i]];
    if (!name || options[name] !== undefined) throw new AuthError('INVALID_ARGUMENTS', '授权参数无效或重复；不接受密钥参数。');
    if (flags[argv[i]]) options[name] = true;
    else { const value = argv[++i]; if (!value || value.startsWith('--')) throw new AuthError('INVALID_ARGUMENTS', '授权参数缺少值。'); options[name] = value; }
  }
  if (options.client && !supportsClient(options.client)) throw new AuthError('INVALID_ARGUMENTS', '--client 必须使用受支持的客户端标识。');
  if (options.skill && !['images', 'video', 'episode', 'all'].includes(options.skill)) throw new AuthError('INVALID_ARGUMENTS', '--skill 仅支持 images、video、episode 或 all。');
  if (options.wait && options.noWait) throw new AuthError('INVALID_ARGUMENTS', '--wait 与 --no-wait 不能同时使用。');
  return options;
}

export async function deviceRequest(origin, endpoint, { body, key, fetchImpl = fetch, signal } = {}) {
  if (!['start', 'token', 'ack', 'revoke', 'session', 'version'].includes(endpoint)) throw new AuthError('INVALID_ENDPOINT', '授权接口无效。');
  let response;
  try {
    response = await fetchImpl(`${origin}/api/agent-access/device/${endpoint}`, { method: endpoint === 'session' ? 'GET' : 'POST',
      headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', credentials: 'omit', signal: requestSignal(15000, signal) });
  } catch { if (signal?.aborted) throw new AuthError('AUTH_CANCELLED', '授权等待已停止，可使用原请求继续。'); throw new AuthError('AUTH_NETWORK', '授权请求未获得可靠响应，请使用原请求重试。'); }
  const chunks = []; let bytes = 0;
  try { for await (const chunk of response.body || []) { bytes += chunk.length; if (bytes > 65536) throw new Error(); chunks.push(chunk); } }
  catch { throw new AuthError('AUTH_NETWORK', '授权响应读取失败，请使用原请求重试。'); }
  let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AuthError('AUTH_RESPONSE', '网站没有返回有效的授权响应。'); }
  if (!response.ok || value.error) {
    const code = value.error?.code;
    const accepted = ['authorization_pending', 'slow_down', 'expired_token', 'access_denied', 'authorization_consumed', 'AUTH_GRANT_REPLACED', 'INVALID_DEVICE_PROOF', 'INVALID_RECEIPT', 'ACCOUNT_UNAVAILABLE', 'invalid_grant', 'invalid_token', 'invalid_request', 'UNAUTHORIZED', 'API_KEY_INVALID', 'TOKEN_EXPIRED', 'api_key_disabled', 'api_key_expired', 'invalid_api_key', 'DEVICE_SESSION_INVALID', 'DEVICE_AUTH_UNAVAILABLE', 'CHAT_SERVICE_DISABLED'];
    const error = new AuthError(accepted.includes(code) ? code : 'AUTH_REJECTED', '网站尚未完成或已拒绝授权。');
    error.retryAfter = Math.min(60, Math.max(0, Number(response.headers.get('retry-after')) || 0));
    throw error;
  }
  if (!value.data || typeof value.data !== 'object' || Array.isArray(value.data)) throw new AuthError('AUTH_RESPONSE', '授权响应缺少 data。');
  return value.data;
}

export function openAuthorizationUrl(url, { platform = process.platform, spawnImpl = spawn } = {}) {
  return new Promise(resolve => {
    const command = platform === 'win32' ? 'rundll32.exe' : platform === 'darwin' ? '/usr/bin/open' : platform === 'linux' ? 'xdg-open' : null;
    if (!command) return resolve(false);
    const args = platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
    let child; try { child = spawnImpl(command, args, { stdio: 'ignore', windowsHide: true }); } catch { return resolve(false); }
    const timer = setTimeout(() => { child.kill(); resolve(false); }, 10000);
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('close', code => { clearTimeout(timer); resolve(code === 0); });
  });
}

function checkedChallenge(data, origin, verifier, now, skill, client) {
  if (!/^[a-f0-9]{64}$/.test(data.device_code) || !/^[a-f0-9]{32}$/.test(data.request_id) || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(data.user_code)
      || data.authorization_origin !== origin || !Number.isInteger(data.expires_in) || data.expires_in < 1 || data.expires_in > 600 || !Number.isInteger(data.interval) || data.interval < 1 || data.interval > 30) throw new AuthError('AUTH_RESPONSE', '网站授权挑战格式无效。');
  let url; try { url = new URL(data.verification_uri_complete); } catch { throw new AuthError('AUTH_RESPONSE', '网站确认地址无效。'); }
  if (url.origin !== origin || url.username || url.password || url.pathname !== '/home/' || url.search || url.hash !== `#/ai-tool/authorize?request=${data.request_id}`) throw new AuthError('AUTH_RESPONSE', '网站确认地址不属于当前授权请求。');
  return { device_code: data.device_code, code_verifier: verifier, request_id: data.request_id, user_code: data.user_code,
    verification_uri_complete: url.href, expires_at_ms: now + data.expires_in * 1000, interval: data.interval, requested_skill: skill, client, schema: 1 };
}

function checkedToken(data, origin, now, local) {
  if (!/^sk-mbag-[a-f0-9]{64}$/.test(data.api_key) || data.base_url !== origin || !/^[a-f0-9]{32}$/.test(data.receipt)
      || !Number.isSafeInteger(data.account_id) || data.account_id <= 0 || !Number.isSafeInteger(data.api_app_id) || data.api_app_id <= 0
      || !credentialIsCurrent(data, Math.floor(now / 1000)) || data.expires_at > Math.floor(now / 1000) + 366 * 86400
      || typeof data.service_enabled !== 'boolean') throw new AuthError('AUTH_RESPONSE', '网站返回的授权身份或期限无效。');
  return { schema: 1, api_key: data.api_key, base_url: origin, account_id: data.account_id, api_app_id: data.api_app_id, expires_at: data.expires_at, non_expiring: data.expires_at === 0, allow_http_localhost: local === true };
}

function checkedSession(data, profile) {
  if (data.connected !== true || data.account_id !== profile.account_id || data.api_app_id !== profile.api_app_id || data.expires_at !== profile.expires_at || (profile.expires_at === 0 && data.non_expiring !== true) || typeof data.service_enabled !== 'boolean') throw new AuthError('AUTH_RESPONSE', '网站会话身份与本机授权不一致。');
  return { connected: true, account_id: data.account_id, api_app_id: data.api_app_id, expires_at: data.expires_at, non_expiring: data.expires_at === 0, service_enabled: data.service_enabled,
    ...(Array.isArray(data.scopes) ? { scopes: data.scopes.filter(scope => ['image:generate', 'video:generate', 'chat:complete'].includes(scope)) } : {}),
    ...(typeof data.chat_authorized === 'boolean' ? { chat_authorized: data.chat_authorized, chat_enabled: data.chat_enabled === true } : {}),
    ...(Number.isFinite(data.balance_score) ? { balance_score: data.balance_score } : {}) };
}

const wait = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(new AuthError('AUTH_CANCELLED', '授权等待已停止。'));
  const aborted = () => { clearTimeout(timer); reject(new AuthError('AUTH_CANCELLED', '授权等待已停止，可继续原请求。')); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', aborted); resolve(); }, ms);
  signal?.addEventListener('abort', aborted, { once: true });
});
// 'episode' grants the full workflow capability (media回传 + 生成), so it covers image/video requests.
const covers = (granted, wanted) => granted === 'all' || granted === 'episode' || granted === wanted;

export async function runAuth(command, options, dependencies = {}) {
  const env = dependencies.env || process.env;
  const client = credentialClient({ client: options.client, env });
  if (options.chat && command !== 'login') throw new AuthError('INVALID_ARGUMENTS', '--chat 用于登录时请求对话权限。');
  if (options.verify && command !== 'status') throw new AuthError('INVALID_ARGUMENTS', '--verify 用于连接检查。');
  options = { ...options, ...(client ? { client } : {}) };
  const environmentOverride = !isPlaceholderKey((dependencies.env || process.env).MUBAI_API_KEY);
  if (command === 'login' && environmentOverride) throw new AuthError('ENVIRONMENT_KEY_OVERRIDE', '当前 MUBAI_API_KEY 环境变量优先于网站授权；请先在启动环境移除该变量，再通过网站登录或切换账号。');
  if (command === 'status' && environmentOverride) return { connected: false, credential_source: 'environment', environment_key_override: true, reason: 'environment_identity_not_verified' };
  const store = dependencies.store || (dependencies.createStore || createCredentialStore)({ home: options.home, client, env });
  const request = dependencies.request || deviceRequest;
  const now = dependencies.now || Date.now;
  const progress = dependencies.progress || (() => {});
  const sleep = dependencies.sleep || wait;
  const connection = options.baseUrl ? null : await store.connection();
  if (!options.baseUrl && !connection && command === 'logout' && environmentOverride) return { connected: false, local_profile_removed: false, server_revoked: false, credential_source: 'environment', environment_key_override: true, operation_records_preserved: true, reason: 'environment_key_not_removed' };
  if (!options.baseUrl && !connection) throw new AuthError('LOGIN_REQUIRED', '请通过网站统一安装入口登录，或提供网站公布的 --base-url。');
  const allowHttpLocalhost = options.allowHttpLocalhost === true || connection?.allow_http_localhost === true;
  let origin;
  try { origin = websiteOrigin(options.baseUrl || connection.origin, { allowHttpLocalhost }); }
  catch { throw new AuthError('INVALID_ORIGIN', '授权网站地址无效，请使用网站统一安装入口提供的 HTTPS 地址；本机验收需显式测试开关。'); }
  const signal = dependencies.signal;
  const session = async profile => checkedSession(await request(origin, 'session', { key: profile.api_key, signal }), profile);
  const sync = dependencies.syncModels || syncChatModels;
  const syncForClient = (profile, settings = {}) => sync(origin, profile, { client, home: options.home, signal, ...settings });
  const completeLogin = async (status, profile) => {
    if (dependencies.onConnected) await dependencies.onConnected(origin, profile).catch(() => {});
    if (!client || !status.chat_authorized || !status.chat_enabled) return status;
    try {
      const result = await syncForClient(profile);
      return { ...status, chat_models: result.models, chat_models_changed: result.changed, chat_import_mode: result.mode,
        ...(result.config_path ? { chat_config_path: result.config_path } : {}),
        ...(client === 'workbuddy' ? { workbuddy_models: result.models, workbuddy_models_changed: result.changed } : {}),
        message: result.mode === 'provider_file' ? 'BK 对话配置已同步。兼容 Chat Completions 的客户端可以导入此配置，也可以直接使用 BK 对话命令。'
          : 'BK 对话模型已同步，可重新打开客户端模型选择器查看。' };
    } catch (error) {
      return { ...status, chat_models_sync_failed: true, ...(client === 'workbuddy' ? { workbuddy_models_sync_failed: true } : {}),
        reason: error instanceof AuthError ? error.code : 'CHAT_MODEL_SYNC_FAILED',
        message: '网站授权已完成。重新运行同一个 login 命令可重试同步，也可直接使用 BK 对话命令。' };
    }
  };
  if (command === 'status') {
    const profile = await store.read(origin);
    if (!credentialIsCurrent(profile, Math.floor(now() / 1000))) return { connected: false, reason: profile ? 'expired' : 'login_required', credential_source: environmentOverride ? 'environment' : 'os_vault', website_profile_connected: false, environment_key_override: environmentOverride };
    const status = await session(profile);
    if (options.verify && client && status.chat_authorized && status.chat_enabled) {
      try {
        const result = await syncForClient(profile, { verifyOnly: true });
        status.chat_models = result.models;
        status.chat_models_verified = !result.changed;
        status.chat_import_mode = result.mode;
        if (result.config_path) status.chat_config_path = result.config_path;
        if (client === 'workbuddy') Object.assign(status, { workbuddy_models: result.models, workbuddy_models_verified: !result.changed });
        if (result.changed) status.message = '本地模型列表与网站有差异，请重试同步后再检查。';
        else if (!result.models) status.message = '账号已连接，后台暂未开放可同步的对话模型。';
        else status.message = '已核对本地 BK 模型配置。';
      } catch (error) {
        status.chat_models_verified = false;
        if (client === 'workbuddy') status.workbuddy_models_verified = false;
        status.reason = error instanceof AuthError ? error.code : 'CHAT_MODEL_CHECK_FAILED';
        status.message = '账号已连接，暂未完成本地模型检查。';
      }
    }
    return { ...status, credential_source: 'os_vault', website_profile_connected: true, environment_key_override: false };
  }
  if (!['login', 'logout'].includes(command)) throw new AuthError('INVALID_ARGUMENTS', '未知授权命令。');
  return store.locked(origin, async () => {
    if (command === 'logout') {
      const profile = await store.read(origin);
      if (options.revoke && profile) await request(origin, 'revoke', { key: profile.api_key, body: {}, signal });
      let modelCleanupFailed = false;
      if (client && profile?.chat_granted === true) {
        try { await syncForClient(profile, { remove: true }); }
        catch { modelCleanupFailed = true; }
      }
      await store.logout(origin);
      return { connected: false, local_profile_removed: true, server_revoked: !!(options.revoke && profile), credential_source: environmentOverride ? 'environment' : 'none', environment_key_override: environmentOverride, operation_records_preserved: true,
        ...(modelCleanupFailed ? { chat_model_cleanup_failed: true, ...(client === 'workbuddy' ? { workbuddy_model_cleanup_failed: true } : {}) } : {}) };
    }
    const loginWithinLock = async () => {
    let pending = await store.pending(origin);
    const previous = await store.read(origin);
    const requestedSkill = options.skill || 'all';
    const requestedChat = options.chat === true || previous?.chat_granted === true;
    if (pending?.expires_at_ms <= now()) { await store.clearPending(origin); pending = null; }
    const resumingPending = !!pending;
    const forceAlreadyApplied = pending?.force_requested === true;
    if (pending) {
      if ((pending.force_requested !== undefined && typeof pending.force_requested !== 'boolean') || pending.schema !== 1 || !Number.isFinite(pending.expires_at_ms) || pending.expires_at_ms > now() + 600000 || !/^[A-Za-z0-9_-]{43,128}$/.test(pending.code_verifier)
          || !['images', 'video', 'episode', 'all'].includes(pending.requested_skill) || !supportsClient(pending.client) || (pending.receipt !== undefined && !/^[a-f0-9]{32}$/.test(pending.receipt))) throw new AuthError('INVALID_VAULT', '本机待确认授权记录无效。');
      checkedChallenge({ ...pending, expires_in: Math.max(1, Math.ceil((pending.expires_at_ms - now()) / 1000)), authorization_origin: origin }, origin, pending.code_verifier, now(), pending.requested_skill, pending.client);
    }
    // Finish a previously persisted receipt before considering a new authorization.
    if (pending?.receipt && previous) {
      try { await request(origin, 'ack', { body: { device_code: pending.device_code, code_verifier: pending.code_verifier, receipt: pending.receipt }, signal }); }
      catch (error) {
        if (!['expired_token', 'access_denied', 'authorization_consumed', 'AUTH_GRANT_REPLACED', 'INVALID_DEVICE_PROOF', 'INVALID_RECEIPT', 'invalid_grant', 'AUTH_REJECTED'].includes(error.code)) throw error;
        await store.clearPending(origin);
        progress({ message: '原确认请求已失效，已保留本机授权并清理该待确认请求，正在检查连接或重新授权。' });
        return loginWithinLock();
      }
      await store.clearPending(origin);
      const status = await session(previous);
      if (!covers(previous.granted_skill, requestedSkill) || (requestedChat && !status.chat_authorized) || (options.force && !forceAlreadyApplied)) return loginWithinLock();
      return completeLogin({ ...status, reused: true, authorization_acknowledged: true, requested_skill_satisfied: true }, previous);
    }
    if (!pending && credentialIsCurrent(previous, Math.floor(now() / 1000)) && !options.force && covers(previous.granted_skill, requestedSkill)) {
      try {
        const status = await session(previous);
        if (!requestedChat || status.chat_authorized) return completeLogin({ ...status, reused: true }, previous);
      }
      catch (error) { if (!['invalid_token', 'invalid_grant', 'UNAUTHORIZED', 'API_KEY_INVALID', 'TOKEN_EXPIRED', 'api_key_disabled', 'api_key_expired', 'invalid_api_key', 'DEVICE_SESSION_INVALID'].includes(error.code)) throw error; }
    }
    if (!pending) {
      if (!supportsClient(options.client)) throw new AuthError('INVALID_ARGUMENTS', '首次登录需指定受支持的 --client。');
      const verifier = randomBytes(32).toString('base64url');
      const combinedSkill = previous?.granted_skill && previous.granted_skill !== requestedSkill ? 'all' : requestedSkill;
      const data = await request(origin, 'start', { body: { client: options.client, skill: combinedSkill, authorization_policy_version: 2,
        ...(requestedChat ? { chat_models: true } : {}), code_challenge: createHash('sha256').update(verifier).digest('base64url') }, signal });
      pending = { ...checkedChallenge(data, origin, verifier, now(), combinedSkill, options.client), force_requested: options.force === true,
        ...(requestedChat ? { requested_chat: true } : {}) };
      await store.savePending(origin, pending);
    }
    progress({ verification_url: pending.verification_uri_complete, user_code: pending.user_code, message: '请立即在对话中向用户显示确认码及授权链接，核对一致后由用户点击授权。授权本身不生成或扣费。' });
    const opened = options.noBrowser ? false : await (dependencies.openBrowser || openAuthorizationUrl)(pending.verification_uri_complete);
    if (!opened) progress({ browser_opened: false, message: '未自动打开浏览器；请打开上述确认链接并核对短码，原授权请求仍在等待。' });
    if (options.noWait) return { connected: false, authorization_pending: true, verification_url: pending.verification_uri_complete, user_code: pending.user_code, request_expires_at: Math.floor(pending.expires_at_ms / 1000), browser_opened: opened,
      ...(pending.requested_chat === true ? { chat_authorization_requested: true } : {}),
      message: '请先把确认码和链接显示给用户；再运行原 login 命令追加 --wait 等待网页授权并完成连接。未建立连接，未生成或扣费。' };
    let interval = pending.interval;
    while (now() < pending.expires_at_ms) {
      if (signal?.aborted) throw new AuthError('AUTH_CANCELLED', '授权等待已停止，可继续原请求。');
      let data;
      try { data = await request(origin, 'token', { body: { device_code: pending.device_code, code_verifier: pending.code_verifier }, signal }); }
      catch (error) {
        if (['expired_token', 'access_denied', 'authorization_consumed', 'AUTH_GRANT_REPLACED', 'INVALID_DEVICE_PROOF', 'ACCOUNT_UNAVAILABLE'].includes(error.code)) { await store.clearPending(origin); throw error; }
        if (!['authorization_pending', 'slow_down', 'AUTH_NETWORK'].includes(error.code)) throw error;
        if (error.code === 'slow_down') interval = Math.max(interval + 5, error.retryAfter || 0);
        await sleep(Math.min(60000, interval * 1000, Math.max(0, pending.expires_at_ms - now())), signal); continue;
      }
      const profile = { ...checkedToken(data, origin, now(), allowHttpLocalhost), granted_skill: pending.requested_skill,
        ...(pending.requested_chat === true ? { chat_granted: true } : {}) };
      await store.save(origin, profile);
      pending = { ...pending, receipt: data.receipt };
      await store.savePending(origin, pending);
      await request(origin, 'ack', { body: { device_code: pending.device_code, code_verifier: pending.code_verifier, receipt: pending.receipt }, signal });
      await store.clearPending(origin);
      const status = await session(profile);
      if (pending.requested_chat === true && !status.chat_authorized) throw new AuthError('CHAT_AUTHORIZATION_REQUIRED', '网站未授予对话模型权限。');
      if (!covers(profile.granted_skill, requestedSkill) || (requestedChat && !status.chat_authorized) || (options.force && resumingPending && !forceAlreadyApplied)) return loginWithinLock();
      return completeLogin({ ...status, reused: false, authorization_acknowledged: true, requested_skill_satisfied: true }, profile);
    }
    await store.clearPending(origin); throw new AuthError('expired_token', '授权请求已过期，请重新发起登录。');
    };
    return loginWithinLock();
  });
}
