import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { bootstrap, bootstrapOrigin, fetchRelease } from '../bootstrap.mjs';
import { MediaError } from './client.mjs';
import { assertSafePath, createCredentialStore, credentialClient, credentialIsCurrent, writeAtomic } from './credential-store.mjs';
import { deviceRequest, runAuth } from './device-auth.mjs';
import { isPlaceholderKey } from './origin.mjs';
import { syncChatModels } from './chat-models.mjs';
import { readChatCatalog } from './chat-client.mjs';

const officialInstallGuide = 'https://aibaokuan.top/api/agent-access/install-guide?skill=images';
const authorizationErrors = new Set(['invalid_api_key', 'api_key_expired', 'AGENT_AUTHORIZATION_REVOKED', 'CHAT_AUTHORIZATION_REQUIRED']);

function websiteRecovery(installation) {
  return {
    install_guide_url: installation ? new URL('/api/agent-access/install-guide?skill=' + (installation.skill === 'all' ? 'images' : installation.skill), installation.origin).href : officialInstallGuide,
    message: '请通过 BK 官网安装入口确认发行版本后，选择当前客户端升级并沿用原授权。',
  };
}

export const validVersion = value => typeof value === 'string' && /^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$/.test(value);
export function compareVersions(left, right) {
  const parts = right.split('.').map(Number);
  return left.split('.').map((part, index) => Number(part) - parts[index]).find(part => part !== 0) || 0;
}
const runtime = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readJson = async target => {
  await assertSafePath(target);
  return JSON.parse(await readFile(target, 'utf8'));
};

export async function managedInstallation({ client, runtimeDirectory = runtime, env = process.env } = {}) {
  const root = path.dirname(path.dirname(runtimeDirectory));
  if (path.basename(root) !== '.mubai-media-mcp' || path.basename(path.dirname(runtimeDirectory)) !== 'versions' || !validVersion(path.basename(runtimeDirectory))) return null;
  const pointer = await readJson(path.join(root, 'current.json')).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (pointer?.schema !== 1 || !validVersion(pointer.version)) return null;
  const ids = Object.keys(pointer.installs || {});
  const id = credentialClient({ client: client || (!env.MUBAI_CLIENT_ID && ids.length === 1 ? ids[0] : undefined), env });
  const record = pointer.installs?.[id];
  if (!record || !validVersion(record.version) || !['images', 'video', 'episode', 'all'].includes(record.skill) || !record.origin) return null;
  const origin = bootstrapOrigin(record);
  return { ...record, origin, root, client: id, home: path.dirname(root), activeVersion: pointer.version, runtimeVersion: path.basename(runtimeDirectory) };
}

async function maintainConnection(installation, { store, syncModels = syncChatModels, request = deviceRequest, env = process.env, signal = AbortSignal.timeout(2300) } = {}) {
  if (!isPlaceholderKey(env.MUBAI_API_KEY)) return;
  const { origin, home, client, version } = installation;
  const credentials = store || createCredentialStore({ home, client, env });
  await credentials.locked(origin, async () => {
    if ((await credentials.connection())?.origin !== origin) return;
    const profile = await credentials.read(origin);
    if (signal.aborted || !credentialIsCurrent(profile) || profile.base_url !== origin) return;
    await Promise.allSettled([
      request(origin, 'version', { key: profile.api_key, body: { version }, signal }),
      ...(profile.chat_granted === true ? [syncModels(origin, profile, { client, home, signal })] : []),
    ]);
  });
}

const pendingChecks = new Map();
const pendingVerification = new Map();

async function verifyUpdatedInstallation(installation, { store, readModels = readChatCatalog, env = process.env, platform = process.platform } = {}) {
  const { origin, home, client } = installation;
  const credentials = store || createCredentialStore({ home, client, env });
  const windows = platform === 'win32' ? await Promise.resolve().then(() => credentials.diagnoseWindows()).catch(() => null) : null;
  let profile;
  try { profile = await credentials.read(origin); }
  catch (error) {
    return { status: 'credential_unreadable', ...(windows ? { windows } : {}), error_code: error.code || 'CREDENTIAL_READ_FAILED' };
  }
  const needsAuthorization = reason => ({ status: 'reauthorization_required', reason,
    authorization_guide_url: websiteRecovery(installation).install_guide_url });
  if (!isPlaceholderKey(env.MUBAI_API_KEY) && !profile?.api_key) return { status: 'manual_key_configured' };
  if (!profile?.api_key || !credentialIsCurrent(profile)) {
    if (windows && windows.storage !== 'ok') return { status: 'credential_store_unavailable', windows };
    return needsAuthorization('authorization_missing_or_expired');
  }
  if (profile.chat_granted !== true) return needsAuthorization('chat_permission_missing');
  try {
    const models = await readModels(origin, profile, { signal: AbortSignal.timeout(5000) });
    return { status: 'verified', authorization: 'readable', chat_model_count: models.length,
      ...(windows ? { windows } : {}) };
  } catch (error) {
    if (authorizationErrors.has(error.code)) return needsAuthorization(error.code);
    return { status: 'chat_check_unavailable', authorization: 'readable', error_code: error.code || 'CHAT_CHECK_FAILED' };
  }
}

