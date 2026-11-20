import { execFile } from 'node:child_process';
import { stat, statfs, realpath, readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { MediaError } from './client.mjs';

const run = promisify(execFile);
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const MIN_DISK_BYTES = 5 * 1024 * 1024 * 1024;
const MIN_RENDER_DISK_BYTES = 10 * 1024 * 1024 * 1024;

// Every probe is bounded and read-only; failures become structured "missing" data, never throws.
// Windows .cmd shims (npm) need the shell fallback; plain executables spawn directly to avoid DEP0190.
async function probeCommand(command, args, { timeoutMs = 8000, env = process.env } = {}) {
  for (const useShell of [false, true]) {
    try {
      const result = await run(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 256 * 1024, env, shell: useShell });
      const line = String(result.stdout || result.stderr || '').split(/\r?\n/).find(part => part.trim()) || '';
      return { command, available: true, version: line.trim().slice(0, 120) };
    } catch (error) {
      if (error.code === 'ENOENT' && !useShell) continue;
      if (error.code === 'ETIMEDOUT' || error.killed) return { command, available: false, version: null, error: 'probe_timeout' };
      if (!useShell) continue;
      return { command, available: false, version: null };
    }
  }
  return { command, available: false, version: null };
}

const versionNumber = text => {
  const match = String(text || '').match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] || 0) } : null;
};
const atLeast = (version, major, minor = 0) => {
  const parsed = versionNumber(version);
  if (!parsed) return false;
  return parsed.major > major || (parsed.major === major && parsed.minor >= minor);
};

async function probePython(env, runner = probeCommand) {
  for (const [command, args] of [['python3', ['--version']], ['python', ['--version']], ['py', ['-3', '--version']]]) {
    const result = await runner(command, args, { env });
    if (result.available) return { ...result, command };
  }
  return { command: 'python3', available: false, version: null };
}

