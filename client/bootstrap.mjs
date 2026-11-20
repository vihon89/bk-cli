#!/usr/bin/env node
// Server replaces the complete quoted placeholder with a validated JSON object.
const CONFIG = "__MUBAI_BOOTSTRAP_CONFIG__";
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';

export const ALLOWED_FILES = ['package.json', 'package-lock.json', 'README.md', 'install.ps1', 'install.mjs', 'bootstrap.mjs',
  'src/client.mjs', 'src/cli.mjs', 'src/operation-store.mjs', 'src/server.mjs', 'src/server-http.mjs', 'src/service.mjs', 'src/tools.mjs',
  'src/host-adapters.mjs', 'src/installer.mjs', 'src/install-check.mjs', 'src/launcher.mjs', 'src/origin.mjs', 'src/credential-store.mjs', 'src/device-auth.mjs', 'src/workbuddy-models.mjs', 'src/updates.mjs', 'src/chat-client.mjs', 'src/chat-models.mjs', 'src/video-env.mjs', 'src/motion-case.mjs', 'src/motion-runner.py',
  'skills/mubai-product-images/SKILL.md', 'skills/mubai-product-video/SKILL.md', 'skills/bk-video-episode/SKILL.md', 'skills/bk-video-episode/runtime/package.json', 'skills/bk-video-episode/runtime/package-lock.json', 'skills/bk/SKILL.md', 'skills/bk/agents/openai.yaml'].map(name => `mubai-media-mcp/${name}`);
const MAX_ZIP = 5 * 1024 * 1024;
const MAX_EXPANDED = 10 * 1024 * 1024;
const hasUniversalChat = version => {
  const [major, minor] = String(version).split('.').map(Number);
  return major > 0 || minor >= 7;
};
const crcTable = Uint32Array.from({ length: 256 }, (_, number) => {
  for (let bit = 0; bit < 8; bit++) number = (number & 1) ? (0xedb88320 ^ (number >>> 1)) : number >>> 1;
  return number >>> 0;
});
export function crc32(bytes) { let value = 0xffffffff; for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8); return (value ^ 0xffffffff) >>> 0; }
const reject = message => { throw new Error(message); };

export function bootstrapOrigin(config) {
  const url = new URL(config.origin);
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) reject('安装入口的网站地址无效。');
  if (config.allowHttpLocalhost === true && ['localhost', '127.0.0.1', '[::1]'].includes(host) && url.protocol === 'http:' && Number(url.port) >= 1024) return url.origin;
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') || !host.includes('.') || host.includes(':') || /\.(?:localhost|local|internal|lan|test|invalid)$/.test(host)) reject('安装入口仅接受公开 HTTPS；本机 HTTP 开发端口需显式启用。');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split('.').map(Number);
    if ([0, 10, 127].includes(a) || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b)) || (a === 198 && [18, 19, 51].includes(b)) || (a === 203 && b === 0)) reject('安装地址不能是私有或保留 IP。');
  }
  return url.origin;
}

export function checkedManifest(value) {
  const release = value?.data;
  let requiredFiles = hasUniversalChat(release?.version) ? ALLOWED_FILES : ALLOWED_FILES.filter(name => !/\/src\/chat-(?:client|models)\.mjs$/.test(name));
  const [major, minor, patch] = String(release?.version).split(".").map(Number);
  if (major === 0 && (minor < 8 || (minor === 8 && patch < 4))) requiredFiles = requiredFiles.filter(name => !name.endsWith("/motion-case.mjs") && !name.endsWith("/motion-runner.py"));
  if (!release || !/^\d+\.\d+\.\d+$/.test(release.version) || release.filename !== `mubai-media-mcp-${release.version}.zip`
      || release.download_url !== '/api/agent-access/download' || !/^[a-f0-9]{64}$/.test(release.sha256)
      || !Number.isSafeInteger(release.bytes) || release.bytes < 1 || release.bytes > MAX_ZIP || release.requires_node !== '>=20' || release.transport !== 'stdio'
      || !Array.isArray(release.files) || release.files.length < requiredFiles.length || release.files.length > 100
      || release.files.some(name => typeof name !== 'string' || !/^mubai-media-mcp\/(?:src\/(?:[a-z][a-z0-9-]*\/)*[a-z][a-z0-9-]*\.mjs|src\/motion-runner\.py|skills\/[a-z][a-z0-9-]*\/(?:SKILL\.md|agents\/openai\.yaml|runtime\/package(?:-lock)?\.json)|package(?:-lock)?\.json|README\.md|install\.(?:mjs|ps1)|bootstrap\.mjs)$/.test(name))
      || new Set(release.files.map(name => name.toLowerCase())).size !== release.files.length
      || !requiredFiles.every(name => release.files.includes(name))) reject('网站发行清单不符合客户端白名单。');
  return release;
}

