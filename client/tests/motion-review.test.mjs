import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { motionTools } from '../src/motion-case.mjs';

test('Motion render requires a local reviewed archive and checks its digest before inspecting content', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'bk-motion-review-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const archive = path.join(home, 'fixture.motion');
  await writeFile(archive, 'changed bytes');
  const input = { case_id: 1, video_file: path.join(home, 'video.mp4'), audio_file: path.join(home, 'audio.wav'),
    output_file: path.join(home, 'output.mp4') };
  const [, , schema] = motionTools({}).find(tool => tool[0] === 'render_motion_case');
  const digest = '0'.repeat(64);
  assert.equal(schema.safeParse(input).success, false);
  assert.equal(schema.safeParse({ ...input, package_file: archive }).success, false);
  assert.equal(schema.safeParse({ ...input, package_file: archive, package_sha256: digest }).success, true);
  const runner = fileURLToPath(new URL('../src/motion-runner.py', import.meta.url));
  for (const [fields, code] of [[{}, 'MOTION_REVIEW_REQUIRED'],
    [{ package_file: archive, package_sha256: digest }, 'MOTION_DIGEST_MISMATCH']]) {
    const result = spawnSync(process.env.BK_TEST_PYTHON || 'python', ['-X', 'utf8', runner], {
      input: JSON.stringify({ ...input, ...fields }), encoding: 'utf8', timeout: 10000,
    });
    assert.ifError(result.error);
    assert.equal(JSON.parse(result.stdout).error, code);
  }
});