async function probeChrome({ platform = process.platform, env = process.env } = {}) {
  const candidates = platform === 'win32'
    ? [path.join(env['ProgramFiles'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
       path.join(env['LOCALAPPDATA'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
       path.join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe')]
    : platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate) || !candidate.trim()) continue;
    try { const info = await stat(candidate); if (info.isFile()) return { found: true, path: candidate }; } catch { /* next candidate */ }
  }
  return { found: false, note: '未检测到系统 Chrome；Remotion 首次渲染可自动下载 Chrome for Testing（需网络），或自行安装系统 Chrome。' };
}

async function directoryExists(target) {
  try { return (await stat(target)).isDirectory(); } catch { return false; }
}
async function fileExists(target) {
  try { return (await stat(target)).isFile(); } catch { return false; }
}

export function videoLibraryCandidates(env = process.env, { home = homedir(), platform = process.platform } = {}) {
  const candidates = [];
  const configured = String(env.MUBAI_VIDEO_LIBRARY_HOME || '').trim();
  if (configured) candidates.push({ path: configured, source: 'MUBAI_VIDEO_LIBRARY_HOME' });
  candidates.push({ path: path.join(home, 'FredTalk'), source: 'default' });
  candidates.push({ path: path.join(home, 'zimeiti', 'FredTalk'), source: 'default' });
  if (platform === 'win32') candidates.push({ path: 'F:\\zimeiti\\FredTalk', source: 'default' });
  return candidates;
}

export async function locateVideoLibrary(env = process.env, dependencies = {}) {
  for (const candidate of videoLibraryCandidates(env, dependencies)) {
    if (!path.isAbsolute(candidate.path)) continue;
    let resolved;
    try { resolved = await realpath(candidate.path); } catch { continue; }
    if (await directoryExists(path.join(resolved, 'library'))
        && await fileExists(path.join(resolved, 'library', 'catalog.json'))) {
      return { found: true, path: resolved, source: candidate.source };
    }
  }
  return { found: false, path: null, source: null };
}

async function inspectLibrary(root) {
  const readJsonSafe = async target => {
    try { return JSON.parse(await readFile(target, 'utf8')); } catch { return null; }
  };
  const catalog = await readJsonSafe(path.join(root, 'library', 'catalog.json'));
  const references = Array.isArray(catalog?.references) ? catalog.references.length
    : Array.isArray(catalog?.items) ? catalog.items.length : null;
  const skillNames = ['fred-remotion-output', 'audio-subtitle-roughcut', 'cloud-render', 'remotion-best-practices'];
  const skills = {};
  for (const name of skillNames) skills[name] = await fileExists(path.join(root, 'skills', name, 'SKILL.md'));
  const appsLibrary = path.join(root, 'apps', 'library');
  const visual = {
    package: await fileExists(path.join(appsLibrary, 'package.json')),
    node_modules: await directoryExists(path.join(appsLibrary, 'node_modules')),
  };
  // The episode skeleton ships inside fred-remotion-output; some layouts also carry a repo-root copy.
  const skeletonRoots = [path.join(root, 'skills', 'fred-remotion-output', 'templates', 'episode-skeleton'),
    path.join(root, 'templates', 'episode-skeleton')];
  let episodeSkeleton = false;
  let buildTiming = false;
  for (const candidate of skeletonRoots) {
    if (!episodeSkeleton && await directoryExists(candidate) && (await fileExists(path.join(candidate, 'episode.example.json')) || await fileExists(path.join(candidate, 'README.md')))) {
      episodeSkeleton = true;
      buildTiming = await fileExists(path.join(candidate, 'tools', 'build_timing.py'));
    }
  }
  return {
    path: root,
    catalog_references: references,
    skills,
    episode_template: episodeSkeleton,
    build_timing_tool: buildTiming,
    catalog_scripts: await fileExists(path.join(root, 'scripts', 'catalog.py')) || await fileExists(path.join(root, 'scripts', 'references.py')),
    scene_script: await fileExists(path.join(root, 'skills', 'fred-remotion-output', 'scripts', 'scene.py')),
    fonts: await directoryExists(path.join(root, 'library', 'fonts')) && (await readdir(path.join(root, 'library', 'fonts')).then(names => names.length).catch(() => 0)) > 0,
    media_manifest: await fileExists(path.join(root, 'library', 'media-manifest.json')),
    visual_library: visual,
    review_app_template: await directoryExists(path.join(root, 'skills', 'fred-remotion-output', 'templates', 'review-app'))
      || await fileExists(path.join(root, 'skills', 'fred-remotion-output', 'templates', 'episode-skeleton', 'tools', 'push_keyframes.py')),
  };
}

/** Locked Remotion render runtime detection. A runtime is a directory whose node_modules
 * contains a real remotion package (BK-managed default: ~/.mubai-media/video-runtime, or the
 * FredTalk skills/_runtime convention). The author machine's other projects are never probed. */
export async function locateRenderRuntime(env = process.env, dependencies = {}) {
  const candidates = [];
  const configured = String(env.MUBAI_VIDEO_RUNTIME_HOME || '').trim();
  if (configured) candidates.push({ path: configured, source: 'MUBAI_VIDEO_RUNTIME_HOME' });
  if (dependencies.libraryPath) {
    candidates.push({ path: path.join(dependencies.libraryPath, 'skills', '_runtime', 'remotion'), source: 'fredtalk-runtime' });
  }
  candidates.push({ path: path.join(dependencies.home || homedir(), '.mubai-media', 'video-runtime'), source: 'default' });
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate.path)) continue;
    // FredTalk convention: skills/_runtime/remotion/<runtime-name>/node_modules
    const searchRoots = candidate.source === 'fredtalk-runtime'
      ? await readdir(candidate.path).then(names => names.map(name => path.join(candidate.path, name))).catch(() => [])
      : [candidate.path];
    for (const root of searchRoots) {
      const remotionPkg = path.join(root, 'node_modules', 'remotion', 'package.json');
      try {
        const pkg = JSON.parse(await readFile(remotionPkg, 'utf8'));
        if (typeof pkg.version === 'string') {
          const cli = await fileExists(path.join(root, 'node_modules', '@remotion', 'cli', 'package.json'));
          const browser = await directoryExists(path.join(root, 'node_modules', '.remotion'));
          return { found: true, path: root, source: candidate.source, version: pkg.version, cli, browserCache: browser };
        }
      } catch { /* next candidate */ }
    }
  }
  return { found: false, path: null, source: null, version: null, cli: false, browserCache: false };
}

// Merge probe results into the three readiness flags. render_ready demands the locked
// runtime and a browser (system Chrome or an existing Remotion browser cache) — a repo
// being present is never enough. review_ready means the workbench can start.
export function evaluateReadiness({ library, runtime, browser, tools, disk, remoteMode }) {
  if (remoteMode) return { library_ready: false, render_ready: false, review_ready: false, runtime_ready: false };
  runtime = runtime || { found: false, cli: false, browserCache: false };
  browser = browser || { found: false };
  const libraryReady = library.found && library.catalog_references > 0
    && Object.values(library.skills).every(Boolean)
    && library.episode_template && library.catalog_scripts && library.fonts;
  const nodeOk = tools.node.available && (atLeast(tools.node.version, 22) || atLeast(tools.node.version, 20, 19));
  const pythonOk = tools.python.available && atLeast(tools.python.version, 3, 11);
  const runtimeReady = libraryReady && runtime.found && runtime.cli && nodeOk && tools.npm.available;
  const browserOk = browser.found === true || runtime.browserCache === true;
  const renderReady = runtimeReady && tools.ffmpeg.available && tools.ffprobe.available && pythonOk
    && browserOk && Number.isFinite(disk.free_gb) && disk.free_bytes >= MIN_RENDER_DISK_BYTES;
  const reviewReady = libraryReady && pythonOk && library.review_app_template;
  return { library_ready: libraryReady, runtime_ready: runtimeReady, render_ready: renderReady, review_ready: reviewReady };
}

