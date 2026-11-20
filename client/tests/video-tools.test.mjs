import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { install, parseArguments, PACKAGE_FILES } from '../src/installer.mjs';
import { MediaClient, MediaError } from '../src/client.mjs';
import { AccountOperationStore } from '../src/operation-store.mjs';
import { MediaService } from '../src/service.mjs';
import { detectVideoEnvironment, evaluateReadiness, prepareVideoUpload } from '../src/video-env.mjs';
import { createHash } from 'node:crypto';

test('package manifest ships the episode skill and both video tools', async () => {
  assert.ok(PACKAGE_FILES.includes('skills/bk-video-episode/SKILL.md'));
  assert.ok(PACKAGE_FILES.includes('src/video-env.mjs'));
  const source = fileURLToPath(new URL('..', import.meta.url));
  const skill = await readFile(path.join(source, 'skills', 'bk-video-episode', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\r?\nname: bk-video-episode\r?\n/);
  assert.match(skill, /check_video_env/);
  assert.match(skill, /upload_video/);
  assert.match(skill, /fred-remotion-output/);
});

test('installer accepts the episode skill and installs its Skill file', async t => {
  assert.deepEqual(parseArguments(['--client', 'codex', '--skill', 'episode']), { client: 'codex', skill: 'episode' });
  const temporary = await mkdtemp(path.join(tmpdir(), 'mubai episode install '));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const { parse } = await import('smol-toml');
  const home = path.join(temporary, 'home');
  const result = await install({ client: 'codex', skill: 'episode', home }, {
    parseToml: parse, installDependencies: async () => {}, verify: async () => ({ tools: 12 }),
  });
  assert.equal(result.version, JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version);
  const installed = await readFile(path.join(home, '.agents', 'skills', 'bk-video-episode', 'SKILL.md'), 'utf8');
  assert.match(installed, /name: bk-video-episode/);
  const marker = JSON.parse(await readFile(path.join(home, '.agents', 'skills', 'bk-video-episode', '.mubai-install.json'), 'utf8'));
  assert.equal(marker.skill, 'bk-video-episode');
  assert.match(marker.sha256, /^[a-f0-9]{64}$/);
});

function uploadFixture(fileSha256) {
  const observed = { assets: 0, uploads: [], statusQueries: 0, keys: new Map(), failFirstAsset: false, serverKnowsOperation: false };
  const server = http.createServer(async (req, res) => {
    if (!['Bearer test-only-key'].includes(req.headers.authorization)) {
      res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'invalid_api_key' } })); return;
    }
    const route = req.url.replace('/openapi/agent/v1', '');
    // Several tests intentionally destroy the next upload socket. A fresh connection
    // keeps those failures separate from fetch's reuse of a closing fixture socket.
    const send = (data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' }); res.end(JSON.stringify(status >= 400 ? data : { data })); };
    if (route === '/account') return send({ account_id: 7, api_app_id: 11, balance_score: 500, scopes: ['account:read', 'models:read', 'assets:write', 'tasks:read'], limits: { max_score: 100, daily_score: 500 } });
    if (route === '/assets' && req.method === 'POST') {
      observed.assets++;
      let body = ''; for await (const chunk of req) body += chunk;
      const idempotency = body.match(/name="idempotency_key"\r\n\r\n([^\r\n]+)/)?.[1];
      observed.uploads.push({ idempotency, bytes: body.length });
      if (observed.failFirstAsset && observed.assets === 1) { req.socket.destroy(); return; }
      const operationId = body.match(/name="operation_id"\r\n\r\n([^\r\n]+)/)?.[1];
      if (observed.postResult) return send(observed.postResult(operationId));
      const key = idempotency;
      if (!observed.keys.has(key)) observed.keys.set(key, { asset_id: `asset_${observed.keys.size + 1}` });
      const asset = observed.keys.get(key);
      return send({ asset_id: asset.asset_id, attachment_id: 123, url: 'https://cdn.example.test/agent-media/x.mp4', type: 'video',
        mime: 'video/mp4', size_bytes: 65536, width: 1920, height: 1080, duration_seconds: 60.5, sha256: fileSha256, operation_id: operationId });
    }
    const statusMatch = route.match(/^\/uploads\/([A-Za-z0-9_.-]+)$/);
    if (statusMatch) {
      observed.statusQueries++;
      if (observed.getResult) {
        const { data, status } = observed.getResult(statusMatch[1]);
        return send(data, status);
      }
      if (!observed.serverKnowsOperation) return send({ error: { code: 'UPLOAD_NOT_FOUND' } }, 404);
      return send({ operation_id: statusMatch[1], status: 'completed', asset: { asset_id: 'asset_recovered', attachment_id: 123, url: 'https://cdn.example.test/agent-media/y.mp4', type: 'video', mime: 'video/mp4', size_bytes: 65536, sha256: fileSha256 } });
    }
    return send({ error: { code: 'not_found' } }, 404);
  });
  return { server, observed };
}

