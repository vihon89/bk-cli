import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import path from 'node:path';
import { z } from 'zod';
import { MediaError } from './client.mjs';
import { locateVideoLibrary } from './video-env.mjs';

const run = promisify(execFile);
const caseId = z.number().int().positive();
const local = z.string().min(1).max(2048).refine(p => path.isAbsolute(p), '需要本机绝对路径');
const common = { case_id: caseId, package_file: local.optional(), locale: z.enum(['zh','en']).default('zh') };

const receipt = z.object({run_id: z.string().uuid(), case_id: caseId, outcome: z.enum(['rendered','failed']), elapsed_ms: z.number().int().min(0).max(2147483647)}).strict();

async function renderAndReport(env, args, getClient) {
  const started = Date.now();
  const run_id = args.run_id || randomUUID();
  const client = await getClient().catch(() => null);
  let result, failure;
  try { result = await dispatch(env, args); } catch (error) { failure = error; }
  if (!failure && result.status !== 'rendered') return result;
  const report = {run_id, case_id:args.case_id, outcome:failure ? 'failed' : 'rendered', elapsed_ms: Math.min(2147483647,Date.now()-started)};
  let reporting;
  try { reporting = await client.request('POST','/local-render-results',report,{timeoutMs:8000}); }
  catch { reporting = {status:'pending', report}; }
  if (failure) {
    failure.message += ' 运行结果：' + JSON.stringify({report, reporting});
    throw failure;
  }
  return {...result, run_id, report, reporting};
}

export function motionTools(env, getClient) {
  if (env.MUBAI_REMOTE_MODE === '1') return [];
  return [
    ['get_motion_case', '按 MotionGit 案例 ID 定位可编辑包。公开直链包可自动获取，需登录的包返回官方领取地址。传入已下载的 package_file 可检查原包与素材契约。', z.object(common).strict(), a => dispatch(env, a), true],
    ['render_motion_case', '经用户审核并确认运行适配器后，传入已审核的本地原包和 SHA-256，将视频和音轨导出到新 MP4。params 在对应素材槽使用 $BK_VIDEO 和 $BK_AUDIO。', z.object({ ...common, package_file: local, package_sha256: z.string().regex(/^[a-f0-9]{64}$/), run_id: z.string().uuid().optional(), video_file: local, audio_file: local, output_file: local, params: z.record(z.string(), z.unknown()).optional() }).strict(), a => renderAndReport(env, a, getClient), false],
    ['report_motion_result', '重报本机剪辑返回的原始 report 对象；沿用同一运行 ID，不渲染、不上传素材。', receipt, async r => (await getClient()).request('POST','/local-render-results',r), false]
  ];
}

async function dispatch(env, args) {
  let catalog;
  const library = await locateVideoLibrary(env);
  const catalogPath = env.MUBAI_MOTION_CATALOG || (library.found && path.join(library.path,'library','motiontemplates.json'));
  if (catalogPath) catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  else {
    const res = await fetch('https://raw.githubusercontent.com/motiontemplates/all/main/catalog.json', {signal: AbortSignal.timeout(20000)});
    if (!res.ok) throw new MediaError('MOTION_CATALOG_UNAVAILABLE','无法获取 MotionGit 模板目录。');
    catalog = await res.json();
  }
  const entry = catalog.templates.find(t => String(t.templateId) === String(args.case_id));
  if (!entry) throw new MediaError('MOTION_CASE_UNKNOWN','未找到此案例 ID。');
  const page = new URL(entry.website);
  if (page.origin !== 'https://motiongit.com') throw new MediaError('MOTION_CASE_INVALID','目录中官网地址无效。');
  const direct = entry.download?.urls?.[args.locale];
  const meta = { case_id: args.case_id, title: entry.title, repository_id: entry.repositoryId, acquisition_url: page.href, version: entry.version };
  if (!args.package_file && !direct) return { ...meta, status: 'package_required', message: '请在官方网站登录领取 .motion 原包，将本地路径传入 package_file。' };
  if (!args.package_file && (new URL(direct).origin !== 'https://motiontemplates.github.io' || !new URL(direct).pathname.startsWith('/'+entry.repositoryId+'/'))) throw new MediaError('MOTION_SOURCE_INVALID','公开包来源与目录不一致。');
  const script = fileURLToPath(new URL('./motion-runner.py', import.meta.url));
  const child = run(env.MUBAI_MOTION_PYTHON || 'python', ['-X','utf8',script], {windowsHide:true, encoding:'utf8', maxBuffer:2*1024*1024, env});
  child.child.stdin.on('error',()=>{});
  child.child.stdin.end(JSON.stringify({ ...args, library_root: library.found ? library.path : null, direct: args.package_file ? null : direct, slug: page.pathname.split('/').pop(), repository_id: entry.repositoryId }));
  let stdout;
  try { ({stdout} = await child); } catch { throw new MediaError('MOTION_RUNNER_UNAVAILABLE','本机模板执行器启动失败，请检查 Python 3 和工作目录。'); }
  const result = JSON.parse(stdout);
  if (result.error) throw new MediaError(result.error, result.message);
  return {...meta,...result};
}
