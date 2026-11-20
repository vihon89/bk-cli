import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, mkdir, writeFile, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';
import { HOST_ADAPTERS, CLIENT_IDS, adapterPath, adapterSkillsPath, jsonConfiguration } from '../src/host-adapters.mjs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fixture as mediaFixture } from './helpers.mjs';
import { install, parseArguments } from '../src/installer.mjs';
import { bootstrapArguments } from '../bootstrap.mjs';
import { authArguments, runAuth } from '../src/device-auth.mjs';

test('all registered clients pass installation/bootstrap/auth parsing, unknown clients fail', () => {
  for (const client of CLIENT_IDS) {
    assert.equal(parseArguments(['--client', client, '--skill', 'all']).client, client);
    assert.equal(bootstrapArguments(['--client', client], {}).client, client);
    assert.equal(authArguments(['--client', client]).client, client);
  }
  for (const parseArgs of [a => parseArguments([...a, '--skill', 'all']), a => bootstrapArguments(a, {}), authArguments]) assert.throws(() => parseArgs(['--client', 'unknown-host']));
});

test('adapters preserve unrelated configuration, reject same-name conflicts, and generic only exports', async t => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'BK hosts 空格 '));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  for (const client of CLIENT_IDS) {
    if (client === 'deepseek-harness') continue;
    const home = path.join(temporary, client);
    const config = adapterPath(home, client);
    const adapter = HOST_ADAPTERS[client];
    await mkdir(path.dirname(config), { recursive: true });
    const original = adapter.format === 'toml' ? '# user comment\n[user]\nkeep = true\n' : JSON.stringify({ user: { keep: true } });
    await writeFile(config, original);
    const dependencies = { parseToml: parse, installDependencies: async () => {}, verify: async () => ({ tools: 10 }) };
    const result = await install({ client, home, skill: 'images', baseUrl: 'https://website.example' }, dependencies);
    const text = await readFile(config, 'utf8');
    const parsed = adapter.format === 'toml' ? parse(text) : JSON.parse(text);
    assert.equal(parsed.user.keep, true);
    assert.equal(result.host_verified, false);
    assert.equal(result.manual_import_required, !!adapter.manualImport);
    let table = parsed;
    for (const part of adapter.table) table = table[part];
    const name = adapter.connectorName || 'mubai_media';
    assert.equal(table[name].command, process.execPath);
    if (client === 'openclaw') { assert.equal(table.mubai_media.transport, 'stdio'); assert.equal(table.mubai_media.type, undefined); }
    if (['zcode', 'qwen'].includes(client)) assert.equal(table.mubai_media.type, undefined);
    assert.equal(table[name].env.MUBAI_API_KEY, undefined);
    assert.equal(table[name].env.MUBAI_CLIENT_ID, client);
    const again = await install({ client, home, skill: 'images' }, dependencies);
    assert.equal(again.configuration_preserved, true);
    assert.equal(await readFile(config, 'utf8'), text);
    if (client === 'generic') assert.deepEqual(await readdir(home), ['.agents', '.mubai-media-mcp']);
    if (adapter.format === 'json') {
      table[name].command = 'user-owned';
      const conflict = JSON.stringify(parsed);
      await writeFile(config, conflict);
      await assert.rejects(install({ client, home, skill: 'images' }, dependencies), new RegExp(`different ${name}`));
      assert.equal(await readFile(config, 'utf8'), conflict);
    }
  }
});

test('DeepSeek Harness exports a dedicated template and refuses to overwrite a different template', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'BK deepseek '));
  t.after(() => rm(home, { recursive: true, force: true }));
  const options = { client: 'deepseek-harness', home, skill: 'images', baseUrl: 'https://website.example' };
  const dependencies = { parseToml: parse, installDependencies: async () => {}, verify: async () => ({ tools: 18 }) };
  const result = await install(options, dependencies);
  const original = await readFile(result.configuration, 'utf8');
  const template = JSON.parse(original);
  assert.equal(result.manual_import_required, true);
  assert.equal(template.id, 'mcp-bk');
  assert.equal(template.config.command, process.execPath);
  assert.deepEqual(template.config.env, { MUBAI_BASE_URL: options.baseUrl, MUBAI_CLIENT_ID: options.client });
  assert.equal((await install(options, dependencies)).configuration_preserved, true);
  template.config.command = 'user-owned';
  const conflict = JSON.stringify(template);
  await writeFile(result.configuration, conflict);
  await assert.rejects(install(options, dependencies), /template differs/);
  assert.equal(await readFile(result.configuration, 'utf8'), conflict);
});

test('WorkBuddy upgrades a managed legacy template to BK and preserves other entries', () => {
  const adapter = HOST_ADAPTERS.workbuddy;
  const launcher = path.resolve('managed/launch.mjs');
  const legacy = { type: 'stdio', command: process.execPath, args: [launcher], env: {
    MUBAI_BASE_URL: 'https://existing.example', MUBAI_CLIENT_ID: 'workbuddy',
  } };
  const other = { command: 'user-owned' };
  const source = { mcpServers: { mubai_media: legacy, other } };
  const plan = original => jsonConfiguration(JSON.stringify(original), adapter, launcher, 'https://website.example', process.execPath);
  const migrated = plan(source);
  assert.equal(migrated.effectiveBaseUrl, legacy.env.MUBAI_BASE_URL);
  assert.deepEqual(JSON.parse(migrated.text), { mcpServers: { BK: legacy, other } });
  assert.throws(() => plan({ mcpServers: { ...source.mcpServers, BK: other } }), /both BK and the legacy connector/);
  assert.throws(() => plan({ mcpServers: { mubai_media: other } }), /different mubai_media/);
});

