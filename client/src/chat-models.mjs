import { lstat, readFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { AuthError, assertSafePath, writeAtomic } from './credential-store.mjs';
import { chatBaseUrl, chatCredential, chatKey, chatModelId, readChatCatalog } from './chat-client.mjs';
import { supportsClient } from './host-adapters.mjs';
import { syncWorkBuddyModels } from './workbuddy-models.mjs';

const provider = 'bk-baokuan';
const envKey = 'BK_BAOKUAN_CHAT_TOKEN';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const conflict = () => { throw new AuthError('CHAT_CONFIG_CONFLICT', '客户端的 BK 模型配置无法安全合并。请检查配置或使用 BK 对话命令。'); };

async function readConfig(target) {
  await assertSafePath(target);
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.nlink !== 1 || info.size > 1048576) conflict();
    return await readFile(target, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function section(document, key) {
  if (!Object.hasOwn(document, key)) document[key] = {};
  if (!object(document[key])) conflict();
  return document[key];
}

function isManagedModel(model) {
  return object(model) && typeof model.id === 'string' && chatModelId.test(model.id);
}

function qwenConfig(document, baseUrl, apiKey, models, remove) {
  const providers = section(document, 'modelProviders');
  const protocols = section(document, 'providerProtocol');
  const env = section(document, 'env');
  const existing = providers[provider];
  if (existing !== undefined || protocols[provider] !== undefined || env[envKey] !== undefined) {
    if (!Array.isArray(existing) || protocols[provider] !== 'openai' || !chatCredential.test(env[envKey])
      || existing.some(model => !isManagedModel(model) || model.baseUrl !== baseUrl || model.envKey !== envKey)) conflict();
    if (remove && env[envKey] !== apiKey) return;
  } else if (remove) return;
  if (models.length) {
    providers[provider] = models.map(({ id, name }) => ({ id, name, baseUrl, envKey, wireApi: 'chat-completions' }));
    protocols[provider] = 'openai';
    env[envKey] = apiKey;
  } else {
    delete providers[provider];
    delete protocols[provider];
    delete env[envKey];
  }
}

function openclawConfig(document, baseUrl, apiKey, models, remove) {
  const providers = section(section(document, 'models'), 'providers');
  const existing = providers[provider];
  if (existing !== undefined) {
    if (!object(existing) || existing.baseUrl !== baseUrl || existing.api !== 'openai-completions'
      || !chatCredential.test(existing.apiKey) || !Array.isArray(existing.models)
      || existing.models.some(model => !isManagedModel(model))) conflict();
    if (remove && existing.apiKey !== apiKey) return;
  } else if (remove) return;
  if (models.length) {
    providers[provider] = {
      baseUrl, apiKey, api: 'openai-completions',
      models: models.map(({ id, name, images }) => ({ id, name, input: images ? ['text', 'image'] : ['text'], maxTokens: 16384 })),
    };
  } else delete providers[provider];
}

export async function syncChatModels(origin, profile, { client, home = homedir(), signal, fetchImpl, remove = false, verifyOnly = false } = {}) {
  if (!supportsClient(client) || !path.isAbsolute(home)) conflict();
  if (client === 'workbuddy') {
    return { ...await syncWorkBuddyModels(origin, profile, { home, signal, fetchImpl, remove, verifyOnly }), mode: 'native' };
  }
  const configure = client === 'qwen' ? qwenConfig : client === 'openclaw' ? openclawConfig : null;
  const baseUrl = chatBaseUrl(origin);
  const apiKey = chatKey(profile);
  const models = remove ? [] : await readChatCatalog(origin, profile, { signal, fetchImpl });
  const target = configure
    ? path.join(home, client === 'qwen' ? '.qwen/settings.json' : '.openclaw/openclaw.json')
    : path.join(home, '.mubai-media-mcp', 'setup-templates', `${client}-chat.json`);
  const mode = configure ? 'native' : 'provider_file';
  const original = await readConfig(target);
  const result = { models: models.length, changed: false, mode, ...(configure || !models.length ? {} : { config_path: target }) };
  if (!original && !models.length) return result;
  let document;
  try { document = original === null ? {} : JSON.parse(original.replace(/^\uFEFF/, '')); } catch { conflict(); }
  if (!object(document)) conflict();
  const before = JSON.stringify(document);
  if (configure) {
    configure(document, baseUrl, apiKey, models, remove);
  } else {
    if (original !== null && (document.schema !== 1 || document.provider !== provider || document.protocol !== 'openai-chat-completions'
      || document.base_url !== baseUrl || !chatCredential.test(document.api_key))) conflict();
    if (remove && document.api_key !== apiKey) return result;
    document = models.length ? { schema: 1, provider, protocol: 'openai-chat-completions', base_url: baseUrl, api_key: apiKey, models } : null;
  }
  if (before === JSON.stringify(document)) return result;
  if (!verifyOnly) {
    if (await readConfig(target) !== original) conflict();
    if (document === null) await unlink(target);
    else await writeAtomic(target, JSON.stringify(document, null, 2) + '\n');
  }
  return { ...result, changed: true };
}
