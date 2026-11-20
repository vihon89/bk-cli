#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { bootstrap } from '../client/bootstrap.mjs';

const packageInfo = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const runtimeDirectory = new URL('../dist/runtime/', import.meta.url);
const versionPattern = /^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$/;
const help = `BK爆款 CLI ${packageInfo.version}
  mubai-media install --client generic --base-url https://aibaokuan.top
  mubai-media login --client generic --base-url https://aibaokuan.top --wait
  mubai-media status --client generic --verify
  mubai-media list_models --input models.json
  mubai-media --version

常用业务命令：get_account、list_models、upload_asset、quote_generation、generate_image、generate_video、get_task。`;

async function readPointer() {
  const root = path.join(homedir(), '.mubai-media-mcp');
  const marker = path.join(root, 'current.json');
  try {
    if ((await lstat(root)).isSymbolicLink() || !(await lstat(marker)).isFile()) throw new Error('本地运行时路径无效。');
    const pointer = JSON.parse(await readFile(marker, 'utf8'));
    if (pointer.schema !== 1 || !versionPattern.test(pointer.version)) throw new Error('本地运行时版本无效。');
    return { root, pointer };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function install(args) {
  const baseIndex = args.indexOf('--base-url');
  if (baseIndex < 0 || !args[baseIndex + 1]) throw new Error('请输入 --base-url 和 BK 官网地址。');
  const origin = args[baseIndex + 1];
  const options = args.filter((_, index) => index !== baseIndex && index !== baseIndex + 1);
  if (options.includes('--home')) throw new Error('npm 命令使用当前操作系统用户目录。');
  const localOptions = options.filter(value => value === '--allow-http-localhost');
  if (localOptions.length > 1) throw new Error('安装参数重复。');
  const release = JSON.parse(await readFile(new URL('manifest.json', runtimeDirectory), 'utf8'));
  await bootstrap({ origin, allowHttpLocalhost: localOptions.length === 1 }, [
    ...options.filter(value => value !== '--allow-http-localhost'), '--no-login',
  ], {
    expectedVersion: packageInfo.version,
    async fetchBytes(_origin, route) {
      if (route === '/api/agent-access/distribution') {
        return Buffer.from(JSON.stringify({ data: { ...release, download_url: '/api/agent-access/download' } }));
      }
      if (route === '/api/agent-access/download') {
        return readFile(new URL('runtime.zip', runtimeDirectory));
      }
      throw new Error('本地安装请求无效。');
    },
  });
}

async function runManaged(args) {
  const installation = await readPointer();
  if (!installation) throw new Error('请先运行 mubai-media install。');
  const { root, pointer } = installation;
  const relative = path.join('versions', pointer.version, 'src', 'cli.mjs');
  const entry = await realpath(path.join(root, relative));
  if (path.relative(await realpath(root), entry) !== relative) throw new Error('本地运行时路径无效。');

  const clients = Object.keys(pointer.installs ?? {});
  const scopedCommand = ['login', 'status', 'logout', 'chat-models', 'chat-quote', 'chat-complete', 'check-update', 'update', 'skip-update'].includes(args[0]);
  const explicitClient = scopedCommand && args.includes('--client');
  const client = clients.includes('generic') ? 'generic' : clients.length === 1 ? clients[0] : undefined;
  const env = { ...process.env };
  if (!explicitClient && !env.MUBAI_CLIENT_ID) {
    if (!client) throw new Error('未确定宿主，请指定 MUBAI_CLIENT_ID 或为授权命令传入 --client。');
    env.MUBAI_CLIENT_ID = client;
  }
  const child = spawn(process.execPath, [entry, ...args], {
    env, stdio: 'inherit', windowsHide: true,
  });
  process.exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve(code ?? 1));
  });
}

try {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--version' && !args.length) process.stdout.write(`${packageInfo.version}\n`);
  else if (!command || command === '--help' || command === '-h') process.stdout.write(`${help}\n`);
  else if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('需要 Node.js 20 或更新版本。');
  else if (command === 'install') await install(args);
  else await runManaged([command, ...args]);
} catch (error) {
  const message = error.stderr?.split(/\r?\n/, 1)[0] || error.message;
  process.stderr.write(`BK CLI: ${message}\n`);
  process.exitCode = 1;
}
