import { randomUUID } from 'node:crypto';
import { MediaError, safeError } from './client.mjs';
import { payloadHash } from './operation-store.mjs';

function invalidUploadResponse() {
  return new MediaError('INVALID_RESPONSE', '上传响应状态或资产信息无效，请保留原 operation_id 查询。');
}

function assertUploadedAsset(asset, sha256) {
  if (typeof asset?.asset_id !== 'string' || !asset.asset_id || typeof asset.url !== 'string' || !asset.url
      || (asset.sha256 !== undefined && asset.sha256 !== sha256)) throw invalidUploadResponse();
}

function processingUpload(operation_id) {
  return { operation_id, status: 'processing',
    message: '上传仍在服务端处理。保留原 operation_id，稍后重新调用 upload_video 查询。' };
}

export class MediaService {
  constructor(client, store) { this.client = client; this.store = store; }
  async quote({ operation_id, ...payload }) {
    if (payload.model !== undefined && payload.model_name !== undefined) throw new MediaError('INVALID_ARGUMENTS', 'model 和 model_name 不能同时传入；重新编辑请沿用原任务 model 和 source_task_id。');
    if (typeof payload.prompt !== 'string' || !payload.prompt.trim() || Buffer.byteLength(payload.prompt, 'utf8') > 32000 ||
        !Array.isArray(payload.materials) || payload.materials.length > 8) {
      throw new MediaError('INVALID_ARGUMENTS', '提示词最多 32000 个 UTF-8 字节，参考素材最多 8 个。');
    }
    const hash = payloadHash(payload);
    return this.store.withOperation(operation_id, async (state, save) => {
      if (state) {
        if (state.payload_hash !== hash) throw new MediaError('OPERATION_CONFLICT', '同一 operation_id 的素材、模型或参数已变化。请保留原操作；新创作使用新的操作 ID。');
        return { operation_id, ...state.quote, task_id: state.task_id || null, replay: true };
      }
      const quote = await this.client.request('POST', '/quotes', payload);
      if (typeof quote.quote_id !== 'string' || !quote.quote_id || !Number.isSafeInteger(quote.total_score) || quote.total_score < 0 || !quote.expires_at) throw new MediaError('INVALID_QUOTE', '报价缺少有效编号、积分或有效期。');
      const publicQuote = { quote_id: quote.quote_id, total_score: quote.total_score, expires_at: quote.expires_at,
        ...(quote.model ? {model: quote.model} : {}), ...(quote.selection ? {selection: quote.selection} : {}),
        ...(quote.effective_params ? {effective_params: quote.effective_params} : {}) };
      await save({ version: 1, operation_id, type: payload.type, payload_hash: hash, idempotency_key: randomUUID(), quote: publicQuote, state: 'quoted' });
      return { operation_id, ...publicQuote, replay: false };
    });
  }
  async getBatch(batchId) {
    if (!/^[A-Za-z0-9_.-]{1,160}$/.test(batchId)) throw new MediaError('INVALID_BATCH', '批次编号无效。');
    const batch = await this.client.request('GET', `/batches/${batchId}`);
    if (batch.batch_id !== batchId || !['pending', 'approved', 'denied', 'revoked'].includes(batch.status)) throw new MediaError('INVALID_RESPONSE', '网站批次状态与请求不一致。');
    return batch;
  }
  async createBatch({ operation_ids, max_total_score }) {
    if (!Array.isArray(operation_ids) || !operation_ids.length || operation_ids.length > 20 || new Set(operation_ids).size !== operation_ids.length || operation_ids.some(id => !/^[A-Za-z0-9_.-]{8,128}$/.test(id))) throw new MediaError('INVALID_ARGUMENTS', '批次需包含1–20个不重复的原始operation_id。');
    if (!Number.isSafeInteger(max_total_score) || max_total_score < 1) throw new MediaError('INVALID_ARGUMENTS', '批次积分上限无效。');
    const ids = [...operation_ids].sort();
    const localBatch = `batch-${payloadHash(ids).slice(0, 64)}`;
    return this.store.withOperation(localBatch, async (batch, saveBatch) => {
      if (batch && (batch.max_total_score !== max_total_score || JSON.stringify(batch.operation_ids) !== JSON.stringify(ids))) throw new MediaError('OPERATION_CONFLICT', '同组报价重试必须保留原批次预算。');
      if (batch?.response) return { ...batch.response, replay: true };
      const locked = [];
      const collect = async index => {
        if (index < ids.length) return this.store.withOperation(ids[index], async (state, save) => { locked.push({ state, save }); return collect(index + 1); });
        let total = 0; const quote_ids = [];
        for (const { state } of locked) {
          if (!state || state.state !== 'quoted' || state.task_id) throw new MediaError('BATCH_QUOTE_INVALID', '批次只能使用尚未提交的本机原报价；已提交或状态未知时恢复原操作。');
          const expiry = Number(state.quote?.expires_at); const milliseconds = expiry > 1e12 ? expiry : expiry * 1000;
          if (!Number.isFinite(milliseconds) || milliseconds <= Date.now()) throw new MediaError('QUOTE_EXPIRED', '批次包含过期报价；未提交的新创作需重新报价并核对总预算。');
          if (state.batch_operation && state.batch_operation !== localBatch) throw new MediaError('OPERATION_CONFLICT', '原报价已绑定其他批次，不能加入新批次。');
          total += state.quote.total_score; quote_ids.push(state.quote.quote_id);
        }
        if (!Number.isSafeInteger(total) || total > max_total_score) throw new MediaError('BUDGET_EXCEEDED', '汇总报价超过本次总预算。');
        batch ||= { version: 1, type: 'batch', operation_ids: ids, quote_ids, max_total_score, idempotency_key: randomUUID(), state: 'creating_batch' };
        await saveBatch(batch);
        for (const { state, save } of locked) await save({ ...state, batch_operation: localBatch });
        const response = await this.client.request('POST', '/batches', { quote_ids: batch.quote_ids, max_total_score, idempotency_key: batch.idempotency_key }, { headers: { 'Idempotency-Key': batch.idempotency_key } });
        if (!/^ab_[a-f0-9]{32}$/.test(response.batch_id) || !['pending', 'approved', 'denied', 'revoked'].includes(response.status) || typeof response.verification_url !== 'string') throw new MediaError('INVALID_RESPONSE', '网站批次响应不完整；保留原操作集合重试。');
        let url; try { url = new URL(response.verification_url); } catch { throw new MediaError('INVALID_RESPONSE', '批次确认网址无效。'); }
        if (url.origin !== this.client.config.baseUrl || url.username || url.password || url.pathname !== '/home/' || url.search || url.hash !== `#/ai-tool/authorize?batch=${response.batch_id}`) throw new MediaError('INVALID_RESPONSE', '批次确认网址不属于当前网站批次。');
        for (const { state, save } of locked) await save({ ...state, batch_operation: localBatch, batch_id: response.batch_id });
        await saveBatch({ ...batch, state: 'batch_created', response });
        return { ...response, replay: false };
      };
      return collect(0);
    });
  }
  async submit(type, { operation_id, max_score, batch_id }) {
    return this.store.withOperation(operation_id, async (state, save) => {
      if (!state) throw new MediaError('QUOTE_REQUIRED', '先用同一 operation_id 调用 quote_generation。');
      if (state.type !== type) throw new MediaError('TYPE_MISMATCH', '工具类型与原报价不一致。');
      if (!Number.isSafeInteger(max_score) || max_score < 1 || state.quote.total_score > max_score) throw new MediaError('BUDGET_EXCEEDED', '报价超过本次授权积分上限。');
      if (state.max_score !== undefined && state.max_score !== max_score) throw new MediaError('OPERATION_CONFLICT', '重试必须保留原 max_score，不能修改已提交操作。');
      if (state.batch_operation && !state.batch_id) throw new MediaError('BATCH_CREATE_PENDING', '批次创建结果尚未完成保存；请用原operation_ids和总预算重试create_batch。');
      if (state.batch_id !== undefined && state.batch_id !== batch_id || state.max_score !== undefined && (state.batch_id || null) !== (batch_id || null)) throw new MediaError('OPERATION_CONFLICT', '提交和重试必须保留原batch_id。');
      if (state.task_id) return { operation_id, task_id: state.task_id, status: state.task_status, replay: true };
      // An uncertain submission must reach the gateway with its original identity:
      // server-side replay may recover an existing task even after batch revocation.
      if (batch_id && state.state !== 'submitting') {
        const batch = await this.getBatch(batch_id);
        if (batch.status !== 'approved') throw new MediaError('BATCH_NOT_APPROVED', '用户尚未在网站批准该批次；对话确认不能替代网站批准。');
      }
      // Persist before the network call, so loss of the response never creates a new billable identity.
      state = { ...state, max_score, ...(batch_id ? { batch_id } : {}), state: 'submitting' }; await save(state);
      let result;
      try {
        result = await this.client.request('POST', '/generations', { quote_id: state.quote.quote_id, max_score, idempotency_key: state.idempotency_key, ...(batch_id ? { batch_id } : {}) }, { headers: { 'Idempotency-Key': state.idempotency_key } });
      } catch (error) {
        if (error.code === 'AGENT_BATCH_CONSENT_REQUIRED' && !batch_id) {
          const quoted = { ...state, state: 'quoted' };
          delete quoted.max_score;
          await save(quoted);
        }
        throw error;
      }
      if (typeof result.task_id !== 'string' || !result.task_id || typeof result.status !== 'string') throw new MediaError('INVALID_RESPONSE', '提交响应缺少任务编号；保持原 operation_id 重试。');
      await save({ ...state, state: 'submitted', task_id: result.task_id, task_status: result.status });
      return { ...result, operation_id, replay: false };
    });
  }
  async wait({ task_id, max_wait_seconds = 20 }) {
    if (!Number.isInteger(max_wait_seconds) || max_wait_seconds < 1 || max_wait_seconds > 30) throw new MediaError('INVALID_WAIT', '轮询时间须在 1–30 秒内。');
    const deadline = Date.now() + max_wait_seconds * 1000;
    let result;
    for (let attempt = 0; attempt < 10 && Date.now() < deadline; attempt++) {
      result = await this.client.task(task_id, Math.max(1, deadline - Date.now()));
      if (['completed', 'succeeded', 'failed', 'cancelled', 'partial_succeeded', 'unknown', 'reconciling'].includes(result.status)) return result;
      const delay = Math.min(Math.max(1, Number(result.poll_after_seconds) || 2) * 1000, 5000, deadline - Date.now());
      if (delay <= 0) break;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    return { ...result, polling_stopped: true, message: '本次等待已结束；使用相同 task_id 稍后查询，不重新提交。' };
  }

  // Video upload is idempotent by operation_id: the file fingerprint and binding are persisted
  // before the first byte leaves the machine, so a lost response never creates a second asset.
  async uploadVideo({ operation_id, file_path, description }) {
    const prepared = await this.client.prepareVideoUpload(file_path);
    const contentHash = payloadHash({ file_sha256: prepared.sha256, size: prepared.size, description: description || '' });
    return this.store.withOperation(operation_id, async (state, save) => {
      if (state) {
        if (state.kind !== 'video_upload') throw new MediaError('OPERATION_CONFLICT', '同一 operation_id 已被其他类型的操作使用；请换新的操作 ID。');
        if (state.content_hash !== contentHash) throw new MediaError('OPERATION_CONFLICT', '同一 operation_id 的成片文件或说明已变化。请保留原文件重试；新成片使用新的操作 ID。');
        if (state.status === 'completed' && state.result) return { operation_id, status: 'completed', ...state.result, replay: true };
        if (!['uploading', 'upload_failed'].includes(state.status)) {
          throw new MediaError('INVALID_UPLOAD_STATE', '本地上传记录状态异常，请保留原 operation_id。');
        }
        let record;
        try {
          record = await this.client.uploadStatus(operation_id);
        } catch (error) {
          if (!(error instanceof MediaError && ['AGENT_UPLOAD_NOT_FOUND', 'UPLOAD_NOT_FOUND'].includes(error.code))) throw error;
          // Only explicit absence from the upload ledger permits retry.
          record = { operation_id, status: 'failed' };
        }
        if (record?.operation_id !== operation_id) throw invalidUploadResponse();
        if (record.status === 'completed') {
          assertUploadedAsset(record.asset, prepared.sha256);
          await save({ ...state, status: 'completed', result: record.asset });
          return { ...record.asset, operation_id, status: 'completed', replay: true };
        }
        if (record.status === 'processing') {
          if (record.stale === undefined || record.stale === false) return processingUpload(operation_id);
          if (record.stale !== true) throw invalidUploadResponse();
        } else if (record.status !== 'failed' || record.stale !== undefined) {
          throw invalidUploadResponse();
        }
      }
      const idempotencyKey = state?.idempotency_key || randomUUID();
      const baseState = { version: 1, kind: 'video_upload', operation_id, content_hash: contentHash,
        file_sha256: prepared.sha256, size: prepared.size, description: description || '',
        idempotency_key: idempotencyKey, status: 'uploading' };
      await save(baseState);
      try {
        const result = await this.client.uploadVideoFile(prepared, { operationId: operation_id, description, idempotencyKey });
        if (result?.operation_id !== undefined && result.operation_id !== operation_id) throw invalidUploadResponse();
        if (result?.status === 'processing') {
          if (result.operation_id !== operation_id || (result.stale !== undefined && typeof result.stale !== 'boolean')) throw invalidUploadResponse();
          // The existing "uploading" record is intentionally left intact for the next GET.
          return processingUpload(operation_id);
        }
        // 0.8.0 could return the completed asset directly without a status field.
        if (result?.status !== undefined && result.status !== 'completed') throw invalidUploadResponse();
        assertUploadedAsset(result, prepared.sha256);
        await save({ ...baseState, status: 'completed', result });
        return { ...result, operation_id, status: 'completed', replay: result.replay === true };
      } catch (error) {
        await save({ ...baseState, status: 'upload_failed', error: safeError(error) }).catch(() => {});
        throw error;
      }
    });
  }
}
