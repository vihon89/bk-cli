import { HOST_ADAPTERS, CLIENT_IDS, supportsClient, adapterPath, adapterSkillsPath, skillForClient, jsonConfiguration, workBuddyRename } from './host-adapters.mjs';
import { withLocalLock } from './operation-store.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { websiteOrigin } from './origin.mjs';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import path from 'node:path';
import { readFile, writeFile, mkdir, rename, lstat, realpath, open, rm, access } from 'node:fs/promises';

const run = promisify(execFile);
const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PACKAGE_FILES = ['package.json', 'package-lock.json', 'README.md', 'install.ps1', 'install.mjs', 'bootstrap.mjs',
  'src/client.mjs', 'src/cli.mjs', 'src/operation-store.mjs', 'src/server.mjs', 'src/server-http.mjs', 'src/service.mjs', 'src/tools.mjs',
  'src/host-adapters.mjs', 'src/installer.mjs', 'src/install-check.mjs', 'src/launcher.mjs', 'src/origin.mjs', 'src/credential-store.mjs', 'src/device-auth.mjs', 'src/workbuddy-models.mjs', 'src/updates.mjs', 'src/chat-client.mjs', 'src/chat-models.mjs', 'src/video-env.mjs', 'src/motion-case.mjs', 'src/motion-runner.py',
  'skills/mubai-product-images/SKILL.md', 'skills/mubai-product-video/SKILL.md', 'skills/bk-video-episode/SKILL.md', 'skills/bk-video-episode/runtime/package.json', 'skills/bk-video-episode/runtime/package-lock.json', 'skills/bk/SKILL.md', 'skills/bk/agents/openai.yaml'];
