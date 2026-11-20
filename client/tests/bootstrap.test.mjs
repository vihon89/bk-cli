import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ALLOWED_FILES, crc32, verifiedZip, checkedManifest, bootstrap, bootstrapArguments, bootstrapOrigin } from '../bootstrap.mjs';
import { PACKAGE_FILES } from '../src/installer.mjs';

const source = fileURLToPath(new URL('..', import.meta.url));
async function archiveFixture({ stored = false } = {}) {
  const files = [];
  for (const name of ALLOWED_FILES) files.push({ name, content: await readFile(path.join(source, name.slice('mubai-media-mcp/'.length))) });
  const locals = []; const centrals = []; let offset = 0; const positions = [];
  for (const file of files) {
    const name = Buffer.from(file.name); const data = stored ? file.content : deflateRawSync(file.content);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt32LE(crc32(file.content), 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(file.content.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt32LE(crc32(file.content), 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(file.content.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0o100644 * 65536, 38); central.writeUInt32LE(offset, 42);
    positions.push({ local: offset, centralRelative: centrals.reduce((sum, part) => sum + part.length, 0) });
    locals.push(local, name, data); centrals.push(central, name); offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centrals); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  const bytes = Buffer.concat([...locals, directory, end]);
  const pkg = JSON.parse(files.find(file => file.name.endsWith('/package.json')).content);
  const manifest = buffer => ({ version: pkg.version, filename: `mubai-media-mcp-${pkg.version}.zip`, bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex'), requires_node: '>=20', transport: 'stdio', files: ALLOWED_FILES, download_url: '/api/agent-access/download' });
  return { bytes, manifest, positions: positions.map(position => ({ local: position.local, central: offset + position.centralRelative })) };
}

test('bootstrap and installer include the WorkBuddy model adapter in the verified package', async () => {
  assert.deepEqual([...ALLOWED_FILES].sort(), PACKAGE_FILES.map(name => 'mubai-media-mcp/' + name).sort());
  assert.ok(PACKAGE_FILES.includes('src/workbuddy-models.mjs'));
  for (const stored of [true, false]) { const f = await archiveFixture({ stored }); const release = checkedManifest({ data: f.manifest(f.bytes) }); assert.equal(verifiedZip(f.bytes, release).length, PACKAGE_FILES.length); }
});

test('ZIP validation rejects traversal, links, descriptor/encryption flags, CRC and expansion attacks before writes', async () => {
  const f = await archiveFixture();
  const cases = [
    bytes => { bytes[f.positions[0].local + 30] = '.'.charCodeAt(0); },
    bytes => { bytes.writeUInt32LE(0o120777 * 65536, f.positions[0].central + 38); },
    bytes => { bytes.writeUInt16LE(8, f.positions[0].central + 8); },
    bytes => { bytes.writeUInt16LE(1, f.positions[0].central + 8); },
    bytes => { bytes.writeUInt32LE(0, f.positions[0].central + 16); bytes.writeUInt32LE(0, f.positions[0].local + 14); },
    bytes => { bytes.writeUInt32LE(0x7fffffff, f.positions[0].central + 24); bytes.writeUInt32LE(0x7fffffff, f.positions[0].local + 22); },
    bytes => { bytes.writeUInt32LE(0, f.positions[1].central + 42); },
    bytes => { bytes.writeUInt32LE(0xffffffff, f.positions[0].central + 42); },
  ];
  for (const mutate of cases) { const bytes = Buffer.from(f.bytes); mutate(bytes); assert.throws(() => verifiedZip(bytes, f.manifest(bytes))); }
  const altered = Buffer.from(f.bytes); altered[70] ^= 1; assert.throws(() => verifiedZip(altered, f.manifest(f.bytes)), /SHA-256/);
  assert.throws(() => checkedManifest({ data: { ...f.manifest(f.bytes), files: [...ALLOWED_FILES.slice(1), 'mubai-media-mcp/.env'] } }));
});

test('bootstrap installs verified files, supports all Skills and opens login using the same trusted origin', async () => {
  const f = await archiveFixture(); const invoked = [];
  const result = await bootstrap({ origin: 'https://website.example', skill: 'all', allowHttpLocalhost: false }, ['--client', 'workbuddy', '--home', path.resolve('isolated bootstrap home'), '--no-browser'], {
    env: {}, fetchBytes: async (_origin, route) => route.endsWith('distribution') ? Buffer.from(JSON.stringify({ data: f.manifest(f.bytes) })) : f.bytes,
    runInstall: async (command, args) => {
      assert.equal(command, process.execPath); assert.equal((await readFile(args[0], 'utf8')).includes('parseArguments'), true); invoked.push(args);
      return { stdout: JSON.stringify({ runtime: path.resolve('isolated bootstrap home/.mubai-media-mcp/versions/0.4.1'), configuration_status: 'workbuddy_renamed' }) };
    },
    runLogin: async (_command, args, options) => { assert.equal(options.env.MUBAI_CLIENT_ID, 'workbuddy'); invoked.push(args); }
  });
  assert.equal(result.login_requested, true); assert.equal(invoked[0][invoked[0].indexOf('--skill') + 1], 'all');
  assert.equal(result.configuration_status, 'workbuddy_renamed');
  assert.ok(invoked[1].includes('--no-browser')); assert.equal(invoked[1][invoked[1].indexOf('--base-url') + 1], 'https://website.example');
});

test('bootstrap does not guess WorkBuddy or accept unknown website arguments; loopback requires an explicit local-port policy', () => {
  assert.throws(() => bootstrapArguments([], { skill: 'all' }, {}), /--client/);
  assert.equal(bootstrapArguments([], { skill: 'all' }, { CODEX_THREAD_ID: 'fixture' }).client, 'codex');
  assert.throws(() => bootstrapArguments(['--client', 'codex', '--base-url', 'https://evil.example'], { skill: 'all' }, {}));
  assert.equal(bootstrapOrigin({ origin: 'http://localhost:10040', allowHttpLocalhost: true }), 'http://localhost:10040');
  assert.throws(() => bootstrapOrigin({ origin: 'http://localhost:10040', allowHttpLocalhost: false }));
  assert.equal(bootstrapOrigin({ origin: 'http://127.0.0.1:18342', allowHttpLocalhost: true }), 'http://127.0.0.1:18342');
  assert.throws(() => bootstrapOrigin({ origin: 'http://127.0.0.1:1023', allowHttpLocalhost: true }));
  assert.throws(() => bootstrapOrigin({ origin: 'http://localhost:18793', allowHttpLocalhost: false }));
});

test('a confirmed release cannot be silently substituted by a newer package', async () => {
  const f = await archiveFixture();
  const requests = [];
  await assert.rejects(bootstrap({ origin: 'https://website.example' }, ['--client', 'workbuddy', '--no-login'], {
    expectedVersion: '1.2.3',
    fetchBytes: async (_origin, route) => {
      requests.push(route);
      return Buffer.from(JSON.stringify({ data: f.manifest(f.bytes) }));
    },
  }), /发布版本已变化/);
  assert.deepEqual(requests, ['/api/agent-access/distribution']);
});
