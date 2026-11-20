import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, mkdir, open, rename, unlink, lstat, readdir, rmdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { websiteOrigin } from './origin.mjs';
import { supportsClient } from './host-adapters.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
export class AuthError extends Error { constructor(code, message) { super(message); this.code = code; } }
export const credentialIsCurrent = (profile, nowSeconds = Math.floor(Date.now() / 1000)) => Number.isSafeInteger(profile?.expires_at) && ((profile.expires_at === 0 && profile.non_expiring === true) || profile.expires_at > nowSeconds);
export function credentialClient({ client, env = process.env } = {}) {
  const id = client || env.MUBAI_CLIENT_ID;
  if (id !== undefined && !supportsClient(id)) throw new AuthError('INVALID_CLIENT_PROFILE', 'MUBAI_CLIENT_ID 必须是受支持的宿主标识。');
  if (client && env.MUBAI_CLIENT_ID && client !== env.MUBAI_CLIENT_ID) throw new AuthError('CLIENT_PROFILE_CONFLICT', '命令客户端与当前宿主授权分区不一致；请核对MUBAI_CLIENT_ID。');
  return id;
}
const profileDirectory = (directory, client) => client ? path.join(directory, 'clients', client) : directory;
export function credentialDirectory({ home, env = process.env, client } = {}) {
  const id = credentialClient({ client, env });
  if (home) { if (!path.isAbsolute(home)) throw new AuthError('INVALID_HOME', '--home 必须是绝对目录。'); return profileDirectory(path.join(home, '.mubai-media-mcp', 'auth'), id); }
  if (env.MUBAI_CREDENTIAL_DIR) { if (!path.isAbsolute(env.MUBAI_CREDENTIAL_DIR)) throw new AuthError('INVALID_HOME', '凭据目录必须是绝对目录。'); return profileDirectory(env.MUBAI_CREDENTIAL_DIR, id); }
  const versionDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  if (/^\d+\.\d+\.\d+$/.test(path.basename(versionDirectory)) && path.basename(path.dirname(versionDirectory)) === 'versions') return profileDirectory(path.join(path.dirname(path.dirname(versionDirectory)), 'auth'), id);
  return profileDirectory(path.join(homedir(), '.mubai-media-mcp', 'auth'), id);
}