async function verificationNotice(installation, options) {
  if (installation.version !== installation.runtimeVersion || installation.verify_after_update !== installation.version) return null;
  const receipt = path.join(installation.root, `verified-update-${installation.client}.json`);
  const key = JSON.stringify([receipt, installation.origin, installation.version]);
  if (!pendingVerification.has(key)) {
    pendingVerification.set(key, (async () => {
      const previous = await readJson(receipt).catch(() => null);
      if (!options.force && previous?.version === installation.version && previous.origin === installation.origin) return null;
      const result = await verifyUpdatedInstallation(installation, options);
      if (options.force && result.status === 'reauthorization_required') {
        const startAuthorization = options.startAuthorization || runAuth;
        const challenge = await startAuthorization('login', {
          home: installation.home, client: installation.client, baseUrl: installation.origin,
          skill: installation.skill, chat: true, force: true, noBrowser: true, noWait: true,
          allowHttpLocalhost: installation.allowHttpLocalhost,
        }, { env: options.env, store: options.store, signal: AbortSignal.timeout(8000) }).catch(() => null);
        if (challenge?.authorization_pending) {
          result.verification_url = challenge.verification_url;
          result.user_code = challenge.user_code;
        }
      }
      await writeAtomic(receipt, JSON.stringify({ version: installation.version, origin: installation.origin })).catch(() => {});
      return result;
    })().finally(() => pendingVerification.delete(key)));
  }
  return pendingVerification.get(key);
}

async function releaseStatus(installation, { force, maintain = true, release = fetchRelease, now = Date.now, ...dependencies }) {
  const cachePath = path.join(installation.root, `update-${installation.client}.json`);
  const cached = await readJson(cachePath).catch(() => null);
  if (!force && cached?.origin === installation.origin && cached.installed_version === installation.version
      && cached.next_check > now() && (cached.latest_version === null || validVersion(cached.latest_version))) return cached.latest_version;
  // Bound maintenance even if the operating-system credential vault is slow.
  const timer = AbortSignal.timeout(2300);
  const maintenance = maintain ? maintainConnection(installation, { ...dependencies, signal: timer }).catch(() => {}) : Promise.resolve();
  const [latest] = await Promise.all([
    Promise.resolve().then(() => release(installation.origin, force ? 8000 : 2000))
      .then(manifest => validVersion(manifest.version) ? manifest.version : null).catch(() => null),
    Promise.race([maintenance, new Promise(resolve => timer.addEventListener('abort', resolve, { once: true }))]),
  ]);
  await writeAtomic(cachePath, JSON.stringify({
    origin: installation.origin, installed_version: installation.version, latest_version: latest,
    next_check: now() + (latest ? 6 * 60 : 10) * 60000,
  })).catch(() => {});
  return latest;
}

export async function checkUpdate(options = {}) {
  const installation = await managedInstallation(options);
  if (!installation) return { status: 'not_managed', ...websiteRecovery() };
  const key = JSON.stringify([installation.root, installation.client, installation.origin, installation.version]);
  if (!pendingChecks.has(key)) {
    pendingChecks.set(key, releaseStatus(installation, options).finally(() => pendingChecks.delete(key)));
  }
  const [latest, verification] = await Promise.all([
    pendingChecks.get(key), verificationNotice(installation, options),
  ]);
  const updateAvailable = latest !== null && compareVersions(latest, installation.version) > 0;
  const restart = installation.activeVersion !== installation.runtimeVersion;
  return {
    status: updateAvailable ? 'update_available' : restart ? 'restart_required' : latest ? 'up_to_date' : 'check_unavailable',
    installed_version: installation.version, latest_version: latest,
    ...(verification ? { post_update_verification: verification } : {}),
    ...(restart ? { restart_required: true } : {}),
    ...(updateAvailable ? { message: `BK 连接器可从 v${installation.version} 更新到 v${latest}。回复「升级 BK」确认更新，原授权会保留。也可回复「跳过这个版本」。` }
      : restart ? { message: 'BK 连接器已更新。请重启 BK 连接器，或重启当前 Agent。' }
      : !latest ? websiteRecovery(installation) : {}),
  };
}