function buildMissing({ library, runtime, browser, tools, disk }) {
  const missing = [];
  if (!library.found) missing.push('未找到 FredTalk 仓库；设置 MUBAI_VIDEO_LIBRARY_HOME 或按 bk-video-episode Skill 引导安装。');
  else {
    if (!library.catalog_references) missing.push('FredTalk library/catalog.json 缺失或无法解析。');
    for (const [name, ok] of Object.entries(library.skills)) if (!ok) missing.push(`缺少 FredTalk Skill: skills/${name}/SKILL.md。`);
    if (!library.episode_template) missing.push('缺少整期工程模板 templates/episode-skeleton。');
    if (!library.catalog_scripts) missing.push('缺少组件检索脚本 scripts/catalog.py。');
    if (!library.fonts) missing.push('缺少 library/fonts 字体资产。');
    if (!library.review_app_template) missing.push('缺少审片工作台模板（review-app / push_keyframes）。');
  }
  if (!runtime.found) missing.push('缺少锁定的 Remotion 渲染运行时；按 bk-video-episode Skill 用 runtime lockfile 执行 npm ci（MUBAI_VIDEO_RUNTIME_HOME）。');
  else {
    if (!runtime.cli) missing.push('渲染运行时缺少 @remotion/cli。');
    if (!browser.found && !runtime.browserCache) missing.push('未检测到可用浏览器：安装系统 Chrome，或在渲染运行时执行 npx remotion browser ensure。');
  }
  if (!tools.node.available || !(atLeast(tools.node.version, 22) || atLeast(tools.node.version, 20, 19))) missing.push('需要 Node.js ≥22（或 ≥20.19）用于整期渲染。');
  else if (!atLeast(tools.node.version, 22)) missing.push('整期渲染建议 Node.js 22+（当前 ' + tools.node.version + '）。');
  if (!tools.npm.available) missing.push('未检测到 npm。');
  if (!tools.ffmpeg.available) missing.push('未检测到 ffmpeg。');
  if (!tools.ffprobe.available) missing.push('未检测到 ffprobe。');
  if (!tools.python.available || !atLeast(tools.python.version, 3, 11)) missing.push('需要 Python ≥3.11（python3/python/py -3 任一）。');
  if (Number.isFinite(disk.free_gb) && disk.free_bytes < MIN_RENDER_DISK_BYTES) missing.push(`渲染/输出目录可用空间不足（${disk.free_gb} GB < 10 GB）。`);
  return missing.slice(0, 24);
}

export async function detectVideoEnvironment(env = process.env, dependencies = {}) {
  const remoteMode = env.MUBAI_REMOTE_MODE === '1';
  const runner = dependencies.probeCommand || probeCommand;
  const library = dependencies.locate ? await dependencies.locate(env) : await locateVideoLibrary(env, dependencies);
  const runtime = dependencies.locateRuntime ? await dependencies.locateRuntime(env, { libraryPath: library.found ? library.path : null, home: dependencies.home })
    : await locateRenderRuntime(env, { libraryPath: library.found ? library.path : null, home: dependencies.home });
  const browser = dependencies.probeChrome ? await dependencies.probeChrome({ env }) : await probeChrome({ env });
  const tools = {
    node: await runner('node', ['-v'], { env }),
    npm: await runner('npm', ['-v'], { env }),
    git: await runner('git', ['--version'], { env }),
    ffmpeg: await runner('ffmpeg', ['-version'], { env }),
    ffprobe: await runner('ffprobe', ['-version'], { env }),
    python: await probePython(env, runner),
    chrome: browser,
    optional: { gh: await runner('gh', ['--version'], { env }) },
  };
  tools.runtime_node = process.versions.node;
  // Disk is checked on the directory where rendering output will actually land.
  const diskPath = dependencies.outputDir && path.isAbsolute(dependencies.outputDir)
    ? dependencies.outputDir
    : (library.found ? library.path : null);
  let disk = { path: diskPath, free_gb: null, free_bytes: null };
  if (diskPath) {
    try {
      const info = await statfs(diskPath);
      disk = { path: diskPath, free_bytes: Number(info.bavail) * Number(info.bsize), free_gb: Math.floor((Number(info.bavail) * Number(info.bsize)) / (1024 * 1024 * 1024)) };
    } catch { /* keep nulls */ }
  }
  const inspected = library.found ? await inspectLibrary(library.path) : null;
  const enrichedLibrary = inspected ? { found: true, source: library.source, ...inspected } : { found: false, path: null, source: null, catalog_references: 0, skills: {}, episode_template: false, catalog_scripts: false, fonts: false, review_app_template: false };
  const readiness = evaluateReadiness({ library: enrichedLibrary, runtime, browser, tools, disk, remoteMode });
  return {
    remote_mode: remoteMode,
    ...readiness,
    library: enrichedLibrary,
    runtime,
    tools,
    disk,
    missing: buildMissing({ library: enrichedLibrary, runtime, browser, tools, disk }),
  };
}

