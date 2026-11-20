import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, lstat, readdir, rmdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MediaError } from './client.mjs';
import { assertSafePath } from './credential-store.mjs';

export async function withLocalLock(lock, action, busyFactory) {
  await assertSafePath(lock);
  const nonce = randomUUID(); const owner = `owner-${process.pid}-${nonce}.json`;
  const staged = `${lock}.claim-${nonce}`;
  const busy = busyFactory || (() => new MediaError('OPERATION_BUSY', '同一操作正在执行或无法确认原进程已退出；保留原 operation_id 稍后恢复。'));
  const dead = pid => { if (!Number.isSafeInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } };
  const removeEmpty = async target => { try { await rmdir(target); } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; } };
  await mkdir(staged, { mode: 0o700 });
  const handle = await open(path.join(staged, owner), 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify({ pid: process.pid, nonce })); await handle.sync(); } finally { await handle.close(); }
  let acquired = false;
  try {
    for (let attempt = 0; attempt < 5 && !acquired; attempt++) {
      await assertSafePath(lock);
      try { await mkdir(lock, { mode: 0o700 }); acquired = true; await rename(path.join(staged, owner), path.join(lock, owner)); await removeEmpty(staged); break; }
      catch (error) { if (!['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR', 'EACCES', 'EPERM'].includes(error.code)) throw error; }
      let info; try { info = await lstat(lock); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      // Legacy file locks require manual recovery: their filename has no immutable owner nonce.
      if (!info.isDirectory()) throw busy();
      const entries = await readdir(lock);
      // An empty directory may belong to a process still publishing its owner file.
      if (!entries.length) throw busy();
      if (entries.length !== 1 || !/^owner-[1-9][0-9]*-[a-f0-9-]{36}\.json$/.test(entries[0])) throw busy();
      const previous = path.join(lock, entries[0]); await assertSafePath(previous);
      let old; try { old = JSON.parse(await readFile(previous, 'utf8')); } catch (error) { if (error.code === 'ENOENT') continue; throw busy(); }
      if (entries[0] !== `owner-${old.pid}-${old.nonce}.json` || !dead(old.pid)) throw busy();
      // Only the reaper that removed this exact owner may remove the empty directory.
      // Another reaper must not remove a new owner's not-yet-published directory.
      try { await unlink(previous); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      await removeEmpty(lock);
    }
    if (!acquired) throw busy();
    return await action();
  } finally {
    const location = acquired ? lock : staged;
    await unlink(path.join(location, owner)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await removeEmpty(location);
  }
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function payloadHash(value) { return createHash('sha256').update(stableJson(value)).digest('hex'); }

export class AccountOperationStore {
  constructor(client, config) { this.client = client; this.config = config; }
  async withOperation(operationId, fn) {
    // Resolve each operation, including local replays: revocation/owner changes can occur while MCP stays alive.
    const account = await this.client.account();
    if (!Number.isSafeInteger(account.api_app_id) || account.api_app_id <= 0 || !Number.isSafeInteger(account.account_id) || account.account_id <= 0) throw new MediaError('INVALID_ACCOUNT', '账户接口缺少稳定的 api_app_id/account_id，不能安全保存可扣费操作。');
    // Explicit versioned namespace; never inherit older app-only state after an ownership change.
    const store = new OperationStore({ stateDir: this.config.stateDir, identity: `v2-${payloadHash(`${this.config.baseUrl}\0account:${account.account_id}\0api_app:${account.api_app_id}`).slice(0, 24)}` });
    return store.withOperation(operationId, fn);
  }
}

export class OperationStore {
  constructor({ stateDir, identity }) { this.directory = path.resolve(stateDir || path.join(os.homedir(), '.mubai-media'), identity); }
  async withOperation(operationId, fn) {
    if (!/^[A-Za-z0-9_.-]{8,128}$/.test(operationId)) throw new MediaError('INVALID_OPERATION_ID', 'operation_id 须为 8–128 位字母、数字、点、下划线或连字符。');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, `${payloadHash(operationId)}.json`);
    const lock = `${file}.lock`;
    return withLocalLock(lock, async () => {
      let state = null;
      try { state = JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw new MediaError('STATE_UNREADABLE', '操作记录无法读取；停止提交并保留记录以核对账单。'); }
      const save = async next => {
        const tmp = `${file}.${randomUUID()}.tmp`;
        const target = await open(tmp, 'wx', 0o600);
        try { await target.writeFile(JSON.stringify(next)); await target.sync(); } finally { await target.close(); }
        await rename(tmp, file);
        state = next;
      };
      return await fn(state, save);
    });
  }
}
