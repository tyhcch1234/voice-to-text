/* Whisper 語音轉文字 — Web Worker
 * 所有解碼後嘅音訊同辨識結果都只會喺呢個 worker 內處理，唔會離開瀏覽器。
 */
import {
  pipeline,
  WhisperTextStreamer,
  env,
} from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5';

env.allowLocalModels = false;
env.useBrowserCache = true;

const MODEL_IDS = {
  tiny: 'Xenova/whisper-tiny',
  base: 'Xenova/whisper-base',
  small: 'Xenova/whisper-small',
};

/** 已載入嘅 pipeline：同一時間只保留一個模型，避免手機記憶體爆掉 */
let cache = { key: null, pipe: null, backend: null };

function post(msg) {
  self.postMessage(msg);
}

function makeProgressReporter(jobId, modelKey) {
  const sizes = new Map();
  let lastEmit = 0;
  return (p) => {
    if (!p || !p.file) return;
    if (p.status === 'progress' && p.total) {
      sizes.set(p.file, { l: p.loaded || 0, t: p.total });
    } else if (p.status === 'done' && sizes.has(p.file)) {
      const v = sizes.get(p.file);
      sizes.set(p.file, { l: v.t, t: v.t });
    } else {
      return;
    }
    let loaded = 0;
    let total = 0;
    for (const v of sizes.values()) { loaded += v.l; total += v.t; }
    const now = Date.now();
    if (now - lastEmit < 120) return;
    lastEmit = now;
    post({
      type: 'model-progress',
      jobId,
      model: modelKey,
      ratio: total ? Math.min(1, loaded / total) : 0,
      loaded,
      total,
    });
  };
}

/** 依序嘗試可用的運算後端（WebGPU → WASM），失敗就退回下一個 */
async function loadModel(modelKey, jobId, preferGpu) {
  const candidates = [];
  if (preferGpu && self.navigator && self.navigator.gpu) {
    candidates.push({
      backend: 'webgpu',
      opts: { device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } },
    });
  }
  candidates.push({ backend: 'wasm', opts: { device: 'wasm', dtype: 'q8' } });

  const cacheKey = `${modelKey}:${preferGpu ? 'gpu' : 'cpu'}`;
  if (cache.pipe && cache.key === cacheKey) {
    post({ type: 'ready', jobId, backend: cache.backend, model: modelKey, cached: true });
    return cache;
  }

  if (cache.pipe) {
    try { await cache.pipe.dispose?.(); } catch (_) { /* ignore */ }
    cache = { key: null, pipe: null, backend: null };
  }

  let lastErr = null;
  for (const c of candidates) {
    try {
      post({ type: 'model-start', jobId, model: modelKey, backend: c.backend });
      const pipe = await pipeline('automatic-speech-recognition', MODEL_IDS[modelKey], {
        ...c.opts,
        progress_callback: makeProgressReporter(jobId, modelKey),
      });
      cache = { key: cacheKey, pipe, backend: c.backend };
      post({ type: 'model-progress', jobId, model: modelKey, ratio: 1, loaded: 1, total: 1 });
      post({ type: 'ready', jobId, backend: c.backend, model: modelKey, cached: false });
      return cache;
    } catch (err) {
      lastErr = err;
      post({ type: 'notice', jobId, message: `${c.backend} 初始化失敗，改用備用後端` });
    }
  }
  throw lastErr || new Error('模型載入失敗');
}

async function transcribe(entry, { jobId, lang, samples, duration }) {
  const { pipe } = entry;
  const total = duration || samples.length / 16000;
  let reported = -1;

  const report = (t) => {
    const ratio = Math.max(0, Math.min(0.985, t / total));
    if (ratio - reported < 0.004) return;
    reported = ratio;
    post({ type: 'progress', jobId, ratio });
  };

  let streamer = null;
  try {
    streamer = new WhisperTextStreamer(pipe.tokenizer, {
      on_chunk_start: (t) => report(t),
      on_chunk_end: (t) => report(t),
    });
  } catch (_) {
    streamer = null;
  }

  const options = {
    task: 'transcribe',
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: true,
  };
  if (lang && lang !== 'auto') options.language = lang;
  if (streamer) options.streamer = streamer;

  const startedAt = Date.now();
  const output = await pipe(samples, options);
  return {
    text: output.text || '',
    chunks: output.chunks || [],
    ms: Date.now() - startedAt,
  };
}

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  if (msg.type !== 'transcribe') return;

  const { jobId, model, lang, samples, duration, preferGpu } = msg;

  try {
    const entry = await loadModel(model, jobId, !!preferGpu);
    post({ type: 'backend', jobId, backend: entry.backend });

    let result;
    try {
      result = await transcribe(entry, { jobId, lang, samples, duration });
    } catch (err) {
      // WebGPU 有機會喺個別裝置上跑到一半先出錯 → 退回 WASM 重試一次
      if (entry.backend === 'webgpu') {
        post({ type: 'notice', jobId, message: 'WebGPU 執行出錯，改用 CPU 重新處理' });
        const fallback = await loadModel(model, jobId, false);
        post({ type: 'backend', jobId, backend: fallback.backend });
        result = await transcribe(fallback, { jobId, lang, samples, duration });
      } else {
        throw err;
      }
    }

    post({ type: 'done', jobId, ...result });
  } catch (err) {
    post({
      type: 'failed',
      jobId,
      message: (err && err.message) ? String(err.message) : String(err),
    });
  }
};
