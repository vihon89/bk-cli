import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parse } from 'smol-toml';
import { install, installationPaths, normalizeBaseUrl, parseArguments, PACKAGE_FILES } from '../src/installer.mjs';

const source = fileURLToPath(new URL('..', import.meta.url));
const currentVersion = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8')).version;
const parts = currentVersion.split('.').map(Number);
const nextVersion = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
async function nextFixtureSource(f) {
  const nextSource = path.join(f.temporary, 'transaction next source');
  for (const name of PACKAGE_FILES) { const target = path.join(nextSource, name); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, await readFile(path.join(source, name))); }
  const pkg = JSON.parse(await readFile(path.join(nextSource, 'package.json'), 'utf8')); pkg.version = nextVersion;
  await writeFile(path.join(nextSource, 'package.json'), JSON.stringify(pkg));
  await writeFile(path.join(nextSource, 'skills/mubai-product-images/SKILL.md'), '# Transaction upgrade');
  return nextSource;
}

test('every upgrade commit boundary rolls back and can retry without marker corruption', async t => {
  for (let failAt = 0; failAt < 6; failAt++) {
    const f = await fixture(t);
    await install({ client: 'codex', skill: 'images', home: f.home }, f.dependencies);
    const nextSource = await nextFixtureSource(f);
    const oldSkill = await readFile(path.join(f.paths.skills, 'mubai-product-images/SKILL.md'), 'utf8');
    await assert.rejects(install({ client: 'codex', skill: 'images', home: f.home }, { ...f.dependencies, source: nextSource, beforeCommitWrite: async (_target, index) => { if (index === failAt) throw new Error('injected storage failure'); } }), /injected storage failure/);
    assert.equal(await readFile(path.join(f.paths.skills, 'mubai-product-images/SKILL.md'), 'utf8'), oldSkill);
    assert.equal(JSON.parse(await readFile(path.join(f.paths.root, 'current.json'))).version, currentVersion);
    const result = await install({ client: 'codex', skill: 'images', home: f.home }, { ...f.dependencies, source: nextSource });
    assert.equal(result.version, nextVersion);
  }
});