async function serviceFixture(t, { failFirstAsset = false, serverKnowsOperation = false } = {}) {
  const episodeBuffer = Buffer.alloc(65536);
  episodeBuffer.writeUInt32BE(65536, 0); episodeBuffer.write('ftyp', 4, 'ascii');
  const fileSha256 = createHash('sha256').update(episodeBuffer).digest('hex');
  const { server, observed } = uploadFixture(fileSha256);
  observed.failFirstAsset = failFirstAsset;
  observed.serverKnowsOperation = serverKnowsOperation;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const temp = await mkdtemp(path.join(tmpdir(), 'mubai video op '));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const env = { ...process.env, MUBAI_BASE_URL: `http://127.0.0.1:${server.address().port}`, MUBAI_ALLOW_HTTP_LOCALHOST: '1', MUBAI_API_KEY: 'test-only-key', MUBAI_STATE_DIR: temp };
  const client = new MediaClient({ baseUrl: env.MUBAI_BASE_URL, apiKey: 'test-only-key', apiSecret: '', stateDir: temp, assetRoot: temp });
  // Keep the real boundary/size/container validation; only the ffprobe call is stubbed so tests stay hermetic.
  const file = path.join(temp, 'episode.mp4');
  await writeFile(file, episodeBuffer);
  const fakeProbe = async () => ({ width: 1920, height: 1080, duration_seconds: 60.5, video_codec: 'h264', audio_codec: 'aac' });
  client.prepareVideoUpload = async filePath => prepareVideoUpload(filePath, { assetRoot: temp, probeImpl: fakeProbe });
  const service = new MediaService(client, new AccountOperationStore(client, { stateDir: temp }));
  return { service, observed, file, temp, fakeProbe };
}

test('upload_video succeeds, replays with the same operation, and rejects changed content', async t => {
  const { service, observed, file } = await serviceFixture(t);
  const first = await service.uploadVideo({ operation_id: 'ep-upload-0001', file_path: file, description: '整期验收样片 v1' });
  assert.equal(first.replay, false);
  assert.equal(first.asset_id, 'asset_1');
  assert.equal(first.attachment_id, 123);
  const replay = await service.uploadVideo({ operation_id: 'ep-upload-0001', file_path: file, description: '整期验收样片 v1' });
  assert.equal(replay.replay, true);
  assert.equal(replay.asset_id, 'asset_1');
  assert.equal(observed.assets, 1);
  const otherFile = path.join(path.dirname(file), 'other.mp4');
  const otherBuffer = Buffer.alloc(65536);
  otherBuffer.writeUInt32BE(65536, 0); otherBuffer.write('ftyp', 4, 'ascii');
  otherBuffer.write('diff', 16, 'ascii');
  await writeFile(otherFile, otherBuffer);
  // Same operation, different file content → conflict.
  await assert.rejects(service.uploadVideo({ operation_id: 'ep-upload-0001', file_path: otherFile }), error => error instanceof MediaError && error.code === 'OPERATION_CONFLICT');
  // Same file but a changed description binding → conflict as well.
  await assert.rejects(service.uploadVideo({ operation_id: 'ep-upload-0001', file_path: file, description: 'v2 说明' }), error => error instanceof MediaError && error.code === 'OPERATION_CONFLICT');
  assert.equal(observed.assets, 1);
  // A new operation pointing outside the allowed asset root is rejected locally.
  const outside = await mkdtemp(path.join(tmpdir(), 'mubai video outside '));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const outsideFile = path.join(outside, 'outside.mp4');
  await writeFile(outsideFile, Buffer.from('outside root content'));
  await assert.rejects(service.uploadVideo({ operation_id: 'ep-upload-0002', file_path: outsideFile }), error => error instanceof MediaError && error.code === 'FILE_OUTSIDE_ROOT');
  assert.equal(observed.assets, 1);
});