export function verifiedZip(bytes, release) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== release.bytes || bytes.length > MAX_ZIP || createHash('sha256').update(bytes).digest('hex') !== release.sha256) reject('ZIP 的 SHA-256 或字节数与网站清单不一致。');
  if (bytes.length < 22) reject('ZIP 文件截断。');
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) reject('只支持单卷普通 ZIP。');
  const count = bytes.readUInt16LE(end + 10); const directorySize = bytes.readUInt32LE(end + 12); const directoryStart = bytes.readUInt32LE(end + 16);
  if (count !== release.files.length || bytes.readUInt16LE(end + 8) !== count || directoryStart + directorySize !== end) reject('ZIP 目录不完整或不是受支持的发行包。');
  let offset = directoryStart; let expanded = 0;
  const entries = []; const names = new Set();
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) reject('ZIP 中央目录损坏。');
    const flags = bytes.readUInt16LE(offset + 8); const method = bytes.readUInt16LE(offset + 10); const crc = bytes.readUInt32LE(offset + 16);
    const compressed = bytes.readUInt32LE(offset + 20); const size = bytes.readUInt32LE(offset + 24);
    const nameSize = bytes.readUInt16LE(offset + 28); const extraSize = bytes.readUInt16LE(offset + 30); const commentSize = bytes.readUInt16LE(offset + 32);
    const mode = bytes.readUInt32LE(offset + 38) >>> 16; const localOffset = bytes.readUInt32LE(offset + 42);
    const next = offset + 46 + nameSize + extraSize + commentSize;
    if (next > end || flags & ~0x0800 || ![0, 8].includes(method) || bytes.readUInt16LE(offset + 34) !== 0 || (mode & 0xf000) !== 0x8000) reject('ZIP 包含加密、链接、特殊文件或不支持的格式。');
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameSize); const name = nameBytes.toString('utf8');
    if (!release.files.includes(name) || names.has(name.toLowerCase()) || name.includes('\\') || name.split('/').some(part => part === '..' || part === '.')) reject('ZIP 包含未授权、重复或不安全路径。');
    names.add(name.toLowerCase()); expanded += size;
    if (expanded > MAX_EXPANDED || size > MAX_EXPANDED || compressed > MAX_ZIP || localOffset + 30 > directoryStart || bytes.readUInt32LE(localOffset) !== 0x04034b50) reject('ZIP 解压体积或本地文件头无效。');
    const localNameSize = bytes.readUInt16LE(localOffset + 26); const localExtra = bytes.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameSize + localExtra; const dataEnd = dataStart + compressed;
    if (dataEnd > directoryStart || !bytes.subarray(localOffset + 30, localOffset + 30 + localNameSize).equals(nameBytes)
        || bytes.readUInt16LE(localOffset + 6) !== flags || bytes.readUInt16LE(localOffset + 8) !== method || bytes.readUInt32LE(localOffset + 14) !== crc
        || bytes.readUInt32LE(localOffset + 18) !== compressed || bytes.readUInt32LE(localOffset + 22) !== size) reject('ZIP 中央目录与本地文件头不一致。');
    let content;
    try { content = method === 0 ? Buffer.from(bytes.subarray(dataStart, dataEnd)) : inflateRawSync(bytes.subarray(dataStart, dataEnd), { maxOutputLength: Math.max(1, size) }); }
    catch { reject('ZIP 解压失败或超出声明大小。'); }
    if (content.length !== size || crc32(content) !== crc) reject('ZIP 文件大小或 CRC 校验失败。');
    entries.push({ name, content, start: localOffset, end: dataEnd }); offset = next;
  }
  if (offset !== end) reject('ZIP 中央目录存在多余内容。');
  let cursor = 0;
  for (const entry of [...entries].sort((a, b) => a.start - b.start)) { if (entry.start !== cursor) reject('ZIP 本地文件区域重叠或含未列出的内容。'); cursor = entry.end; }
  if (cursor !== directoryStart) reject('ZIP 文件区域与中央目录不匹配。');
  return entries;
}

