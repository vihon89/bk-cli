#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { buildTools, executeTool } from './tools.mjs';
import { safeError, MediaError } from './client.mjs';
import { authArguments, deviceRequest, runAuth } from './device-auth.mjs';
import { applyUpdate, checkUpdate, managedInstallation, skipUpdate, withUpdateNotice } from './updates.mjs';
import { createCredentialStore, storedCredential } from './credential-store.mjs';
import { readChatCatalog, requestChat } from './chat-client.mjs';

async function readInput(inputPath) {
  if (!inputPath) return {};
  let raw;
  if (inputPath === '-') {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) throw new MediaError('INVALID_ARGUMENTS', '参数文件超过 1 MB。');
      chunks.push(chunk);
    }
    raw = Buffer.concat(chunks).toString('utf8');
  } else raw = await readFile(inputPath, 'utf8');
  if (Buffer.byteLength(raw) > 1024 * 1024) throw new MediaError('INVALID_ARGUMENTS', '参数文件超过 1 MB。');
  try { return JSON.parse(raw); } catch { throw new MediaError('INVALID_ARGUMENTS', '参数文件不是有效 JSON。'); }
}

async function chatCommand(command, args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i], value = args[i + 1];
    if (!['--input', '--client', '--home'].includes(name) || options[name] || !value || value.startsWith('--')) {
      throw new MediaError('INVALID_ARGUMENTS', '对话命令只接受 --client、--home 和 --input。');
    }
    options[name] = value;
  }
  const installation = await managedInstallation({ client: options['--client'] }).catch(() => null);
  const store = createCredentialStore({ client: options['--client'] || installation?.client, home: options['--home'] });
  const profile = await storedCredential({ store });
  if (profile.chat_granted !== true) throw new MediaError('CHAT_AUTHORIZATION_REQUIRED', '请在当前客户端运行 login --chat 并完成网页授权。');
  if (command === 'chat-models' && !options['--input']) return readChatCatalog(profile.base_url, profile);
  if (command === 'chat-models' || !options['--input']) throw new MediaError('INVALID_ARGUMENTS', '报价和对话需提供 --input，列出模型无需参数文件。');
  const input = await readInput(options['--input']);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new MediaError('INVALID_ARGUMENTS', '对话参数必须是 JSON 对象。');
  if (command === 'chat-quote') return requestChat(profile.base_url, profile, 'quote', { body: input });
  if (input.confirm !== true || typeof input.request_id !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.request_id)
    || !input.body || typeof input.body !== 'object' || Array.isArray(input.body)) {
    throw new MediaError('CHAT_CONFIRMATION_REQUIRED', '请先确认积分用量，随后提供 confirm、request_id 和 body。');
  }
  return requestChat(profile.base_url, profile, 'complete', { body: { ...input.body, stream: false }, requestId: input.request_id });
}

try {
  const [command, flag, inputPath] = process.argv.slice(2);
  if (!command || ['--help', '-h'].includes(command)) {
    process.stdout.write('用法：node src/cli.mjs login|status|logout [--base-url 网站] [--home 隔离目录] [--client codex|workbuddy|zcode|qwen|openclaw|grok-cli|kimi|deepseek-harness|generic] [--skill images|video|episode|all] [--chat] [--no-browser] [--wait|--no-wait] [--force] [--revoke]\n连接检查：status --verify [--client 宿主]\n连接器：check-update [--client 宿主] | update|skip-update --version 版本 --confirm [--client 宿主]\n业务工具：<工具名> [--input 参数文件.json|-]\n凭据由网站授权，勿粘贴到聊天。\n');
    process.stdout.write('对话：chat-models | chat-quote --input 文件.json|- | chat-complete --input 文件.json|-，可指定 --client 宿主。\n');
  } else if (['chat-models', 'chat-quote', 'chat-complete'].includes(command)) {
    process.stdout.write(`${JSON.stringify({ data: await chatCommand(command, process.argv.slice(3)) })}\n`);
  } else if (['check-update', 'update', 'skip-update'].includes(command)) {
    const options = {};
    const args = process.argv.slice(3);
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      const name = arg.slice(2);
      const allowed = arg === '--client' || (command !== 'check-update' && ['--version', '--confirm'].includes(arg));
      if (!allowed || name in options) throw new MediaError('INVALID_ARGUMENTS', '更新参数无效，请查看 --help。');
      const value = arg === '--confirm' ? true : args[++index];
      if (!value || (typeof value === 'string' && value.startsWith('--'))) throw new MediaError('INVALID_ARGUMENTS', '更新参数缺少值。');
      options[name] = value;
    }
    const result = command === 'check-update' ? await checkUpdate({ ...options, force: true }) : await (command === 'update' ? applyUpdate : skipUpdate)(options);
    process.stdout.write(`${JSON.stringify({ data: result })}\n`);
  } else if (['login', 'status', 'logout'].includes(command)) {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
    try {
      const options = authArguments(process.argv.slice(3));
      if (command === 'login' && !options.wait) options.noWait = true;
      const installation = command === 'login' ? await managedInstallation({ client: options.client }).catch(() => null) : null;
      const result = await runAuth(command, options, { signal: controller.signal,
        onConnected: installation ? async (origin, profile) => {
          if (origin === installation.origin) await deviceRequest(origin, 'version', {
            key: profile.api_key, body: { version: installation.version }, signal: AbortSignal.timeout(2000),
          });
        } : undefined,
        progress: value => { process.stdout.write(`${JSON.stringify({ authorization: value })}\n`); if (value.user_code) process.stderr.write(`BK 授权确认码：${value.user_code}\n请在 Agent 对话中展示此码，供用户与网页核对。\n`); } });
      if (result.chat_authorization_requested && options.chat && options.autoComplete) {
        const args = process.argv.slice(3).filter(arg => !['--auto-complete', '--no-wait', '--no-browser'].includes(arg));
        result.authorization_waiting_in_background = await new Promise(resolve => {
          const child = spawn(process.execPath, [process.argv[1], 'login', ...args, '--no-browser', '--wait'],
            { detached: true, stdio: 'ignore', windowsHide: true });
          child.once('error', () => resolve(false));
          child.once('spawn', () => { child.unref(); resolve(true); });
        });
        if (result.authorization_waiting_in_background) result.message = '请展示确认码，等待用户网页授权。BK 会在后台领取授权并同步模型。';
      }
      const update = result.connected && command !== 'logout' ? await checkUpdate({ client: options.client, maintain: command !== 'login' && !options.verify }).catch(() => null) : null;
      process.stdout.write(`${JSON.stringify({ data: result, ...(['update_available', 'restart_required'].includes(update?.status) ? { bk_update: update } : {}) })}\n`);
    } finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
  } else {
    if (flag && (flag !== '--input' || !inputPath || process.argv.slice(2).length !== 3)) throw new MediaError('INVALID_ARGUMENTS', '参数格式为 <工具名> --input 参数文件.json 或 --input -。');
    const def = buildTools().find(t => t.name === command);
    if (!def) throw new MediaError('UNKNOWN_TOOL', '未知工具名。');
    const input = command === 'check_windows_credentials' && !flag ? {} : await readInput(inputPath);
    const raw = await executeTool(def, input);
    const result = command === 'check_windows_credentials' ? raw : await withUpdateNotice(raw);
    process.stdout.write(`${JSON.stringify(result.structuredContent)}\n`);
    if (result.isError) process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: safeError(error) })}\n`);
  process.exitCode = 1;
}