test('upload_video recovers a lost response through the server status record', async t => {
  const { service, observed, file } = await serviceFixture(t, { failFirstAsset: true, serverKnowsOperation: true });
  await assert.rejects(service.uploadVideo({ operation_id: 'ep-upload-0003', file_path: file }), /请求未获得可靠响应|网络|RESPONSE/);
  assert.equal(observed.assets, 1);
  const recovered = await service.uploadVideo({ operation_id: 'ep-upload-0003', file_path: file });
  assert.equal(recovered.replay, true);
  assert.equal(recovered.asset_id, 'asset_recovered');
  assert.equal(observed.assets, 1);
});

test('upload_video retries with the original idempotency key when the server never saw the upload', async t => {
  const { service, observed, file } = await serviceFixture(t, { failFirstAsset: true, serverKnowsOperation: false });
  await assert.rejects(service.uploadVideo({ operation_id: 'ep-upload-0004', file_path: file }), /请求未获得可靠响应|网络|RESPONSE/);
  const result = await service.uploadVideo({ operation_id: 'ep-upload-0004', file_path: file });
  assert.equal(result.replay, false);
  assert.equal(observed.assets, 2);
  assert.equal(observed.uploads[0].idempotency, observed.uploads[1].idempotency);
  assert.notEqual(observed.uploads[0].idempotency, undefined);
});

function fakeProbe(overrides = {}) {
  return async () => ({ width: 1920, height: 1080, duration_seconds: 60, video_codec: 'h264', audio_codec: 'aac', ...overrides });
}

test('prepareVideoUpload validates extension, container magic, boundaries and size limits', async t => {
  const temp = await mkdtemp(path.join(tmpdir(), 'mubai video prep '));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const valid = path.join(temp, 'a.mp4');
  const header = Buffer.alloc(64);
  header.writeUInt32BE(64, 0); header.write('ftyp', 4, 'ascii');
  await writeFile(valid, header);
  const prepared = await prepareVideoUpload(valid, { probeImpl: fakeProbe() });
  assert.equal(prepared.fileName, 'a.mp4');
  assert.equal(prepared.probe.height, 1080);
  assert.match(prepared.sha256, /^[a-f0-9]{64}$/);
  const wrongExt = path.join(temp, 'b.mov');
  await writeFile(wrongExt, header);
  await assert.rejects(prepareVideoUpload(wrongExt, { probeImpl: fakeProbe() }), { code: 'INVALID_FILE' });
  const notMp4 = path.join(temp, 'c.mp4');
  await writeFile(notMp4, Buffer.from('RIFF....WEBP'));
  await assert.rejects(prepareVideoUpload(notMp4, { probeImpl: fakeProbe() }), { code: 'INVALID_FILE' });
  const big = path.join(temp, 'd.mp4');
  await writeFile(big, Buffer.concat([header, Buffer.alloc(2048)]));
  await assert.rejects(prepareVideoUpload(big, { probeImpl: fakeProbe(), maxBytes: 1024 }), { code: 'FILE_TOO_LARGE' });
  const outsideRoot = await mkdtemp(path.join(tmpdir(), 'mubai video prep outside '));
  t.after(() => rm(outsideRoot, { recursive: true, force: true }));
  const outside = path.join(outsideRoot, 'e.mp4');
  await writeFile(outside, header);
  await assert.rejects(prepareVideoUpload(outside, { assetRoot: temp, probeImpl: fakeProbe() }), { code: 'FILE_OUTSIDE_ROOT' });
  await assert.rejects(prepareVideoUpload('relative/path.mp4', { probeImpl: fakeProbe() }), { code: 'INVALID_FILE' });
});