export async function applyUpdate({ version, confirm, install = bootstrap, ...options } = {}) {
  if (confirm !== true || !validVersion(version)) throw new MediaError('UPDATE_CONFIRMATION_REQUIRED', '请先检查版本，再确认更新到明确的版本。');
  const installation = await managedInstallation(options);
  if (!installation) throw new MediaError('UPDATE_NOT_MANAGED', '请通过 BK 网站安装页升级一次，以启用连接器版本管理。');
  if (version === installation.version) return { status: 'already_installed', installed_version: version, restart_required: installation.activeVersion !== installation.runtimeVersion };
  if (compareVersions(version, installation.version) < 0 || compareVersions(version, installation.activeVersion) < 0) throw new MediaError('UPDATE_DOWNGRADE', 'BK 连接器更新只接受当前或更新版本。');
  const args = ['--client', installation.client, '--skill', installation.skill, '--no-login'];
  if (installation.isolated) args.push('--home', installation.home);
  let result;
  try { result = await install(installation, args, { expectedVersion: version, quiet: true }); }
  catch (error) {
    if (typeof error?.stderr === 'string' && /^WORKBUDDY_CONNECTOR_CONFLICT:/m.test(error.stderr)) {
      throw new MediaError('WORKBUDDY_CONNECTOR_CONFLICT', 'WorkBuddy 已有同名 BK 连接器。请检查「自定义连接器」中的名称冲突，再重试升级。');
    }
    throw new MediaError('UPDATE_FAILED', `BK 更新未完成。请从官网安装入口升级当前客户端并沿用原授权。 ${websiteRecovery(installation).install_guide_url}`);
  }
  const current = await managedInstallation(options);
  if (current?.version !== version) throw new MediaError('UPDATE_FAILED', 'BK 更新后未找到已确认的版本。');
  await maintainConnection(current, options).catch(() => {});
  if (result?.configuration_status === 'workbuddy_renamed') {
    return { status: 'updated', installed_version: version, restart_required: true, workbuddy_trust_required: true,
      message: '旧连接器已自动改名为 BK。请打开 WorkBuddy 的「自定义连接器」并信任 BK；若仍显示旧名称，请完全退出后重新打开。原网站授权可继续使用。' };
  }
  return { status: 'updated', installed_version: version, restart_required: true, message: 'BK 连接器已更新。请重启 BK 连接器，或重启当前 Agent。' };
}

function skippedUpdatePath(installation) {
  return path.join(installation.root, `skipped-update-${installation.client}.json`);
}

export async function skipUpdate({ version, confirm, ...options } = {}) {
  if (confirm !== true || !validVersion(version)) throw new MediaError('UPDATE_CONFIRMATION_REQUIRED', '请确认要跳过的版本。');
  const installation = await managedInstallation(options);
  if (!installation) throw new MediaError('UPDATE_NOT_MANAGED', '当前连接器未受管。');
  const latest = await releaseStatus(installation, options);
  if (version !== latest || compareVersions(version, installation.version) <= 0) {
    throw new MediaError('UPDATE_VERSION_CHANGED', '可用版本已变化，请重新检查更新。');
  }
  await writeAtomic(skippedUpdatePath(installation), JSON.stringify({ origin: installation.origin, version }));
  return { status: 'update_skipped', skipped_version: version, message: '已跳过此版本。有更新的版本时会再次提醒。' };
}

export async function withUpdateNotice(result, options) {
  const update = await checkUpdate(options).catch(() => null);
  if (!update?.post_update_verification && !['update_available', 'restart_required'].includes(update?.status)) return result;
  if (update.status === 'update_available') {
    const installation = await managedInstallation(options).catch(() => null);
    const skipped = installation && await readJson(skippedUpdatePath(installation)).catch(() => null);
    if (skipped?.origin === installation?.origin && skipped?.version === update.latest_version) {
      if (!update.restart_required && !update.post_update_verification) return result;
      update.status = update.restart_required ? 'restart_required' : 'up_to_date';
      delete update.message;
    }
  }
  const structuredContent = { ...result.structuredContent, bk_update: update };
  return { ...result, structuredContent, content: [{ type: 'text', text: JSON.stringify(structuredContent) }] };
}