async function fetchBytes(origin, endpoint, expectedType, limit, timeout = 30000) {
  let response;
  try { response = await fetch(origin + endpoint, { headers: { Accept: expectedType }, redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(timeout) }); }
  catch { reject('安装包下载失败或发生重定向，请回到网站重新获取统一安装入口。'); }
  if (!response.ok || response.headers.get('content-type')?.split(';')[0].trim() !== expectedType) reject('网站返回了错误页面或不符合类型的安装内容。');
  let length = 0; const chunks = [];
  for await (const chunk of response.body || []) { length += chunk.length; if (length > limit) reject('下载内容超过允许大小。'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}

export async function fetchRelease(origin, timeout = 30000, download = fetchBytes) {
  return checkedManifest(JSON.parse((await download(origin, '/api/agent-access/distribution', 'application/json', 65536, timeout)).toString()));
}

export function bootstrapArguments(argv, config, env = process.env) {
  const options = { skill: config.skill || 'all', client: env.CODEX_THREAD_ID ? 'codex' : undefined };
  const supplied = new Set();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (supplied.has(flag)) reject('安装参数重复。'); supplied.add(flag);
    if (['--no-login', '--no-browser'].includes(flag)) { const key = flag === '--no-login' ? 'noLogin' : 'noBrowser'; if (options[key]) reject('安装参数重复。'); options[key] = true; }
    else if (['--client', '--skill', '--home'].includes(flag)) { const value = argv[++index]; if (!value || value.startsWith('--')) reject('安装参数缺少值。'); options[flag.slice(2)] = value; }
    else reject('安装参数无效；不接受 Key、口令或网站地址参数。');
  }
  if (!['codex', 'workbuddy', 'zcode', 'qwen', 'openclaw', 'grok-cli', 'kimi', 'deepseek-harness', 'generic'].includes(options.client)) reject('不能可靠识别当前客户端。请明确追加 --client codex|workbuddy|zcode|qwen|openclaw|grok-cli|kimi|deepseek-harness|generic。');
  if (!['images', 'video', 'episode', 'all'].includes(options.skill)) reject('--skill 仅支持 images、video、episode 或 all。');
  if (options.home && !path.isAbsolute(options.home)) reject('--home 必须是隔离用户目录的绝对路径。');
  return options;
}

export async function bootstrap(config, argv, dependencies = {}) {
  if (Number(process.versions.node.split('.')[0]) < 20) reject('需要 Node.js 20 或更新版本及 npm。');
  const origin = bootstrapOrigin(config);
  const options = bootstrapArguments(argv, config, dependencies.env || process.env);
  const download = dependencies.fetchBytes || fetchBytes;
  const release = await fetchRelease(origin, 30000, download);
  if (dependencies.expectedVersion && release.version !== dependencies.expectedVersion) reject('发布版本已变化，请重新检查并确认。');
  const entries = verifiedZip(await download(origin, release.download_url, 'application/zip', MAX_ZIP), release);
  const packageJson = JSON.parse(entries.find(entry => entry.name === 'mubai-media-mcp/package.json').content);
  const packageLock = JSON.parse(entries.find(entry => entry.name === 'mubai-media-mcp/package-lock.json').content);
  if (packageJson.version !== release.version || packageLock.version !== release.version || packageLock.packages?.['']?.version !== release.version) reject('ZIP 中的版本与网站清单不一致。');
  const tempRoot = await realpath(tmpdir());
  const temporary = await mkdtemp(path.join(tempRoot, 'mubai-bootstrap-'));
  try {
    // Every member and its complete contents were verified before the first write.
    for (const entry of entries) {
      const target = path.resolve(temporary, ...entry.name.split('/'));
      if (!target.startsWith(temporary + path.sep)) reject('安装路径逃逸。');
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 }); await writeFile(target, entry.content, { flag: 'wx', mode: 0o600 });
    }
    const args = [path.join(temporary, 'mubai-media-mcp/install.mjs'), '--client', options.client, '--skill', options.skill, '--base-url', origin];
    if (options.home) args.push('--home', options.home);
    if (config.allowHttpLocalhost === true) args.push('--allow-http-localhost');
    const result = await (dependencies.runInstall || promisify(execFile))(process.execPath, args, { timeout: 210000, maxBuffer: 1024 * 1024, windowsHide: true });
    const marker = result.stdout.indexOf('\n本地');
    const installation = JSON.parse(marker < 0 ? result.stdout : result.stdout.slice(0, marker));
    if (!dependencies.quiet) process.stdout.write(result.stdout);
    if (!options.noLogin) {
      const login = [path.join(installation.runtime, 'src/cli.mjs'), 'login', '--base-url', origin, '--client', options.client, '--skill', options.skill];
      if (config.chatEnabled === true && (hasUniversalChat(release.version) || options.client === 'workbuddy')) login.push('--chat', '--auto-complete');
      if (options.home) login.push('--home', options.home);
      if (options.noBrowser) login.push('--no-browser');
      if (config.allowHttpLocalhost === true) login.push('--allow-http-localhost');
      await (dependencies.runLogin || ((command, arguments_, settings) => new Promise((resolve, rejectPromise) => {
        const child = spawn(command, arguments_, { stdio: 'inherit', windowsHide: true, ...settings });
        child.on('error', () => rejectPromise(new Error('安装完成，但登录命令未启动；可从安装目录重新运行 login。')));
        child.on('close', code => code === 0 ? resolve() : rejectPromise(new Error('安装完成，网站授权尚未完成；请使用原请求继续登录。')));
      })))(process.execPath, login, { env: { ...process.env, MUBAI_CLIENT_ID: options.client } });
    }
    return { installed: true, version: release.version, client: options.client, login_requested: !options.noLogin,
      ...(installation.configuration_status ? { configuration_status: installation.configuration_status } : {}) };
  } finally {
    if (path.dirname(temporary) !== tempRoot || !path.basename(temporary).startsWith('mubai-bootstrap-')) reject('临时目录边界无效，停止清理。');
    await rm(temporary, { recursive: true, force: true });
  }
}

if (typeof CONFIG === 'object' && CONFIG !== null) {
  try { await bootstrap(CONFIG, process.argv.slice(process.argv[1]?.startsWith('--') ? 1 : 2)); }
  catch (error) { process.stderr.write(`安装未完成：${error.message}\n`); process.exitCode = 1; }
}