test('upload_video retries when server returns stale lease and eventually completes', async t => {
  // Scenario: first attempt fails (creates local state); status query returns processing+stale:true;
  // client falls through and re-uploads; server takes over and completes.
  const { service, observed, file } = await serviceFixture(t, { failFirstAsset: true, serverKnowsOperation: false });
  const opId = 'stale-retry-v1';
  // Attempt 1: fails (socket destroyed) → local state becomes upload_failed
  await assert.rejects(service.uploadVideo({ operation_id: opId, file_path: file, description: 'stale 验收' }), /请求未获得可靠响应/);
  // Attempt 2: client queries status → gets processing+stale:true → falls through → re-uploads → succeeds
  service.client.uploadStatus = async op => ({ operation_id: op, status: 'processing', stale: true });
  const r = await service.uploadVideo({ operation_id: opId, file_path: file, description: 'stale 验收' });
  assert.equal(r.status, 'completed');
  assert.equal(r.replay, false);
  assert.ok(r.asset_id);
});

test('upload_video returns processing without stale (live lease) and does NOT re-upload', async t => {
  const { service, observed, file } = await serviceFixture(t);
  // First: complete the upload
  await service.uploadVideo({ operation_id: 'live-lease-v1', file_path: file, description: 'test' });
  // Now manually set the state to upload_failed so the client queries status
  const store = service.store;
  await store.withOperation('live-lease-v1', async (state, save) => {
    await save({ ...state, status: 'upload_failed' });
  });
  // Server returns processing without stale (simulating a live lease from another attempt)
  service.client.uploadStatus = async op => ({ operation_id: op, status: 'processing' });
  const writesBefore = observed.assets;
  const r = await service.uploadVideo({ operation_id: 'live-lease-v1', file_path: file, description: 'test' });
  assert.equal(r.status, 'processing');
  assert.equal(r.stale, undefined);
  assert.equal(observed.assets, writesBefore, 'must not re-upload when lease is live');
});

test('auth error during status query stops retry (no re-upload)', async t => {
  const { service, observed, file } = await serviceFixture(t, { failFirstAsset: true });
  const opId = 'auth-stop-v1';
  // Attempt 1: fails → local state becomes upload_failed
  await assert.rejects(service.uploadVideo({ operation_id: opId, file_path: file }), /请求未获得可靠响应/);
  // Attempt 2: status query throws auth error → client must throw (not re-upload)
  service.client.uploadStatus = async op => { throw new MediaError('AUTH_GRANT_REPLACED', '网站拒绝'); };
  await assert.rejects(
    service.uploadVideo({ operation_id: opId, file_path: file }),
    error => error instanceof MediaError && error.code === 'AUTH_GRANT_REPLACED'
  );
  assert.equal(observed.assets, 1, 'auth error must not trigger re-upload');
});

test('multiple sequential retries eventually complete after transient failures', async t => {
  const { service, observed, file } = await serviceFixture(t, { failFirstAsset: true, serverKnowsOperation: false });
  // Attempt 1: fails (socket destroyed)
  await assert.rejects(service.uploadVideo({ operation_id: 'multi-retry-v1', file_path: file }), /请求未获得可靠响应/);
  // Attempt 2: server now has a record but returns processing (lease active) → client returns processing
  observed.serverKnowsOperation = false;
  service.client.uploadStatus = async op => ({ operation_id: op, status: 'processing', stale: true });
  // Attempt 3: server returns stale → client retries the upload → succeeds
  const result = await service.uploadVideo({ operation_id: 'multi-retry-v1', file_path: file });
  assert.equal(result.status, 'completed');
  assert.ok(result.asset_id);
});