test('environment key prevents misleading website login and status reports effective source without exposing key', async () => {
  const env = { MUBAI_API_KEY: 'LOCAL_TEST_ONLY' };
  await assert.rejects(runAuth('login', { client: 'codex' }, { env }), { code: 'ENVIRONMENT_KEY_OVERRIDE' });
  const status = await runAuth('status', {}, { env });
  assert.equal(status.credential_source, 'environment');
  assert.equal(status.connected, false);
  assert.ok(!JSON.stringify(status).includes(env.MUBAI_API_KEY));
  const logout = await runAuth('logout', {}, { env, store: { connection: async () => null } });
  assert.equal(logout.credential_source, 'environment');
  assert.equal(logout.local_profile_removed, false);
});

test('OpenClaw accepts existing native transport and rejects a conflicting transport', () => {
  const adapter = HOST_ADAPTERS.openclaw; const launcher = '/managed/launch.mjs';
  const document = { mcp: { servers: { mubai_media: { command: process.execPath, args: [launcher], transport: 'stdio', env: { MUBAI_BASE_URL: 'https://website.example', MUBAI_CLIENT_ID: 'openclaw' } } } } };
  assert.equal(jsonConfiguration(JSON.stringify(document), adapter, launcher, 'https://website.example', process.execPath).skipped, true);
  document.mcp.servers.mubai_media.transport = 'sse';
  assert.throws(() => jsonConfiguration(JSON.stringify(document), adapter, launcher, 'https://website.example', process.execPath), /different mubai_media/);
});

test('legacy OpenClaw profile is untouched; skills use native directory and managed CLI fallback is hash protected', async t => {
  const media = await mediaFixture(t);
  const home = await mkdtemp(path.join(tmpdir(), 'BK old OpenClaw ')); t.after(() => rm(home, { recursive: true, force: true }));
  const oldProfile = path.join(home, '.openclaw', 'openclaw.json'); await mkdir(path.dirname(oldProfile), { recursive: true });
  const legacy = '{\n  "legacyProfile": "KEEP EXACT BYTES", "version": "2026.3.14"\n}\n'; await writeFile(oldProfile, legacy);
  const dependencies = { parseToml: parse, installDependencies: async directory => { await symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), path.join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir'); } };
  const result = await install({ client: 'openclaw', home, skill: 'all' }, dependencies);
  assert.equal(await readFile(oldProfile, 'utf8'), legacy);
  assert.equal(result.manual_import_required, true); assert.equal(result.native_capability_required, true);
  assert.equal(result.skills_directory, path.join(home, '.openclaw', 'skills'));
  assert.equal(result.configuration, path.join(home, '.mubai-media-mcp', 'setup-templates', 'openclaw-mcp.json'));
  await assert.rejects(readFile(path.join(home, '.agents', 'skills', 'bk', 'SKILL.md')), { code: 'ENOENT' });
  for (const name of ['bk', 'mubai-product-images', 'mubai-product-video']) {
    const skill = await readFile(path.join(adapterSkillsPath(home, 'openclaw'), name, 'SKILL.md'));
    const marker = JSON.parse(await readFile(path.join(result.skills_directory, name, '.mubai-install.json')));
    assert.equal(marker.sha256, createHash('sha256').update(skill).digest('hex'));
    for (const contract of ['current.json', '.mubai-runtime.json', 'src/cli.mjs', '--input -', 'create_batch', 'operation_id', 'batch_id', 'MUBAI_CLIENT_ID=openclaw']) assert.ok(skill.toString().includes(contract), contract);
    assert.match(skill.toString(), /^---\r?\nname:/);
  }
  const current = JSON.parse(await readFile(path.join(home, '.mubai-media-mcp', 'current.json')));
  const runtime = path.join(home, '.mubai-media-mcp', 'versions', current.version);
  const runtimeMarker = JSON.parse(await readFile(path.join(runtime, '.mubai-runtime.json')));
  assert.equal(runtimeMarker.files['src/cli.mjs'], createHash('sha256').update(await readFile(path.join(runtime, 'src/cli.mjs'))).digest('hex'));
  const cli = path.join(runtime, 'src/cli.mjs');
  const cliOptions = { env: { ...media.env, MUBAI_CLIENT_ID: 'openclaw' }, timeout: 20000, windowsHide: true };
  const account = await promisify(execFile)(process.execPath, [cli, 'get_account'], cliOptions);
  assert.equal(JSON.parse(account.stdout).data.account_id, 7);
  const models = await promisify(execFile)(process.execPath, [cli, 'list_models'], cliOptions);
  assert.equal(JSON.parse(models.stdout).data.models.length, 2);
  await install({ client: 'openclaw', home, skill: 'all' }, dependencies);
  const brand = path.join(result.skills_directory, 'bk', 'SKILL.md'); await writeFile(brand, 'USER EDIT KEEP');
  await assert.rejects(install({ client: 'openclaw', home, skill: 'all' }, dependencies), /Skill was edited/);
  assert.equal(await readFile(oldProfile, 'utf8'), legacy);
});