export async function assertSafePath(target) {
  let cursor = path.resolve(target);
  for (;;) {
    try { if ((await lstat(cursor)).isSymbolicLink()) throw new AuthError('UNSAFE_STORE', '凭据路径不能包含符号链接或 junction。'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
}

export async function writeAtomic(target, text) {
  await assertSafePath(target); await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temporary, target); } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

// stdin contains secrets; command/argv, logs and thrown errors never do.
export function privateProcess(command, args, input = '', { timeout = 15000, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const environment = { ...process.env };
    for (const name of Object.keys(environment)) if (name.toUpperCase().startsWith('MUBAI_')) delete environment[name];
    const child = spawnImpl(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: environment });
    let output = ''; let size = 0; let settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => { child.kill(); finish(new AuthError('SECURE_STORE_UNAVAILABLE', '系统安全存储响应超时；未回退到明文。')); }, timeout);
    child.stdout.on('data', data => { size += data.length; if (size > 262144) { child.kill(); finish(new AuthError('SECURE_STORE_UNAVAILABLE', '系统安全存储响应过大。')); } else output += data.toString(); });
    child.stderr.on('data', () => {});
    child.on('error', () => finish(new AuthError('SECURE_STORE_UNAVAILABLE', '系统安全存储不可用；未回退到明文。')));
    child.on('close', code => finish(null, { code, output }));
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}

const DPAPI_SCRIPT = `$ErrorActionPreference = "Stop"; Add-Type -AssemblyName System.Security; $r = [Console]::In.ReadToEnd() | ConvertFrom-Json; $b = [Convert]::FromBase64String($r.data); if ($r.action -eq 'protect') { $v = [Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser) } elseif ($r.action -eq 'unprotect') { $v = [Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser) } else { exit 2 }; [Console]::Out.Write([Convert]::ToBase64String($v)); if (-not $?) { exit 1 }`;
export function osVault(directory, { platform = process.platform, run = privateProcess } = {}) {
  const namespace = digest(path.resolve(directory)).slice(0, 32);
  const file = id => path.join(directory, `${id}.vault`);
  const service = id => `com.mubai.media.${namespace}.${id}`;
  const safeId = id => { if (!/^[a-f0-9]{64}$/.test(id)) throw new AuthError('INVALID_STORE_ID', '凭据记录编号无效。'); };
  const failure = stage => new AuthError('WINDOWS_CREDENTIAL_' + stage + '_FAILED', {
    SAVE: 'Windows 无法保存授权。请在 WorkBuddy 对话中运行 BK 凭据自检。',
    READ: 'Windows 无法读取已有授权。请在最初授权的 Windows 用户下运行 BK 凭据自检。',
    VERIFY: 'Windows 写入后读回校验失败。请在 WorkBuddy 对话中运行 BK 凭据自检。'
  }[stage]);
  async function dpapi(action, bytes) {
    const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', DPAPI_SCRIPT], JSON.stringify({ action, data: bytes.toString('base64') }));
    const value = result.output.trim();
    if (result.code !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new AuthError('SECURE_STORE_UNAVAILABLE', 'Windows DPAPI 操作失败；未回退到明文。');
    return Buffer.from(value, 'base64');
  }
  return {
    async read(id) {
      safeId(id);
      if (platform === 'win32') {
        await assertSafePath(file(id));
        try {
          let raw;
          try { raw = await readFile(file(id), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
          const envelope = JSON.parse(raw);
          if (envelope.schema !== 1 || envelope.backend !== 'dpapi' || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.ciphertext)) throw new AuthError('INVALID_VAULT', '凭据文件格式无效。');
          return (await dpapi('unprotect', Buffer.from(envelope.ciphertext, 'base64'))).toString('utf8');
        } catch { throw failure('READ'); }
      }
      if (platform === 'darwin') {
        const result = await run('/usr/bin/security', ['find-generic-password', '-s', service(id), '-a', 'mubai-media', '-w']);
        if (result.code === 44) return null;
        if (result.code !== 0 || !/^[A-Za-z0-9_-]+$/.test(result.output.trim())) throw new AuthError('SECURE_STORE_UNAVAILABLE', 'macOS Keychain 读取失败；请检查系统授权。');
        return Buffer.from(result.output.trim(), 'base64url').toString('utf8');
      }
      if (platform === 'linux') {
        const result=await run('secret-tool',['lookup','service',service(id),'account','mubai-media']);
        if (result.code===1 && !result.output.trim()) return null;
        if (result.code!==0 || !/^[A-Za-z0-9_-]+$/.test(result.output.trim())) throw new AuthError('SECURE_STORE_UNAVAILABLE','Linux Secret Service 读取失败；请配置系统钥匙串，不会明文降级。');
        return Buffer.from(result.output.trim(),'base64url').toString('utf8');
      }
      throw new AuthError('SECURE_STORE_UNAVAILABLE', '自动授权当前支持 Windows DPAPI 或 macOS Keychain；未回退到明文。');
    },
    async write(id, value) {
      safeId(id); await assertSafePath(directory);
      if (platform !== 'win32') await mkdir(directory, { recursive: true, mode: 0o700 });
      if (platform === 'win32') {
        try {
          const encrypted = await dpapi('protect', Buffer.from(value));
          await writeAtomic(file(id), JSON.stringify({ schema: 1, backend: 'dpapi', ciphertext: encrypted.toString('base64') }));
        } catch (error) {
          if (error.code === 'UNSAFE_STORE') throw error;
          throw failure('SAVE');
        }
        try { if (await this.read(id) === value) return; } catch {}
        throw failure('VERIFY');
      } else if (platform === 'darwin') {
        const encoded = Buffer.from(value).toString('base64url');
        const command = `add-generic-password -U -s ${service(id)} -a mubai-media -w ${encoded}\n`;
        if (Buffer.byteLength(command) >= 4000) throw new AuthError('VAULT_TOO_LARGE', '安全存储记录过大。');
        const result = await run('/usr/bin/security', ['-i', '-q'], command);
        if (result.code !== 0) throw new AuthError('SECURE_STORE_UNAVAILABLE', 'macOS Keychain 保存失败；未回退到明文。');
      } else if (platform==='linux') {
        const result=await run('secret-tool',['store','--label=BK Agent','service',service(id),'account','mubai-media'],Buffer.from(value).toString('base64url'));
        if (result.code!==0) throw new AuthError('SECURE_STORE_UNAVAILABLE','Linux Secret Service 保存失败；未回退到明文。');
      } else throw new AuthError('SECURE_STORE_UNAVAILABLE', '此系统没有已支持的安全凭据存储。');
      if (await this.read(id) !== value) throw new AuthError('SECURE_STORE_UNAVAILABLE', '系统安全存储读回校验失败。');
    },
    async remove(id) {
      safeId(id);
      if (platform === 'win32') { await assertSafePath(file(id)); await unlink(file(id)).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      else if (platform === 'darwin') { const result = await run('/usr/bin/security', ['delete-generic-password', '-s', service(id), '-a', 'mubai-media']); if (![0, 44].includes(result.code)) throw new AuthError('SECURE_STORE_UNAVAILABLE', 'macOS Keychain 删除失败。'); }
      else if (platform==='linux') {const result=await run('secret-tool',['clear','service',service(id),'account','mubai-media']);if (![0,1].includes(result.code))throw new AuthError('SECURE_STORE_UNAVAILABLE','Linux Secret Service 删除失败。');}
      else throw new AuthError('SECURE_STORE_UNAVAILABLE', '此系统没有已支持的安全凭据存储。');
    }
  };
}

export function createCredentialStore(options = {}) {
  const client = credentialClient(options);
  const directory = path.resolve(options.directory ? profileDirectory(options.directory, client) : credentialDirectory(options));
  const vault = options.vault || osVault(directory, options);
  const id = (kind, origin, account = '') => digest(client ? `mubai-auth-client-v1\0${client}\0${kind}\0${origin}\0${account}` : `mubai-auth-v1\0${kind}\0${origin}\0${account}`);
  const connection = path.join(directory, 'connection.json');
  async function readSecret(kind, origin, account) { const value = await vault.read(id(kind, origin, account)); return value === null ? null : JSON.parse(value); }
  async function writeSecret(kind, origin, value, account) { await vault.write(id(kind, origin, account), JSON.stringify(value)); }
  return {
    directory,
    async diagnoseWindows() {
      if ((options.platform || process.platform) !== 'win32') return { status: 'not_applicable', next_step: '这项自检适用于 Windows。' };
      const probe = digest(randomUUID());
      let storage = 'ok';
      let cleanup = 'ok';
      try { await vault.write(probe, randomUUID()); }
      catch (error) { storage = error instanceof AuthError ? error.code : 'WINDOWS_CREDENTIAL_SAVE_FAILED'; }
      finally {
        try { await vault.remove(probe); } catch { cleanup = 'failed'; }
      }
      let authorization;
      try {
        const configured = (options.env || process.env).MUBAI_BASE_URL;
        const origin = configured && !/^https:\/\/your-website\.example\/?$/i.test(configured)
          ? websiteOrigin(configured, { allowHttpLocalhost: (options.env || process.env).MUBAI_ALLOW_HTTP_LOCALHOST === '1' })
          : (await this.connection())?.origin;
        const profile = origin && await this.read(origin);
        authorization = !profile ? 'missing' : profile.api_key && credentialIsCurrent(profile) ? 'readable' : 'expired_or_incomplete';
      } catch { authorization = 'read_failed'; }
      let next_step = '本机授权可读取。可以继续查询模型目录。';
      if (storage === 'WINDOWS_CREDENTIAL_VERIFY_FAILED') next_step = '临时凭据写入后无法读回。请在当前 Windows 用户会话重启 WorkBuddy 并复查；仍失败时请管理员检查 DPAPI。';
      else if (storage !== 'ok') next_step = '临时凭据保存失败。请检查当前 Windows 用户运行 PowerShell 和写入 BK 凭据目录的权限，然后再次自检。';
      else if (authorization === 'read_failed') next_step = '临时凭据读写正常，但已有授权读取失败。请用最初授权的 Windows 用户打开 WorkBuddy。若已是同一用户，请重新授权。';
      else if (authorization !== 'readable') next_step = '安全存储正常。请在当前 WorkBuddy 连接器完成 BK 授权，然后再次自检。';
      if (cleanup === 'failed') next_step += ' 临时记录清理失败，请检查凭据目录权限。';
      return { storage, authorization, cleanup, next_step };
    },
    async connection() {
      await assertSafePath(connection);
      try { const state = JSON.parse(await readFile(connection, 'utf8')); if (state.schema !== 1 || typeof state.origin !== 'string') throw new Error(); return state; }
      catch (error) { if (error.code === 'ENOENT') return null; throw new AuthError('INVALID_VAULT', '本机连接记录无效，请重新检查授权。'); }
    },
    async read(origin) {
      const current = await readSecret('active', origin);
      if (!current) return null;
      const profile = await readSecret('profile', origin, current.account_id);
      if (!profile || profile.base_url !== origin || profile.account_id !== current.account_id) throw new AuthError('INVALID_VAULT', '本机授权身份不一致。');
      return profile;
    },
    async save(origin, profile) {
      if (profile.base_url !== origin || !Number.isSafeInteger(profile.account_id) || profile.account_id <= 0) throw new AuthError('INVALID_VAULT', '不能保存不匹配的网站授权。');
      await writeSecret('profile', origin, profile, profile.account_id);
      await writeSecret('active', origin, { account_id: profile.account_id });
      await writeAtomic(connection, JSON.stringify({ schema: 1, origin, allow_http_localhost: profile.allow_http_localhost === true }));
    },
    pending: origin => readSecret('pending', origin),
    savePending: (origin, pending) => writeSecret('pending', origin, pending),
    clearPending: origin => vault.remove(id('pending', origin)),
    async logout(origin) {
      const current = await readSecret('active', origin);
      if (current) await vault.remove(id('profile', origin, current.account_id));
      await vault.remove(id('active', origin)); await vault.remove(id('pending', origin));
      // Keep the site selector and all operation records; never select another account implicitly.
    },
    async locked(origin, action) {
      await assertSafePath(directory); await mkdir(directory, { recursive: true, mode: 0o700 });
      const target = path.join(directory, `${id('lock', origin)}.lock`);
      const nonce = randomUUID(); const owner = `owner-${process.pid}-${nonce}.json`;
      const staged = path.join(directory, `.claim-${nonce}`);
      const busy = () => new AuthError('AUTH_BUSY', '此网站正在授权或退出，或锁的原进程无法核实；不会仅按超时抢占活锁。');
      const exited = pid => {
        if (!Number.isSafeInteger(pid) || pid <= 0) return false;
        try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
      };
      const removeEmpty = async location => { try { await rmdir(location); } catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; } };
      await mkdir(staged, { mode: 0o700 });
      const ownerHandle = await open(path.join(staged, owner), 'wx', 0o600);
      try { await ownerHandle.writeFile(JSON.stringify({ pid: process.pid, nonce })); await ownerHandle.sync(); } finally { await ownerHandle.close(); }
      let acquired = false;
      try {
        for (let attempt = 0; attempt < 5 && !acquired; attempt++) {
          await assertSafePath(target);
          try { await rename(staged, target); acquired = true; break; }
          catch (error) { if (!['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR', 'EACCES', 'EPERM'].includes(error.code)) throw error; }
          await assertSafePath(target);
          let info; try { info = await lstat(target); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
          if (info.isFile()) {
            // Migrate an abandoned v0.3 prerelease file lock only after its PID is confirmed gone.
            let old; try { old = JSON.parse(await readFile(target, 'utf8')); } catch { throw busy(); }
            if (!exited(old.pid)) throw busy();
            try { await unlink(target); } catch (error) { if (!['ENOENT', 'EISDIR', 'EPERM'].includes(error.code)) throw error; }
            continue;
          }
          if (!info.isDirectory()) throw busy();
          const entries = await readdir(target);
          if (entries.length === 0) { await removeEmpty(target); continue; }
          if (entries.length !== 1 || !/^owner-[1-9][0-9]*-[a-f0-9-]{36}\.json$/.test(entries[0])) throw busy();
          const previous = path.join(target, entries[0]); await assertSafePath(previous);
          let old; try { old = JSON.parse(await readFile(previous, 'utf8')); } catch (error) { if (error.code === 'ENOENT') continue; throw busy(); }
          if (entries[0] !== `owner-${old.pid}-${old.nonce}.json` || !exited(old.pid)) throw busy();
          // A unique owner filename prevents another reaper deleting a newly acquired lock.
          try { await unlink(previous); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          await removeEmpty(target);
        }
        if (!acquired) throw busy();
        return await action();
      } finally {
        if (acquired) { await unlink(path.join(target, owner)).catch(error => { if (error.code !== 'ENOENT') throw error; }); await removeEmpty(target); }
        else { await unlink(path.join(staged, owner)).catch(error => { if (error.code !== 'ENOENT') throw error; }); await removeEmpty(staged); }
      }
    }
  };
}

export async function storedCredential({ env = process.env, home, store = createCredentialStore({ env, home }) } = {}) {
  const configured = env.MUBAI_BASE_URL && !/^https:\/\/your-website\.example\/?$/i.test(env.MUBAI_BASE_URL) ? env.MUBAI_BASE_URL : null;
  const connection = configured ? null : await store.connection();
  if (!configured && !connection) throw new AuthError('LOGIN_REQUIRED', '请运行 login 并在网站点击授权。');
  const local = env.MUBAI_ALLOW_HTTP_LOCALHOST === '1' || connection?.allow_http_localhost === true;
  let origin;
  try { origin = websiteOrigin(configured || connection.origin, { allowHttpLocalhost: local }); }
  catch { throw new AuthError('INVALID_ORIGIN', '本机授权的网站地址无效，请通过网站统一安装入口重新运行 login。'); }
  const profile = await store.read(origin);
  if (!profile?.api_key || !credentialIsCurrent(profile)) throw new AuthError('LOGIN_REQUIRED', '本机授权缺失或已过期，请重新登录网站授权。');
  return profile;
}