const hash = data => createHash('sha256').update(data).digest('hex');
const fail = message => { const error = new Error(message); error.code = 'INSTALL_CONFLICT'; throw error; };
const exists = async file => { try { await lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const json = async file => JSON.parse(await readFile(file, 'utf8'));

export function parseArguments(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true };
  const result = {};
  const names = { '--client': 'client', '--skill': 'skill', '--base-url': 'baseUrl', '--home': 'home' };
  for (let index = 0; index < argv.length; index += 2) {
    if (argv[index] === '--allow-http-localhost') { if (result.allowHttpLocalhost) throw new Error('Repeated test flag.'); result.allowHttpLocalhost = true; index--; continue; }
    const name = names[argv[index]];
    if (!name || result[name] !== undefined || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('Unsupported, repeated or missing installation argument. Run --help.');
    result[name] = argv[index + 1];
  }
  if (!supportsClient(result.client) || !['images', 'video', 'episode', 'all'].includes(result.skill)) throw new Error('--client codex|workbuddy|zcode|qwen|openclaw|grok-cli|kimi|deepseek-harness|generic and --skill images|video|episode|all are required.');
  return result;
}

export function installationPaths(home, platform = process.platform) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (!paths.isAbsolute(home)) throw new Error('--home must be an absolute directory.');
  const root = paths.join(home, '.mubai-media-mcp');
  return { root, launcher: paths.join(root, 'launch.mjs'), config: paths.join(home, '.codex', 'config.toml'),
    skills: paths.join(home, '.agents', 'skills'), workbuddy: paths.join(root, 'setup-templates', 'workbuddy-mcp.json') };
}

export function normalizeBaseUrl(value, allowHttpLocalhost = false) {
  if (!value) return 'https://YOUR-WEBSITE.example';
  return websiteOrigin(value, { allowHttpLocalhost });

}

// Refuse symlink/junction traversal for every existing ancestor of a write target.
async function safePath(target) {
  let cursor = path.resolve(target);
  for (;;) {
    try { if ((await lstat(cursor)).isSymbolicLink()) fail('Installation path contains a symlink or junction; choose a normal local directory.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
}

async function atomicWrite(target, content) {
  await safePath(target); await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
  try { await rename(temporary, target); } catch (error) { await rm(temporary, { force: true }); throw error; }
}

async function workBuddyConfig(target) {
  await safePath(target);
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.nlink !== 1 || info.size > 1024 * 1024) fail('无法安全读取 WorkBuddy 的 mcp.json。');
    return await readFile(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

// Persistent undo journal. Only restore a file if it still matches our planned write.
// Local backups may contain pre-existing client configuration; never print the journal.
async function recoverTransaction(journalPath, allowed) {
  if (!await exists(journalPath)) return;
  await safePath(journalPath);
  const journal = await json(journalPath);
  if (journal.schema !== 1 || !Array.isArray(journal.entries) || journal.entries.length > 16) fail('Invalid installation recovery journal; review it locally.');
  for (const entry of journal.entries) {
    if (!allowed.has(entry.target) || typeof entry.next_sha256 !== 'string' || (entry.original !== null && typeof entry.original !== 'string')) fail('Installation recovery journal has an unexpected target.');
    await safePath(entry.target);
    const current = await exists(entry.target) ? await readFile(entry.target) : null;
    const original = entry.original === null ? null : Buffer.from(entry.original, 'base64');
    if (current === null && original === null || current !== null && original !== null && current.equals(original)) continue;
    if (current === null || hash(current) !== entry.next_sha256) fail('Installation recovery found a user-edited file; it was not overwritten.');
  }
  for (const entry of [...journal.entries].reverse()) {
    if (entry.original === null) await rm(entry.target, { force: true });
    else await atomicWrite(entry.target, Buffer.from(entry.original, 'base64'));
  }
  await rm(journalPath);
}

async function commitTransaction(journalPath, writes, allowed, beforeWrite, verifyCommitted) {
  const entries = [];
  for (const { target, content, expected } of writes) {
    await safePath(target);
    const original = expected === undefined ? (await exists(target) ? await readFile(target) : null) : await workBuddyConfig(target);
    if (expected !== undefined && !original?.equals(expected)) fail('WorkBuddy 配置在升级期间已更改，请重试。');
    entries.push({ target, original: original?.toString('base64') ?? null, next_sha256: hash(content) });
  }
  await atomicWrite(journalPath, JSON.stringify({ schema: 1, entries }));
  try {
    for (let index = 0; index < writes.length; index++) {
      const { target, content, expected } = writes[index];
      await beforeWrite?.(target, index);
      if (expected !== undefined && !(await workBuddyConfig(target))?.equals(expected)) {
        // The guarded WorkBuddy write is first. No installation changes have been applied.
        await rm(journalPath);
        fail('WorkBuddy 配置在升级期间已更改，请重试。');
      }
      await atomicWrite(target, content);
    }
    await verifyCommitted?.();
    await rm(journalPath);
  } catch (error) {
    await recoverTransaction(journalPath, allowed);
    throw error;
  }
}

export async function findNpmCli(env = process.env, executable = process.execPath) {
  const locations = [path.join(path.dirname(executable), 'node_modules/npm/bin/npm-cli.js'), path.resolve(path.dirname(executable), '../lib/node_modules/npm/bin/npm-cli.js')];
  for (const entry of (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)) {
    locations.push(path.join(entry, 'node_modules/npm/bin/npm-cli.js'));
    try { locations.push(await realpath(path.join(entry, process.platform === 'win32' ? 'npm.cmd' : 'npm'))); } catch {}
  }
  for (const candidate of locations) if (candidate.endsWith('npm-cli.js') && await exists(candidate)) return candidate;
  throw new Error('npm was not found. Install Node.js 20 or newer with npm, then retry.');
}

function cleanEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith('MUBAI_')) delete env[key];
  return env;
}

async function runDependencies(directory) {
  const npmCli = await findNpmCli();
  try { await run(process.execPath, [npmCli, 'ci', '--ignore-scripts', '--prefix', directory], { env: cleanEnvironment(), timeout: 180000, maxBuffer: 2 * 1024 * 1024, windowsHide: true }); }
  catch { throw new Error('npm ci --ignore-scripts failed. Check Node/npm and registry connectivity, then retry.'); }
}

async function verify(directory, { launcher } = {}) {
  try { const result = await run(process.execPath, [path.join(directory, 'src/install-check.mjs'), ...(launcher ? ['--launcher', launcher] : [])], { env: cleanEnvironment(), timeout: 20000, windowsHide: true }); return JSON.parse(result.stdout); }
  catch { throw new Error('Local MCP initialize/tools/list verification failed; no website request was made.'); }
}

async function prepareRuntime(root, source, version, hooks) {
  const files = {};
  for (const name of PACKAGE_FILES) {
    const candidate = path.join(source, name); await safePath(candidate);
    if (!(await lstat(candidate)).isFile()) fail('Package contains a non-file entry.');
    files[name] = hash(await readFile(candidate));
  }
  const target = path.join(root, 'versions', version);
  await safePath(target);
  if (await exists(target)) {
    const marker = path.join(target, '.mubai-runtime.json');
    await safePath(marker);
    if (!await exists(marker)) fail('The target runtime directory already exists and is not managed by this installer.');
    const installed = await json(marker);
    if (installed.schema !== 1 || installed.version !== version || JSON.stringify(installed.files) !== JSON.stringify(files)) fail('Same-version package contents conflict; use a new version or review the existing installation.');
    for (const [name, digest] of Object.entries(files)) {
      await safePath(path.join(target, name));
      if (hash(await readFile(path.join(target, name))) !== digest) fail('Installed runtime was edited; it will not be overwritten.');
    }
    await hooks.verify(target);
    return { directory: target, skipped: true };
  }
  const staging = path.join(root, `.stage-${randomUUID()}`);
  await mkdir(staging);
  try {
    for (const name of PACKAGE_FILES) { const destination = path.join(staging, name); await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, await readFile(path.join(source, name)), { flag: 'wx', mode: 0o600 }); }
    await hooks.installDependencies(staging);
    await hooks.verify(staging);
    await writeFile(path.join(staging, '.mubai-runtime.json'), JSON.stringify({ schema: 1, version, files }, null, 2), { flag: 'wx', mode: 0o600 });
    await safePath(target); await mkdir(path.dirname(target), { recursive: true }); await rename(staging, target);
    return { directory: target, skipped: false };
  } catch (error) {
    // staging is a fresh, generated child of this installation root, never user state.
    if (path.dirname(staging) !== root || !path.basename(staging).startsWith('.stage-')) throw error;
    await rm(staging, { recursive: true, force: true }); throw error;
  }
}

export function codexAddition(original, parsed, launcher, baseUrl, node = process.execPath, allowHttpLocalhost = false, client = 'codex') {
  const existing = parsed.mcp_servers?.mubai_media;
  if (existing !== undefined) {
    if (existing.command !== node || JSON.stringify(existing.args) !== JSON.stringify([launcher]) || existing.url) fail('Codex already has a different mubai_media entry. It was not overwritten; review it locally.');
    if (existing.env?.MUBAI_CLIENT_ID !== undefined && existing.env.MUBAI_CLIENT_ID !== client) fail('Client credential profile conflicts with the selected host.');
    if (existing.env?.MUBAI_CLIENT_ID === undefined) {
      const assignment = `MUBAI_CLIENT_ID = ${JSON.stringify(client)}\n`;
      let text;
      if (existing.env === undefined) text = original + `\n[mcp_servers.mubai_media.env]\n${assignment}`;
      else {
        const header = /^\s*\[mcp_servers\.mubai_media\.env\][ \t]*(?:#[^\r\n]*)?\r?$/m;
        if (!header.test(original)) fail('Cannot safely add a credential profile to this TOML layout; review the local entry.');
        text = original.replace(header, match => `${match}\n${assignment.trimEnd()}`);
      }
      return { text, skipped: false, effectiveBaseUrl: existing.env?.MUBAI_BASE_URL || null };
    }
    return { text: original, skipped: true, effectiveBaseUrl: existing.env?.MUBAI_BASE_URL || null };
  }
  if (parsed.mcp_servers !== undefined && (typeof parsed.mcp_servers !== 'object' || Array.isArray(parsed.mcp_servers))) fail('Existing Codex mcp_servers is not a table.');
  const addition = `\n\n# Mubai Media installer: credentials stay in the OS vault or local environment.\n[mcp_servers.mubai_media]\ncommand = ${JSON.stringify(node)}\nargs = [${JSON.stringify(launcher)}]\nenv_vars = ["MUBAI_API_KEY", "MUBAI_STATE_DIR", "MUBAI_ASSET_ROOT"]\n\n[mcp_servers.mubai_media.env]\nMUBAI_BASE_URL = ${JSON.stringify(baseUrl)}\n${allowHttpLocalhost ? 'MUBAI_ALLOW_HTTP_LOCALHOST = "1"\n' : ''}`;
  return { text: original + addition.replace('MUBAI_BASE_URL =', `MUBAI_CLIENT_ID = ${JSON.stringify(client)}\nMUBAI_BASE_URL =`), skipped: false, effectiveBaseUrl: baseUrl };
}

export async function install(options, dependencies = {}) {
  if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Node.js 20 or newer is required.');
  if (!supportsClient(options.client) || !['images', 'video', 'episode', 'all'].includes(options.skill)) throw new Error('Choose a supported client and skill.');
  const defaultHome = dependencies.defaultHome || homedir();
  const home = options.home || defaultHome;
  const paths = installationPaths(home);
  paths.skills = adapterSkillsPath(home, options.client);
  const codexHome = (dependencies.env || process.env).CODEX_HOME;
  if (!options.home && codexHome) {
    if (!path.isAbsolute(codexHome)) throw new Error('CODEX_HOME must be absolute, or use --home for an isolated installation.');
    paths.config = path.join(codexHome, 'config.toml');
  }
  const source = dependencies.source || sourceRoot;
  const baseUrl = normalizeBaseUrl(options.baseUrl, options.allowHttpLocalhost === true);
  const packageInfo = await json(path.join(source, 'package.json'));
  const version = packageInfo.version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Package version is invalid.');
  for (const target of [paths.root, paths.config, paths.skills, paths.workbuddy, paths.launcher]) await safePath(target);
  await mkdir(paths.root, { recursive: true });
  const lockPath = path.join(paths.root, '.install.lock');
  return withLocalLock(lockPath, async () => {
    const configuration = options.client === 'codex' ? paths.config : adapterPath(home, options.client);
    // Older WorkBuddy installations could put BK's runtime under ~/.mubai-home while importing into the normal host profile.
    const workBuddyHome = path.relative(path.join(defaultHome, '.mubai-home'), home) === '' ? defaultHome : home;
    const workBuddyTarget = path.join(workBuddyHome, '.workbuddy', 'mcp.json');
    const journalPath = path.join(paths.root, `.install-transaction-${options.client}.json`);
    const allowed = new Set([configuration, paths.launcher, path.join(paths.root, 'current.json')]);
    allowed.add(workBuddyTarget);
    for (const client of CLIENT_IDS) for (const name of ['mubai-product-images', 'mubai-product-video', 'bk-video-episode', 'bk']) for (const relative of ['SKILL.md', '.mubai-install.json', ...(name === 'bk' ? ['agents/openai.yaml'] : (name === 'bk-video-episode' ? ['runtime/package.json', 'runtime/package-lock.json'] : []))]) allowed.add(path.join(adapterSkillsPath(home, client), name, relative));
    for (const client of CLIENT_IDS) allowed.add(client === 'codex' ? paths.config : adapterPath(home, client));
    for (const client of CLIENT_IDS) await recoverTransaction(path.join(paths.root, `.install-transaction-${client}.json`), allowed);
    const currentPath = path.join(paths.root, 'current.json');
    await safePath(currentPath);
    let priorCurrent = null;
    if (await exists(currentPath)) {
      priorCurrent = await json(currentPath);
      if (priorCurrent.schema !== 1 || !/^\d+\.\d+\.\d+$/.test(priorCurrent.version)) fail('Installed runtime pointer is invalid; it will not be overwritten.');
      const previous = priorCurrent.version.split('.').map(Number); const next = version.split('.').map(Number);
      const difference = next.map((part, index) => part - previous[index]).find(part => part !== 0) || 0;
      if (difference < 0) fail('An installed runtime is newer than this package; automatic downgrade is disabled.');
    }
    const workBuddyOriginal = options.client === 'workbuddy' && priorCurrent?.installs?.workbuddy && await exists(paths.launcher)
      ? await workBuddyConfig(workBuddyTarget) : null;
    let workBuddyPlan;
    if (workBuddyOriginal) {
      try { workBuddyPlan = workBuddyRename(workBuddyOriginal.toString('utf8'), paths.launcher); }
      catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        fail('WorkBuddy 的 mcp.json 格式无效，请先修复客户端配置再重试。');
      }
    }
    const runtime = await prepareRuntime(paths.root, source, version, { installDependencies: dependencies.installDependencies || runDependencies, verify: dependencies.verify || verify });
    const require = createRequire(path.join(runtime.directory, 'package.json'));
    const parseToml = dependencies.parseToml || require('smol-toml').parse;
    const launcherContent = await readFile(path.join(source, 'src/launcher.mjs'));
    if (await exists(paths.launcher)) {
      const installedLauncher = await readFile(paths.launcher);
      const normalizeLineEndings = content => content.toString('latin1').replace(/\r\n/g, '\n');
      if (normalizeLineEndings(installedLauncher) !== normalizeLineEndings(launcherContent)) fail('The shared MCP launcher was modified; it will not be overwritten.');
    }
    const skillForOption = { images: 'mubai-product-images', video: 'mubai-product-video', episode: 'bk-video-episode' };
    const selectedSkills = options.skill === 'all' ? ['mubai-product-images', 'mubai-product-video', 'bk-video-episode'] : [skillForOption[options.skill]];
    const skillNames = [...selectedSkills, 'bk'];
    const skillPlans = [];
    for (const skillName of skillNames) {
      const skillDirectory = path.join(paths.skills, skillName);
      const skillPath = path.join(skillDirectory, 'SKILL.md');
      const skillMarker = path.join(skillDirectory, '.mubai-install.json');
      const skillContent = skillForClient(await readFile(path.join(source, 'skills', skillName, 'SKILL.md')), options.client);
      const extraFiles = [];
      for (const relative of skillName === 'bk' ? ['agents/openai.yaml'] : (skillName === 'bk-video-episode' ? ['runtime/package.json', 'runtime/package-lock.json'] : [])) {
        const target = path.join(skillDirectory, relative);
        await safePath(target);
        extraFiles.push({ relative, target, content: await readFile(path.join(source, 'skills', skillName, relative)) });
      }
      if (await exists(skillDirectory)) {
        await safePath(skillPath); await safePath(skillMarker);
        if (!await exists(skillMarker) || !await exists(skillPath)) fail('A Skill with the same name already exists and is not managed by this installer.');
        const marker = await json(skillMarker);
        if (marker.schema !== 1 || marker.skill !== skillName || hash(await readFile(skillPath)) !== marker.sha256) fail('The installed Skill was edited; it will not be overwritten.');
        for (const extra of extraFiles) {
          const recorded = marker.extra_files?.[extra.relative];
          const present = await exists(extra.target);
          // Older installers did not ship episode runtime metadata. Add it only to vacant paths.
          if (present !== (recorded !== undefined) || (present && hash(await readFile(extra.target)) !== recorded)) {
            fail('The installed Skill metadata was edited; it will not be overwritten.');
          }
        }
      }
      const skipped = await exists(skillPath) && (await readFile(skillPath)).equals(skillContent) && (await json(skillMarker)).version === version;
      skillPlans.push({ skillName, skillPath, skillMarker, skillContent, extraFiles, skipped });
    }
    const adapter = HOST_ADAPTERS[options.client];
    await safePath(configuration);
    const original = await exists(configuration) ? await readFile(configuration, 'utf8') : '';
    let updated; let configurationSkipped = false; let effectiveBaseUrl = baseUrl;
    if (adapter.format === 'toml') {
      let parsed; try { parsed = parseToml(original); } catch { fail('Codex TOML is invalid; no configuration was changed.'); }
      const planned = codexAddition(original, parsed, paths.launcher, baseUrl, process.execPath, options.allowHttpLocalhost === true, options.client);
      try { parseToml(planned.text); } catch { fail('Codex configuration cannot safely accept an added table; no configuration was changed.'); }
      updated = planned.text; configurationSkipped = planned.skipped; effectiveBaseUrl = planned.effectiveBaseUrl;
    } else {
      const planned = jsonConfiguration(original, adapter, paths.launcher, baseUrl, process.execPath, options.allowHttpLocalhost === true);
      updated = planned.text; configurationSkipped = planned.skipped; effectiveBaseUrl = planned.effectiveBaseUrl;
    }
    // All user-owned destinations are validated before any Skill/configuration change.
    const currentOriginal = await exists(configuration) ? await readFile(configuration, 'utf8') : '';
    if (currentOriginal !== original) fail('Client configuration changed during installation; retry after reviewing it.');
    const writes = [];
    if (!await exists(paths.launcher)) writes.push({ target: paths.launcher, content: launcherContent });
    for (const plan of skillPlans) if (!plan.skipped) {
      writes.push({ target: plan.skillPath, content: plan.skillContent });
      for (const extra of plan.extraFiles) writes.push({ target: extra.target, content: extra.content });
      writes.push({ target: plan.skillMarker, content: Buffer.from(JSON.stringify({ schema: 1, version, skill: plan.skillName, sha256: hash(plan.skillContent),
        ...(plan.extraFiles.length ? { extra_files: Object.fromEntries(plan.extraFiles.map(extra => [extra.relative, hash(extra.content)])) } : {}) }, null, 2)) });
    }
    if (!configurationSkipped) writes.push({ target: configuration, content: Buffer.from(updated) });
    const installs = priorCurrent?.installs || {};
    const previousSkill = installs[options.client]?.skill;
    const origin = effectiveBaseUrl && effectiveBaseUrl !== 'https://your-website.example' ? effectiveBaseUrl : null;
    const installation = { version, origin, allowHttpLocalhost: options.allowHttpLocalhost === true,
      isolated: !!options.home, skill: previousSkill && previousSkill !== options.skill ? 'all' : options.skill,
      ...(installs[options.client]?.version && installs[options.client].version !== version
        ? { verify_after_update: version }
        : installs[options.client]?.verify_after_update === version ? { verify_after_update: version } : {}) };
    const nextCurrent = { schema: 1, version, installs: { ...installs, [options.client]: installation } };
    if (JSON.stringify(priorCurrent) !== JSON.stringify(nextCurrent)) writes.push({ target: currentPath, content: Buffer.from(JSON.stringify(nextCurrent, null, 2)) });
    if (workBuddyPlan?.text) writes.unshift({ target: workBuddyTarget, content: Buffer.from(workBuddyPlan.text), expected: workBuddyOriginal });
    await commitTransaction(journalPath, writes, allowed, dependencies.beforeCommitWrite, () => (dependencies.verify || verify)(runtime.directory, { launcher: paths.launcher }));
    const baseUrlStatus = !effectiveBaseUrl || effectiveBaseUrl.toLowerCase() === 'https://your-website.example' ? 'requires_local_configuration' : (options.baseUrl && effectiveBaseUrl !== baseUrl ? 'preserved_existing_origin' : 'configured');
    return { version, client: options.client, host_verified: false, manual_import_required: adapter.manualImport === true && !workBuddyPlan, native_capability_required: adapter.nativeCapabilityRequired === true, configuration_status: workBuddyPlan?.status ?? (adapter.manualImport ? 'exported_pending_import' : 'written_restart_required'), skill: options.skill === 'all' ? 'all' : selectedSkills[0], skills: skillNames, skills_directory: paths.skills, home, runtime: runtime.directory, configuration, launcher: paths.launcher,
      runtime_skipped: runtime.skipped, skill_skipped: skillPlans.every(plan => plan.skipped), configuration_preserved: configurationSkipped, base_url_status: baseUrlStatus,
      configuration_notice: baseUrlStatus === 'configured' ? null : 'Existing configuration was preserved; the installer does not replace it. Website authorization can supply a missing or placeholder origin from the OS vault.',
      verification: 'local initialize/tools/list; no credentials or website requests' };
  }, () => { const error = new Error('Another installation is active or its lock owner cannot be verified; review .install.lock locally.'); error.code = 'INSTALL_CONFLICT'; return error; });
}
