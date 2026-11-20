import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { AuthError, assertSafePath, writeAtomic } from './credential-store.mjs';
import { chatCredential as credential, chatKey, chatModelId as modelId, readChatCatalog } from './chat-client.mjs';

const vendor = 'BK爆款';
const maxFileSize = 1024 * 1024;

function conflict() {
  throw new AuthError('WORKBUDDY_MODEL_CONFLICT', 'WorkBuddy 模型配置格式未知、存在同名模型或已被修改。请检查客户端的模型配置。');
}

async function currentFile(target) {
  await assertSafePath(target);
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.nlink !== 1 || info.size > maxFileSize) conflict();
    return await readFile(target, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function syncWorkBuddyModels(origin, profile, { home = homedir(), signal, fetchImpl = fetch, remove = false, verifyOnly = false } = {}) {
  if (!path.isAbsolute(home)) conflict();
  const target = path.join(home, '.workbuddy', 'models.json');
  const endpoint = `${origin}/v1/chat/completions`;
  const data = remove ? [] : await readChatCatalog(origin, profile, { signal, fetchImpl });
  const apiKey = chatKey(profile);
  const replacement = new Map();
  for (const item of data) {
    replacement.set(item.id, {
      id: item.id, name: item.name, vendor, url: endpoint, apiKey,
      supportsToolCall: item.tools, supportsImages: item.images, supportsReasoning: false, useCustomProtocol: false,
    });
  }

  const original = await currentFile(target);
  if (original === null && replacement.size === 0) return { models: 0, changed: false };
  let rows;
  try { rows = original === null ? [] : JSON.parse(original.replace(/^\uFEFF/, '')); } catch { conflict(); }
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) conflict();
  const imported = replacement.size;
  const next = [];
  const ids = new Set();
  for (const row of rows) {
    const managed = row.vendor === vendor && modelId.test(row.id) && row.url === endpoint && credential.test(row.apiKey);
    if (managed) {
      if (ids.has(row.id)) conflict();
      ids.add(row.id);
      if (remove && row.apiKey !== apiKey) next.push(row);
      if (replacement.has(row.id)) next.push(replacement.get(row.id));
      replacement.delete(row.id);
    } else {
      if (replacement.has(row.id) || ids.has(row.id)) conflict();
      next.push(row);
      if (typeof row.id === 'string') ids.add(row.id);
    }
  }
  if (JSON.stringify(rows) === JSON.stringify(next.concat([...replacement.values()]))) {
    return { models: imported, changed: false };
  }
  next.push(...replacement.values());
  if (verifyOnly) return { models: imported, changed: true };
  if (await currentFile(target) !== original) conflict();
  await writeAtomic(target, JSON.stringify(next, null, 2) + '\n');
  return { models: imported, changed: true };
}