test('killed installer recovers journal and dead lock before validating changed Skill markers', async t => {
  const f = await fixture(t);
  await install({ client: 'codex', skill: 'images', home: f.home }, f.dependencies);
  const nextSource = await nextFixtureSource(f);
  const installerUrl = new URL('../src/installer.mjs', import.meta.url).href;
  const script = `import { install } from ${JSON.stringify(installerUrl)}; import {parse} from 'smol-toml'; await install(${JSON.stringify({ client: 'codex', skill: 'images', home: f.home })}, {source:${JSON.stringify(nextSource)}, parseToml:parse, installDependencies:async()=>{}, verify:async()=>{}, beforeCommitWrite:async(_target,index)=>{if(index===1){process.stdout.write('READY');await new Promise(()=>{setInterval(()=>{},1000)});}}});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: source, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('child did not reach fault boundary')), 10000); child.stdout.on('data', chunk => { if (chunk.toString().includes('READY')) { clearTimeout(timer); resolve(); } }); child.once('error', reject); child.once('exit', code => { if (code !== null) { clearTimeout(timer); reject(new Error('child exited early: ' + code)); } }); });
  const stopped = new Promise(resolve => child.once('close', resolve)); child.kill('SIGKILL'); await stopped;
  const result = await install({ client: 'qwen', skill: 'images', home: f.home }, { ...f.dependencies, source: nextSource });
  assert.equal(result.version, nextVersion);
  assert.equal(await readFile(path.join(f.paths.skills, 'mubai-product-images/SKILL.md'), 'utf8'), '# Transaction upgrade');
  assert.ok(!(await readdir(f.paths.root)).some(name => name.includes('transaction')));
});

test('rollback preserves a user edit made after a partial commit and stops for review', async t => {
  const f = await fixture(t);
  await install({ client: 'codex', skill: 'images', home: f.home }, f.dependencies);
  const nextSource = await nextFixtureSource(f);
  const skill = path.join(f.paths.skills, 'mubai-product-images/SKILL.md');
  await assert.rejects(install({ client: 'codex', skill: 'images', home: f.home }, { ...f.dependencies, source: nextSource, beforeCommitWrite: async (_target, index) => { if (index === 1) { await writeFile(skill, 'USER EDIT KEEP'); throw new Error('fault'); } } }), /user-edited/);
  assert.equal(await readFile(skill, 'utf8'), 'USER EDIT KEEP');
  await assert.rejects(install({ client: 'codex', skill: 'images', home: f.home }, { ...f.dependencies, source: nextSource }), /user-edited/);
});

test('final installed launcher verification failure rolls back committed pointer and Skills', async t => {
  const f = await fixture(t);
  await install({ client: 'codex', skill: 'images', home: f.home }, f.dependencies);
  const nextSource = await nextFixtureSource(f);
  await assert.rejects(install({ client: 'codex', skill: 'images', home: f.home }, { ...f.dependencies, source: nextSource, verify: async (_directory, options) => { if (options?.launcher) throw new Error('installed launcher failed'); } }), /installed launcher failed/);
  assert.equal(JSON.parse(await readFile(path.join(f.paths.root, 'current.json'))).version, currentVersion);
  await install({ client: 'codex', skill: 'images', home: f.home }, { ...f.dependencies, source: nextSource });
});
async function fixture(t) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mubai installer 空格 '));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const home = path.join(temporary, 'isolated home');
  let dependencyRuns = 0;
  const dependencies = { source, parseToml: parse, installDependencies: async () => { dependencyRuns++; }, verify: async () => ({ tools: 10 }) };
  return { temporary, home, dependencies, paths: installationPaths(home), get dependencyRuns() { return dependencyRuns; } };
}

test('Windows and macOS path layouts are deterministic and separate operation state', () => {
  const windows = installationPaths('C:\\Users\\Person Name', 'win32');
  assert.equal(windows.config, 'C:\\Users\\Person Name\\.codex\\config.toml');
  assert.equal(windows.skills, 'C:\\Users\\Person Name\\.agents\\skills');
  assert.equal(windows.launcher, 'C:\\Users\\Person Name\\.mubai-media-mcp\\launch.mjs');
  const mac = installationPaths('/Users/Person Name', 'darwin');
  assert.equal(mac.config, '/Users/Person Name/.codex/config.toml');
  assert.equal(mac.workbuddy, '/Users/Person Name/.mubai-media-mcp/setup-templates/workbuddy-mcp.json');
  assert.throws(() => installationPaths('relative', 'darwin'));
});

test('installer argument and public-origin validation fail before writes', () => {
  assert.deepEqual(parseArguments(['--client', 'codex', '--skill', 'images']), { client: 'codex', skill: 'images' });
  assert.throws(() => parseArguments(['--client', 'codex', '--skill', 'images', '--client', 'workbuddy']));
  assert.throws(() => parseArguments(['--client', 'codex', '--skill', 'images', '--api-key', 'secret']));
  assert.equal(normalizeBaseUrl(), 'https://YOUR-WEBSITE.example');
  assert.equal(normalizeBaseUrl('https://website.example/'), 'https://website.example');
  for (const value of ['http://website.example', 'https://user:key@website.example', 'https://website.example/path', 'https://website.example?key=x', 'https://localhost', 'https://10.1.1.1', 'https://127.1', 'https://[::1]', 'https://private.internal', 'https://site.test', 'https://website.example:18793']) assert.throws(() => normalizeBaseUrl(value), value);
});

test('same-version second Skill reuses runtime and preserves key, other MCP and operation records', async t => {
  const f = await fixture(t);
  await mkdir(path.dirname(f.paths.config), { recursive: true });
  const other = '# Keep comments and formatting\n[mcp_servers.other]\ncommand = "existing"\n';
  await writeFile(f.paths.config, other);
  const first = await install({ client: 'codex', skill: 'images', home: f.home }, f.dependencies);
  assert.equal(first.runtime_skipped, false);
  let configuration = await readFile(f.paths.config, 'utf8');
  assert.ok(configuration.startsWith(other));
  assert.equal(parse(configuration).mcp_servers.mubai_media.args[0], f.paths.launcher);
  configuration += 'MUBAI_API_KEY = "LOCAL_TEST_KEY_KEEP"\n';
  await writeFile(f.paths.config, configuration);
  const state = path.join(f.home, '.mubai-media', 'account', 'operation.json');
  await mkdir(path.dirname(state), { recursive: true }); await writeFile(state, 'KEEP_OPERATION_ID');
  const second = await install({ client: 'codex', skill: 'images', home: f.home, baseUrl: 'https://website.example' }, f.dependencies);
  assert.equal(second.runtime_skipped, true); assert.equal(second.skill_skipped, true);
  assert.equal(second.base_url_status, 'requires_local_configuration');
  assert.match(second.configuration_notice, /does not replace/);
  assert.equal(await readFile(f.paths.config, 'utf8'), configuration);
  const third = await install({ client: 'workbuddy', skill: 'video', home: f.home }, f.dependencies);
  assert.equal(third.runtime_skipped, true); assert.equal(f.dependencyRuns, 1);
  assert.equal(await readFile(state, 'utf8'), 'KEEP_OPERATION_ID');
  const template = JSON.parse(await readFile(f.paths.workbuddy, 'utf8'));
  assert.equal(template.mcpServers.BK.env.MUBAI_API_KEY, undefined);
  template.mcpServers.BK.env.MUBAI_API_KEY = 'LOCAL_TEST_KEY_KEEP';
  template.mcpServers.other = { command: 'other' };
  const privateTemplate = JSON.stringify(template);
  await writeFile(f.paths.workbuddy, privateTemplate);
  await install({ client: 'workbuddy', skill: 'video', home: f.home }, f.dependencies);
  assert.equal(await readFile(f.paths.workbuddy, 'utf8'), privateTemplate);
  template.mcpServers.BK.url = 'https://remote.example/mcp';
  const conflicting = JSON.stringify(template);
  await writeFile(f.paths.workbuddy, conflicting);
  await assert.rejects(install({ client: 'workbuddy', skill: 'video', home: f.home }, f.dependencies), /different BK/);
  assert.equal(await readFile(f.paths.workbuddy, 'utf8'), conflicting);
});

test('owned upgrade changes runtime and Skill while preserving configuration and old runtime', async t => {
  const f = await fixture(t);
  await install({ client: 'codex', skill: 'images', home: f.home }, f.dependencies);
  const before = await readFile(f.paths.config, 'utf8');
  const nextSource = path.join(f.temporary, 'next source');
  for (const name of PACKAGE_FILES) { const target = path.join(nextSource, name); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, await readFile(path.join(source, name))); }
  const pkg = JSON.parse(await readFile(path.join(nextSource, 'package.json'), 'utf8')); pkg.version = nextVersion;
  await writeFile(path.join(nextSource, 'package.json'), JSON.stringify(pkg));
  await writeFile(path.join(nextSource, 'skills/mubai-product-images/SKILL.md'), '# Upgraded fixture Skill');
  const upgraded = await install({ client: 'codex', skill: 'images', home: f.home }, { ...f.dependencies, source: nextSource });
  assert.equal(upgraded.version, nextVersion); assert.equal(upgraded.configuration_preserved, true);
  assert.equal(await readFile(f.paths.config, 'utf8'), before);
  assert.equal(await readFile(path.join(f.paths.skills, 'mubai-product-images/SKILL.md'), 'utf8'), '# Upgraded fixture Skill');
  assert.deepEqual((await readdir(path.join(f.paths.root, 'versions'))).sort(), [currentVersion, nextVersion].sort());
  await assert.rejects(install({ client: 'codex', skill: 'images', home: f.home }, f.dependencies), /downgrade/);
  assert.equal(JSON.parse(await readFile(path.join(f.paths.root, 'current.json'), 'utf8')).version, nextVersion);
});

test('WorkBuddy upgrades an imported legacy entry in the normal profile and retains authorization and settings', async t => {
  const f = await fixture(t);
  const home = path.join(f.home, '.mubai-home');
  const paths = installationPaths(home);
  const options = { client: 'workbuddy', skill: 'all', home, baseUrl: 'https://website.example' };
  const dependencies = { ...f.dependencies, defaultHome: f.home };
  const initial = await install(options, dependencies);
  assert.equal(initial.manual_import_required, true);
  const config = path.join(f.home, '.workbuddy', 'mcp.json');
  const trust = path.join(f.home, '.workbuddy', 'connector-states.v3.json');
  const vault = path.join(paths.root, 'auth', 'clients', 'workbuddy', 'fixture.vault');
  await mkdir(path.dirname(config), { recursive: true });
  await mkdir(path.dirname(vault), { recursive: true });
  await writeFile(trust, 'existing trust state');
  await writeFile(vault, 'existing authorization');
  const legacy = { command: 'node', type: 'stdio', args: [paths.launcher], env: { MUBAI_BASE_URL: options.baseUrl, MUBAI_CLIENT_ID: 'workbuddy', MUBAI_STATE_DIR: 'user-owned' } };
  const other = { type: 'sse', url: 'https://other.example/mcp' };
  const original = { customSetting: true, mcpServers: { mubai_media: legacy, other } };
  await writeFile(config, JSON.stringify(original));
  const nextSource = await nextFixtureSource(f);
  const upgraded = await install(options, { ...dependencies, source: nextSource });
  assert.equal(upgraded.configuration_status, 'workbuddy_renamed');
  assert.equal(upgraded.manual_import_required, false);
  const migrated = await readFile(config, 'utf8');
  assert.deepEqual(JSON.parse(migrated), { customSetting: true, mcpServers: { BK: legacy, other } });
  assert.equal(await readFile(vault, 'utf8'), 'existing authorization');
  assert.equal(await readFile(trust, 'utf8'), 'existing trust state');
  const repeated = await install(options, { ...dependencies, source: nextSource });
  assert.equal(repeated.configuration_status, 'workbuddy_registered');
  assert.equal(await readFile(config, 'utf8'), migrated);
});

test('WorkBuddy automatic rename detects conflicts, keeps unrelated entries, and rolls back with the installer', async t => {
  const f = await fixture(t);
  const options = { client: 'workbuddy', skill: 'images', home: f.home };
  await install(options, f.dependencies);
  const target = path.join(f.home, '.workbuddy', 'mcp.json');
  await mkdir(path.dirname(target), { recursive: true });
  const legacy = { command: 'node', args: [f.paths.launcher] };
  const conflict = JSON.stringify({ mcpServers: { mubai_media: legacy, BK: { url: 'https://other.example/mcp' } } });
  await writeFile(target, conflict);
  const nextSource = await nextFixtureSource(f);
  const dependencies = { ...f.dependencies, source: nextSource };
  await assert.rejects(install(options, dependencies), { code: 'WORKBUDDY_CONNECTOR_CONFLICT' });
  assert.equal(await readFile(target, 'utf8'), conflict);
  const original = JSON.stringify({ mcpServers: { mubai_media: legacy } });
  await writeFile(target, original);
  const changed = JSON.stringify({ mcpServers: { mubai_media: legacy }, externalEdit: true });
  await assert.rejects(install(options, { ...dependencies, beforeCommitWrite: targetFile => targetFile === target ? writeFile(target, changed) : undefined }), /配置在升级期间已更改/);
  assert.equal(await readFile(target, 'utf8'), changed);
  await writeFile(target, original);
  await assert.rejects(install(options, { ...dependencies, verify: async (_dir, settings) => {
    if (settings?.launcher) throw new Error('verification failure');
  } }), /verification failure/);
  assert.equal(await readFile(target, 'utf8'), original);
  assert.equal(JSON.parse(await readFile(path.join(f.paths.root, 'current.json'))).version, currentVersion);
  const unrelated = JSON.stringify({ mcpServers: { mubai_media: { ...legacy, args: [path.join(f.temporary, 'unrelated.mjs')] } } });
  await writeFile(target, unrelated);
  assert.equal((await install(options, dependencies)).manual_import_required, true);
  assert.equal(await readFile(target, 'utf8'), unrelated);
});

test('conflicting config or user-edited Skill is preserved and never replaced', async t => {
  const f = await fixture(t);
  await mkdir(path.dirname(f.paths.config), { recursive: true });
  const conflicting = '[mcp_servers."mubai_media"]\ncommand = "other-owner"\n';
  await writeFile(f.paths.config, conflicting);
  await assert.rejects(install({ client: 'codex', skill: 'images', home: f.home }, f.dependencies), /different mubai_media/);
  assert.equal(await readFile(f.paths.config, 'utf8'), conflicting);
  await writeFile(f.paths.config, '');
  await install({ client: 'codex', skill: 'images', home: f.home }, f.dependencies);
  const skill = path.join(f.paths.skills, 'mubai-product-images/SKILL.md');
  await writeFile(skill, 'USER_EDIT_KEEP');
  await assert.rejects(install({ client: 'codex', skill: 'images', home: f.home }, f.dependencies), /Skill was edited/);
  assert.equal(await readFile(skill, 'utf8'), 'USER_EDIT_KEEP');
});

test('explicit --home isolates CODEX_HOME; default install honors its absolute custom location', async t => {
  const f = await fixture(t);
  const custom = path.join(f.temporary, 'custom codex');
  const dependencies = { ...f.dependencies, env: { CODEX_HOME: custom }, defaultHome: f.home };
  await install({ client: 'codex', skill: 'images', home: f.home }, dependencies);
  await assert.rejects(readFile(path.join(custom, 'config.toml')), { code: 'ENOENT' });
  const result = await install({ client: 'codex', skill: 'images' }, dependencies);
  assert.equal(result.configuration, path.join(custom, 'config.toml'));
  assert.equal(parse(await readFile(result.configuration, 'utf8')).mcp_servers.mubai_media.args[0], f.paths.launcher);
});

test('runtime directory junctions cannot redirect installation writes outside home', async t => {
  const f = await fixture(t);
  const outside = path.join(f.temporary, 'outside'); await mkdir(outside);
  await mkdir(f.paths.root, { recursive: true });
  const versions = path.join(f.paths.root, 'versions');
  try { await symlink(outside, versions, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (error.code === 'EPERM') return t.skip('symlink creation unavailable'); throw error; }
  await assert.rejects(install({ client: 'codex', skill: 'images', home: f.home }, f.dependencies), /symlink or junction/);
  assert.deepEqual(await readdir(outside), []);
  await rm(versions); await mkdir(versions);
  await symlink(outside, path.join(versions, currentVersion), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(install({ client: 'codex', skill: 'images', home: f.home }, f.dependencies), /symlink or junction/);
  assert.deepEqual(await readdir(outside), []);
});


test('both clients install one BK brand skill and preserve edited metadata without config writes', async t => {
  for (const client of ['codex', 'workbuddy']) {
    const f = await fixture(t);
    const first = await install({client, skill:'images', home:f.home}, f.dependencies);
    assert.deepEqual(first.skills, ['mubai-product-images', 'bk']);
    assert.equal(first.skill, 'mubai-product-images');
    const brandPath = path.join(f.paths.skills,'bk/SKILL.md');
    const metaPath = path.join(f.paths.skills,'bk/agents/openai.yaml');
    assert.equal(await readFile(brandPath,'utf8'),await readFile(path.join(source,'skills/bk/SKILL.md'),'utf8'));
    assert.equal(await readFile(metaPath,'utf8'),await readFile(path.join(source,'skills/bk/agents/openai.yaml'),'utf8'));
    const second = await install({client, skill:'video', home:f.home}, f.dependencies);
    assert.deepEqual(second.skills, ['mubai-product-video','bk']);
    assert.equal(second.configuration_preserved,true);
    const config = await readFile(first.configuration,'utf8');
    await writeFile(metaPath,'interface:\n  display_name: "MY OWN BK"\n');
    await assert.rejects(install({client,skill:'all',home:f.home},f.dependencies), /metadata was edited/);
    assert.equal(await readFile(metaPath,'utf8'),'interface:\n  display_name: "MY OWN BK"\n');
    assert.equal(await readFile(first.configuration,'utf8'),config);
  }
});