test('upload_video persists a processing POST and resumes via GET with the original key', async t => {
  const { service, observed, file } = await serviceFixture(t);
  const input = { operation_id: 'post-processing-v1', file_path: file };
  observed.postResult = operation_id => ({ operation_id, status: 'processing' });
  observed.getResult = operation_id => ({ data: { operation_id, status: 'processing' } });
  assert.equal((await service.uploadVideo(input)).status, 'processing');
  assert.equal((await service.uploadVideo(input)).status, 'processing');
  assert.equal(observed.assets, 1);
  assert.equal(observed.statusQueries, 1);
  observed.postResult = undefined;
  observed.getResult = operation_id => ({ data: { operation_id, status: 'processing', stale: true } });
  assert.equal((await service.uploadVideo(input)).status, 'completed');
  assert.equal(observed.assets, 2);
  assert.equal(observed.uploads[0].idempotency, observed.uploads[1].idempotency);
});

test('upload_video rejects malformed outcomes and unknown states without resending', async t => {
  const { service, observed, file } = await serviceFixture(t);
  const input = { operation_id: 'bad-response-v1', file_path: file };
  observed.postResult = operation_id => ({ operation_id, status: 'unknown', asset_id: 'asset_invalid', url: 'https://example.test/x.mp4' });
  await assert.rejects(service.uploadVideo(input), { code: 'INVALID_RESPONSE' });
  for (const data of [
    { operation_id: input.operation_id, status: 'unknown' },
    { operation_id: input.operation_id, status: 'processing', stale: 'true' },
    { operation_id: input.operation_id, status: 'completed', asset: { asset_id: 'asset_invalid' } },
    { operation_id: 'another-operation', status: 'failed' },
    null,
  ]) {
    observed.getResult = () => ({ data });
    await assert.rejects(service.uploadVideo(input), { code: 'INVALID_RESPONSE' });
  }
  observed.getResult = () => ({ data: {}, status: 404 });
  await assert.rejects(service.uploadVideo(input), { code: 'HTTP_404' });
  assert.equal(observed.assets, 1);
  observed.getResult = operation_id => ({ data: { operation_id, status: 'failed' } });
  observed.postResult = undefined;
  assert.equal((await service.uploadVideo(input)).status, 'completed');
  assert.equal(observed.uploads[0].idempotency, observed.uploads[1].idempotency);
});

function stubProbes(overrides = {}) {
  return async (command) => {
    const table = { node: { available: true, version: 'v22.13.0' }, npm: { available: true, version: '10.9.0' },
      git: { available: true, version: 'git version 2.45' }, ffmpeg: { available: true, version: 'ffmpeg version 7.1' },
      ffprobe: { available: true, version: 'ffprobe version 7.1' }, gh: { available: false, version: null } };
    if (command === 'python3' || command === 'python' || command === 'py') return { available: true, command, version: 'Python 3.11.9' };
    return { ...(table[command] || { available: false, version: null }), ...overrides[command] };
  };
}

test('check_video_env reports ready when the library and tools are complete', async t => {
  const temp = await mkdtemp(path.join(tmpdir(), 'mubai video env '));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'FredTalk');
  for (const relative of ['library/catalog.json', 'library/media-manifest.json', 'library/fonts/MiSans-Regular.ttf',
    'skills/fred-remotion-output/SKILL.md', 'skills/audio-subtitle-roughcut/SKILL.md', 'skills/cloud-render/SKILL.md',
    'skills/remotion-best-practices/SKILL.md', 'skills/fred-remotion-output/templates/episode-skeleton/episode.example.json',
    'skills/fred-remotion-output/templates/episode-skeleton/tools/build_timing.py', 'skills/fred-remotion-output/templates/episode-skeleton/tools/push_keyframes.py', 'scripts/catalog.py',
    'apps/library/package.json']) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), relative.endsWith('catalog.json') ? JSON.stringify({ schemaVersion: 1, references: new Array(432).fill({}) }) : 'x');
  }
  const env = { ...process.env, MUBAI_VIDEO_LIBRARY_HOME: root };
  const runtimeStub = async () => ({ found: true, path: 'rt', source: 'test', version: '4.0.538', cli: true, browserCache: true });
  const result = await detectVideoEnvironment(env, {
    probeCommand: stubProbes(),
    probeChrome: async () => ({ found: false, note: 'auto' }),
    locateRuntime: runtimeStub,
  });
  assert.equal(result.library.found, true);
  assert.equal(result.library.catalog_references, 432);
  assert.equal(result.runtime_ready, true);
  assert.equal(result.library_ready, true);
  assert.equal(result.render_ready, true);
  assert.equal(result.review_ready, true);
  assert.deepEqual(result.missing, []);
});

