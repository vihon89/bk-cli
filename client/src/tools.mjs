import { z } from 'zod';
import { MediaClient, MediaError, configFromSources, safeError } from './client.mjs';
import { AccountOperationStore } from './operation-store.mjs';
import { MediaService } from './service.mjs';
import { detectVideoEnvironment } from './video-env.mjs';

import { createCredentialStore, storedCredential } from './credential-store.mjs';
import { readChatCatalog, requestChat } from './chat-client.mjs';
import { motionTools } from './motion-case.mjs';

const operation = z.string().regex(/^[A-Za-z0-9_.-]{8,128}$/).describe('一次用户创作的稳定操作 ID；网络重试须复用。');
const noArgs = z.object({}).strict();
const batchId = z.string().regex(/^[A-Za-z0-9_.-]{1,160}$/);
const submitArgs = z.object({ operation_id: operation, max_score: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).describe('用户为本次创作授权的积分上限。'), batch_id: batchId.optional().describe('已由网站用户批准的批次编号；重试必须保留。') }).strict();
export function buildTools(env = process.env) {
  // Discovery is local and free. Credentials are required only when a tool runs.
  const getContext = async () => {
    // Resolve on every tools/call; logout or profile changes must not retain a cached key.
    const config = await configFromSources(env);
    const client = new MediaClient(config);
    return { client, service: new MediaService(client, new AccountOperationStore(client, config)) };
  };
  const client = new Proxy({}, { get: (_, name) => async (...args) => (await getContext()).client[name](...args) });
  const service = new Proxy({}, { get: (_, name) => async (...args) => (await getContext()).service[name](...args) });
  const defs = [
    ['discover_skills', '用户发来素材和创作需求时先调用，按自然语言匹配 BK 网站 Skill。has_image 表示已有可用的商品原图；缺必填项时一次问齐。matched 后使用返回的 skill.id 调用 quote_generation，无需用户提供名称或编号。', z.object({
      request: z.string().trim().min(1).max(2000), has_image: z.boolean()
    }).strict(), a => client.request('POST', '/skills/discover', a), true],
    ...(env.MUBAI_REMOTE_MODE === '1' ? [] : [['check_windows_credentials', 'Windows 授权凭据自检。遇到 DPAPI、安全存储或授权读取错误时调用。用临时记录检查保存与读回，再检查已有授权，返回下一步。', noArgs, () => createCredentialStore({ env }).diagnoseWindows(), false]]),
    ...(env.MUBAI_REMOTE_MODE === '1' ? [] : [[
      'chat_reply', '用当前 BK 授权完成一轮文本对话。返回模型的真实回复。要求最低价时传 cheapest；重试沿用 request_id。默认只向用户展示回复。',
      z.object({request_id: operation, message: z.string().min(1).max(32000), model: z.union([z.literal('cheapest'),z.string().regex(/^bk-chat-[1-9][0-9]{0,9}$/)]), max_tokens: z.number().int().min(1).max(4096).default(512)}).strict(),
      async ({request_id,message,model,max_tokens}) => {
        const profile = await storedCredential({env});
        if (!profile.chat_granted) throw new MediaError('CHAT_AUTHORIZATION_REQUIRED','当前连接需要启用对话权限。');
        const origin = profile.base_url;
        const candidates = model === 'cheapest' ? await readChatCatalog(origin, profile) : [{id:model}];
        if (!candidates.length) throw new MediaError('CHAT_MODEL_UNAVAILABLE','当前账号没有可用的对话模型。');
        let selected;
        for (const candidate of candidates) {
          const body = {model:candidate.id, messages:[{role:'user',content:message}], max_tokens, stream:false};
          const quote = await requestChat(origin, profile, 'quote', {body});
          const limit = quote?.estimated_max_score;
          if (quote?.model !== candidate.id || !Number.isSafeInteger(limit) || limit < 1)
            throw new MediaError('CHAT_QUOTE_INVALID','对话报价暂不可用。');
          if (!selected || limit < selected.max_score) selected = {...body,max_score:limit};
        }
        const result = await requestChat(origin, profile, 'complete', {body:selected,requestId:request_id});
        return {reply:result.reply?.choices?.[0]?.message?.content,model:selected.model,request_id:result.reply?.id};
      }, false
    ]]),
    ...motionTools(env, async () => (await getContext()).client),
    ['get_account', '查看实际网站账号、积分、预算占用及本人授权安装/最近连接来源；IP可能是代理，不代表唯一电脑。', noArgs, () => client.account(), true],
    ['list_models', '由Agent查询本账号可用模型与参数，按客户制作目标自动筛选并报价。id用于内部调用，不要求客户提供或选择编号；明确指定模型时按公开名称匹配。', z.object({ type: z.enum(['image', 'video']).optional() }).strict(), a => client.models(a.type), true],
    ['upload_asset', env.MUBAI_REMOTE_MODE === '1' ? '远程模式不读取服务器或客户端本地路径；请先在本站上传素材，再使用当前账号asset_id。' : '上传用户指定的本地商品图片，返回绑定账号的 asset_id。', z.object({ file_path: z.string().min(1) }).strict(), a => { if (env.MUBAI_REMOTE_MODE === '1') throw new MediaError('REMOTE_UPLOAD_UNAVAILABLE', '远程模式仅支持用户已上传本站的asset_id，不读取路径或抓取任意URL。'); return client.upload(a.file_path); }, false],
    ['quote_generation', '为图片或视频建立报价。未指定模型使用后台默认；用户要求最便宜时省略model并传cheapest，由服务器比较账号授权内相同规格的实时报价。普通图片须明确比例与尺寸，视频还须明确时长；传 skill_id 时默认规格取网站表单和模型，用户未指定可省略。明确指定模型和重新编辑不参与换模。只报价不生成，参数变化使用新操作ID。', z.object({
      operation_id: operation, type: z.enum(['image', 'video']), model: z.string().min(1).max(200).optional().describe('仅在用户明确指定模型时传内部ID；否则省略。'),
      model_name: z.string().trim().min(1).max(200).optional().describe('客户明确指定的公开模型名称或别名，由网站解析。不能同时传model；重名时按网站返回的BK渠道选项澄清，不猜渠道。'),
      model_strategy: z.enum(['default','cheapest']).optional().describe('默认default；用户明确要求最便宜时使用cheapest。显式model和原任务模型优先。'),
      prompt: z.string().min(1).max(32000).describe('提示词 UTF-8 编码后最多 32000 字节。'),
      skill_id: z.string().min(1).max(160).optional().describe('discover_skills 命中的网站 Skill ID。'),
      source_task_id: z.string().regex(/^[A-Za-z0-9_.-]{1,160}$/).optional().describe('重新编辑时传原任务编号，由网站锁定原始模型身份。'),
      params: z.record(z.string(), z.unknown()).default({}), materials: z.array(z.object({ asset_id: z.string().min(1).max(200) }).strict()).max(8).default([])
    }).strict(), a => service.quote(a), false],
    ['generate_image', '按已有图片报价提交并扣网站积分。仅在用户授权预算内调用；重试复用 operation_id。', submitArgs, a => service.submit('image', a), false],
    ['generate_video', '按已有视频报价提交并扣网站积分。返回任务编号；需继续查询成片。重试复用 operation_id。', submitArgs, a => service.submit('video', a), false],
    ['create_batch', '汇总本机已报价的operation_ids创建网站待确认批次，返回确认网址。用户必须亲自在网站批准；本工具不生成、不代表批准。重试保留原操作集合和总预算。', z.object({ operation_ids: z.array(operation).min(1).max(20), max_total_score: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER) }).strict(), a => service.createBatch(a), false],
    ['get_batch', '查询网站批次是否已由用户批准；只有approved才可开始提交原报价。', z.object({ batch_id: batchId }).strict(), a => service.getBatch(a.batch_id), true],
    ['get_task', '查询任务进度、结果及扣费状态，不发起生成。修图结果若标记 retouch_fidelity=unverified，请如实告知未能确认去污和原图像素保真。', z.object({ task_id: z.string().regex(/^[A-Za-z0-9_.-]{1,160}$/) }).strict(), a => client.task(a.task_id), true],
    ['wait_task', '最多等待 30 秒查询任务。等待结束仍未完成时保留 task_id，绝不重新生成。', z.object({ task_id: z.string().regex(/^[A-Za-z0-9_.-]{1,160}$/), max_wait_seconds: z.number().int().min(1).max(30).default(20) }).strict(), a => service.wait(a), true],
    ['check_video_env', '检查本机整期视频制作（FredTalk/Remotion）环境：视觉库、渲染运行时、审片工作台的就绪状态与缺失项。只读检查，不联网、不安装。', z.object({ output_dir: z.string().min(1).max(1024).optional().describe('可选：本期成片输出目录（绝对路径）；磁盘检查将针对它进行') }).strict(), a => detectVideoEnvironment(env, { outputDir: a.output_dir }), true],
    ['upload_video', '把本机最终成片 MP4（不超过 200 MiB）上传回 BK 素材库，返回素材地址与资产编号。重试必须沿用同一 operation_id；文件或说明变化时使用新操作 ID。', z.object({
      operation_id: operation,
      file_path: z.string().min(1).max(1024).describe('用户指定的最终成片绝对路径（.mp4）'),
      description: z.string().trim().max(200).optional().describe('可选的成片说明，随素材保存在网站')
    }).strict(), a => { if (env.MUBAI_REMOTE_MODE === '1') throw new MediaError('REMOTE_UPLOAD_UNAVAILABLE', '远程模式不读取本机文件；请在本机运行 BK 连接器后上传成片。'); return service.uploadVideo(a); }, false]
  ];
  return defs.map(([name, description, schema, execute, readOnly]) => ({ name, description: `BK爆款（BK）${description}`, schema, execute,
    annotations: { readOnlyHint: readOnly, destructiveHint: name.startsWith('generate_'), idempotentHint: ['get_account', 'list_models', 'get_task', 'get_batch', 'wait_task', 'quote_generation', 'create_batch', 'generate_image', 'generate_video', 'check_video_env', 'upload_video'].includes(name), openWorldHint: true } }));
}

export async function executeTool(def, input) {
  const parsed = def.schema.safeParse(input);
  if (!parsed.success) return { isError: true, structuredContent: { error: { code: 'INVALID_ARGUMENTS', message: '工具参数不符合规范，请检查字段和类型。' } }, content: [{ type: 'text', text: '工具参数不符合规范，请检查字段和类型。' }] };
  try {
    const data = await def.execute(parsed.data);
    return { structuredContent: { data }, content: [{ type: 'text', text: JSON.stringify({ data }) }] };
  } catch (error) {
    const body = { error: safeError(error) };
    return { isError: true, structuredContent: body, content: [{ type: 'text', text: JSON.stringify(body) }] };
  }
}