// Validate a local MP4 for upload: absolute path, boundary, extension, size, container magic.
// probeImpl defaults to the real ffprobe; tests inject a stub to stay hermetic.
export async function prepareVideoUpload(filePath, { assetRoot, maxBytes = MAX_VIDEO_BYTES, probeImpl = probeVideoFile } = {}) {
  if (!path.isAbsolute(filePath)) throw new MediaError('INVALID_FILE', 'file_path 必须是用户指定的本地绝对路径。');
  const file = await realpath(filePath).catch(() => { throw new MediaError('INVALID_FILE', '文件不存在或无法访问。'); });
  if (assetRoot) {
    const root = await realpath(assetRoot);
    const relative = path.relative(root, file);
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new MediaError('FILE_OUTSIDE_ROOT', '文件不在配置允许的目录中。');
  }
  const info = await stat(file);
  if (!info.isFile()) throw new MediaError('INVALID_FILE', '必须是普通文件。');
  if (info.size <= 0) throw new MediaError('INVALID_FILE', '文件为空。');
  if (info.size > maxBytes) throw new MediaError('FILE_TOO_LARGE', `成片超过 ${Math.floor(maxBytes / (1024 * 1024))} MiB 上限（实际 ${(info.size / (1024 * 1024)).toFixed(1)} MiB）。请压缩码率或分段后重试。`);
  if (path.extname(file).toLowerCase() !== '.mp4') throw new MediaError('INVALID_FILE', '首版仅支持 MP4 容器（.mp4）。');
  const handle = await import('node:fs/promises').then(fs => fs.open(file, 'r'));
  try {
    const header = Buffer.alloc(12);
    await handle.read(header, 0, 12, 0);
    if (header.readUInt32BE(4) !== 0x66747970) throw new MediaError('INVALID_FILE', '文件不是 MP4 容器（缺少 ftyp 头）。');
  } finally { await handle.close(); }
  const probe = await probeImpl(file);
  const hash = createHash('sha256');
  const readHandle = await import('node:fs/promises').then(fs => fs.open(file, 'r'));
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) {
      const { bytesRead } = await readHandle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally { await readHandle.close(); }
  return { file, fileName: path.basename(file), size: info.size, sha256: hash.digest('hex'), probe };
}

export async function probeVideoFile(file, { timeoutMs = 30000 } = {}) {
  let raw;
  // Direct spawn first; Windows .cmd shims need the shell fallback (avoids DEP0190 noise).
  for (const useShell of [false, true]) {
    try {
      raw = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024, shell: useShell });
      break;
    } catch (error) {
      if (error.code === 'ENOENT' && !useShell) continue;
      throw new MediaError('MEDIA_PROBE_UNAVAILABLE', 'ffprobe 校验失败或未安装；整期渲染与上传都依赖 ffmpeg/ffprobe，请先安装并加入 PATH。');
    }
  }
  let parsed;
  try { parsed = JSON.parse(raw.stdout); } catch { throw new MediaError('MEDIA_PROBE_UNAVAILABLE', '无法解析媒体信息。'); }
  const video = (parsed.streams || []).find(stream => stream.codec_type === 'video');
  const audio = (parsed.streams || []).find(stream => stream.codec_type === 'audio');
  if (!video) throw new MediaError('INVALID_FILE', '文件缺少视频轨。');
  const duration = Number(parsed.format?.duration);
  return {
    width: Number(video.width) || null,
    height: Number(video.height) || null,
    duration_seconds: Number.isFinite(duration) ? Math.round(duration * 1000) / 1000 : null,
    video_codec: video.codec_name || null,
    audio_codec: audio?.codec_name || null,
    fps: (() => { const [num, den] = String(video.avg_frame_rate || '0/1').split('/').map(Number); return den ? Math.round((num / den) * 1000) / 1000 : null; })(),
  };
}

export const VIDEO_UPLOAD_LIMITS = Object.freeze({ maxBytes: MAX_VIDEO_BYTES });
export const VIDEO_TMP_HINT = tmpdir();