test('check_video_env lists concrete gaps when dependencies are missing', async t => {
  const temp = await mkdtemp(path.join(tmpdir(), 'mubai video gaps '));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const result = await detectVideoEnvironment({ MUBAI_VIDEO_LIBRARY_HOME: 'Z:\\definitely-missing\\FredTalk' }, {
    probeCommand: stubProbes({ ffmpeg: { available: false, version: null }, ffprobe: { available: false, version: null }, npm: { available: false, version: null } }),
    probeChrome: async () => ({ found: false }),
    locateRuntime: async () => ({ found: false, path: null, cli: false, browserCache: false }),
    home: temp,
    platform: 'linux',
  });
  assert.equal(result.library.found, false);
  assert.equal(result.library_ready, false);
  assert.equal(result.render_ready, false);
  assert.ok(result.missing.some(item => item.includes('FredTalk')));
  assert.ok(result.missing.some(item => item.includes('ffmpeg')));
  assert.ok(result.missing.some(item => item.includes('ffprobe')));
  assert.ok(result.missing.some(item => item.includes('npm')));
  assert.ok(result.missing.some(item => item.includes('Remotion')));
});

test('readiness evaluation treats remote mode, missing runtime or browser as not ready', () => {
  const library = { found: true, catalog_references: 10, skills: { 'fred-remotion-output': true, 'audio-subtitle-roughcut': true, 'cloud-render': true, 'remotion-best-practices': true }, episode_template: true, catalog_scripts: true, fonts: true, review_app_template: true };
  const tools = { node: { available: true, version: 'v22.13.0' }, npm: { available: true }, ffmpeg: { available: true }, ffprobe: { available: true }, python: { available: true, version: 'Python 3.11.9' } };
  const disk = { free_bytes: 10 * 1024 * 1024 * 1024, free_gb: 10 };
  const runtime = { found: true, cli: true, browserCache: true };
  const ready = evaluateReadiness({ library, runtime, tools, disk, remoteMode: false });
  assert.deepEqual(ready, { library_ready: true, runtime_ready: true, render_ready: true, review_ready: true });
  assert.deepEqual(evaluateReadiness({ library, runtime, tools, disk, remoteMode: true }), { library_ready: false, runtime_ready: false, render_ready: false, review_ready: false });
  const incomplete = { ...library, fonts: false };
  assert.equal(evaluateReadiness({ library: incomplete, runtime, tools, disk, remoteMode: false }).render_ready, false);
  assert.equal(evaluateReadiness({ library, runtime: { found: false, cli: false, browserCache: false }, tools, disk, remoteMode: false }).render_ready, false);
  const chromeMissing = { found: false };
  const runtimeNoBrowser = { found: true, cli: true, browserCache: false };
  assert.equal(evaluateReadiness({ library, runtime: runtimeNoBrowser, browser: chromeMissing, tools, disk, remoteMode: false }).render_ready, false);
  const lowDisk = { free_bytes: 1024, free_gb: 0 };
  assert.equal(evaluateReadiness({ library, runtime, tools, disk: lowDisk, remoteMode: false }).render_ready, false);
  const node20_19 = { ...tools, node: { available: true, version: 'v20.19.0' } };
  assert.equal(evaluateReadiness({ library, runtime, tools: node20_19, disk, remoteMode: false }).render_ready, true);
  const node20_11 = { ...tools, node: { available: true, version: 'v20.11.0' } };
  assert.equal(evaluateReadiness({ library, runtime, tools: node20_11, disk, remoteMode: false }).render_ready, false);
});
