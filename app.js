/* 語音轉文字 — 前端控制（解碼音訊、排隊、顯示結果） */
(function () {
  'use strict';

  const MAX_MINUTES = 45;          // 單一檔案上限（瀏覽器記憶體考量）
  // Whisper 只有「中文」token，冇獨立粵語 token → 廣東話用 zh 處理
  const LANG_MAP = { yue: 'zh', en: 'en', zh: 'zh' };
  const MODEL_LABEL = { tiny: '輕量', base: '標準', small: '高精度' };

  const state = {
    lang: 'yue',
    model: 'base',
    toTrad: true,
    preferGpu: false,
    queue: [],
    jobs: new Map(),
    running: false,
    seq: 0,
    worker: null,
    pending: new Map(),
    opencc: null,
  };

  const els = {
    drop: document.getElementById('drop'),
    fileInput: document.getElementById('fileInput'),
    queue: document.getElementById('queue'),
    statusbar: document.getElementById('statusbar'),
    sbText: document.getElementById('sbText'),
    sbMeta: document.getElementById('sbMeta'),
    sbSpinner: document.getElementById('sbSpinner'),
    toTrad: document.getElementById('toTrad'),
    tips: document.getElementById('tips'),
  };

  /* ---------------- 小工具 ---------------- */

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const s = Math.floor(sec % 60);
    const m = Math.floor((sec / 60) % 60);
    const h = Math.floor(sec / 3600);
    const p = (v) => String(v).padStart(2, '0');
    return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
  }

  function fmtBytes(bytes) {
    if (!bytes) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = bytes;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function baseName(name) {
    return name.replace(/\.[^.]+$/, '') || 'transcript';
  }

  function download(filename, content, mime) {
    const blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  /* ---------------- 音訊解碼 ---------------- */

  async function resampleTo16k(data, inRate) {
    const outLen = Math.max(1, Math.round((data.length * 16000) / inRate));
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OAC) throw new Error('此瀏覽器不支援音訊重採樣，請改用 Chrome / Edge / Safari。');
    const ctx = new OAC(1, outLen, 16000);
    const buf = ctx.createBuffer(1, data.length, inRate);
    if (buf.copyToChannel) buf.copyToChannel(data, 0);
    else buf.getChannelData(0).set(data);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start();
    const rendered = await ctx.startRendering();
    return rendered.getChannelData(0).slice();
  }

  async function decodeFile(file) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('此瀏覽器不支援 Web Audio API，請改用 Chrome / Edge / Safari。');

    let raw;
    try {
      raw = await file.arrayBuffer();
    } catch (e) {
      throw new Error('讀取檔案失敗，請再試一次。');
    }

    let ctx;
    try {
      ctx = new AC({ sampleRate: 16000 });
    } catch (e) {
      ctx = new AC();
    }
    if (ctx.state === 'suspended') {
      try { await ctx.resume(); } catch (e) { /* ignore */ }
    }

    let buf;
    try {
      buf = await ctx.decodeAudioData(raw);
    } catch (e) {
      ctx.close && ctx.close();
      throw new Error('無法解碼呢個音訊檔。iPhone 錄音請用 .m4a，或先轉做 mp3 / wav。');
    }

    const ch = buf.numberOfChannels;
    const len = buf.length;
    let mono;
    if (ch === 1) {
      mono = buf.getChannelData(0).slice();
    } else {
      mono = new Float32Array(len);
      for (let c = 0; c < ch; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < len; i++) mono[i] += d[i] / ch;
      }
    }

    let samples = mono;
    if (buf.sampleRate !== 16000) samples = await resampleTo16k(mono, buf.sampleRate);
    ctx.close && ctx.close();

    const duration = samples.length / 16000;
    if (duration < 0.4) throw new Error('錄音太短，未能辨識。');
    if (duration > MAX_MINUTES * 60) {
      throw new Error(`錄音長過 ${MAX_MINUTES} 分鐘，瀏覽器記憶體未必負荷得到，請先分段。`);
    }
    return { samples, duration };
  }

  /* ---------------- OpenCC（簡轉繁） ---------------- */

  function loadOpenCC() {
    if (window.OpenCC) return Promise.resolve(window.OpenCC);
    if (state.opencc) return state.opencc;
    state.opencc = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/opencc-js@1.0.5/dist/umd/full.js';
      s.async = true;
      s.onload = () => resolve(window.OpenCC);
      s.onerror = () => reject(new Error('OpenCC 載入失敗'));
      document.head.appendChild(s);
    }).catch(() => null);
    return state.opencc;
  }

  async function toTraditional(text) {
    if (!state.toTrad || !text) return text;
    const OpenCC = await loadOpenCC();
    if (!OpenCC || !OpenCC.Converter) return text;
    try {
      const conv = toTraditional._conv || (toTraditional._conv = OpenCC.Converter({ from: 'cn', to: 'hk' }));
      return conv(text);
    } catch (e) {
      try {
        const conv = toTraditional._convT || (toTraditional._convT = OpenCC.Converter({ from: 'cn', to: 'tw' }));
        return conv(text);
      } catch (e2) {
        return text;
      }
    }
  }

  /* ---------------- Worker ---------------- */

  function getWorker() {
    if (state.worker) return state.worker;
    const w = new Worker('worker.js', { type: 'module' });
    w.onmessage = (ev) => handleWorkerMessage(ev.data || {});
    w.onerror = (e) => {
      const msg = e.message || 'Worker 執行出錯';
      for (const [, p] of state.pending) p.reject(new Error(msg));
      state.pending.clear();
      state.worker = null;
    };
    state.worker = w;
    return w;
  }

  function handleWorkerMessage(d) {
    const job = state.jobs.get(d.jobId);
    if (!job) return;

    if (d.type === 'failed') {
      const p = state.pending.get(d.jobId);
      if (p) { state.pending.delete(d.jobId); p.reject(new Error(d.message || '辨識失敗')); }
      return;
    }

    if (d.type === 'done') {
      const p = state.pending.get(d.jobId);
      if (p) { state.pending.delete(d.jobId); p.resolve(d); }
      return;
    }

    if (d.type === 'model-start' || d.type === 'model-progress' || d.type === 'ready') {
      job.stage = 'model';
      job.backend = d.backend || job.backend;
      if (typeof d.ratio === 'number') job.ratio = d.ratio;
      paintJob(job);
      setStatus(`下載 AI 模型（${MODEL_LABEL[state.model]}）…`, `${Math.round((job.ratio || 0) * 100)}%`);
      return;
    }

    if (d.type === 'progress') {
      job.stage = 'transcribe';
      job.ratio = d.ratio || 0;
      paintProgress(job);
      setStatus(
        `轉錄中 · ${job.name}`,
        `${fmtTime(job.ratio * (job.duration || 0))} / ${fmtTime(job.duration || 0)}`
      );
      return;
    }

    if (d.type === 'backend') {
      job.backend = d.backend;
      return;
    }

    if (d.type === 'notice') {
      job.notice = d.message;
    }
  }

  function askWorker(message, transfer) {
    const w = getWorker();
    return new Promise((resolve, reject) => {
      state.pending.set(message.jobId, { resolve, reject });
      w.postMessage(message, transfer || []);
    });
  }

  /* ---------------- 卡片 UI ---------------- */

  const ICON_FILE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V6l10-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/></svg>';
  const ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

  function createCard(job) {
    const card = el('article', 'card');
    card.dataset.id = job.id;

    const head = el('div', 'card-head');
    const icon = el('div', 'file-icon');
    icon.innerHTML = ICON_FILE;

    const meta = el('div', 'file-meta');
    const name = el('div', 'file-name', job.name);
    name.title = job.name;
    const sub = el('div', 'file-sub', fmtBytes(job.size));
    meta.append(name, sub);

    const badge = el('span', 'state queued', '排隊中');
    const remove = el('button', 'icon-btn');
    remove.type = 'button';
    remove.title = '移除';
    remove.innerHTML = ICON_X;
    remove.addEventListener('click', () => removeJob(job));

    head.append(icon, meta, badge, remove);

    const prog = el('div', 'progress');
    const bar = el('div', 'bar');
    prog.appendChild(bar);

    const err = el('div', 'error-msg');
    err.hidden = true;

    const transcript = el('div', 'transcript');
    transcript.hidden = true;

    const actions = el('div', 'card-actions');
    actions.hidden = true;

    card.append(head, prog, err, transcript, actions);
    job.dom = { card, badge, sub, prog, bar, err, transcript, actions, remove };
    return card;
  }

  function stateLabel(job) {
    switch (job.status) {
      case 'queued': return '排隊中';
      case 'decoding': return '解碼中';
      case 'running':
        if (job.stage === 'model') return `下載模型 ${Math.round((job.ratio || 0) * 100)}%`;
        return `轉錄 ${Math.round((job.ratio || 0) * 100)}%`;
      case 'done': return '完成';
      case 'error': return '失敗';
      default: return '';
    }
  }

  function paintProgress(job) {
    if (!job.dom) return;
    const { prog, bar } = job.dom;

    if (job.status === 'done') {
      prog.classList.remove('indeterminate');
      bar.style.width = '100%';
      return;
    }
    if (job.status === 'decoding') {
      prog.classList.add('indeterminate');
      return;
    }
    if (job.status === 'running') {
      prog.classList.remove('indeterminate');
      bar.style.width = `${Math.max(2, Math.min(100, (job.ratio || 0) * 100))}%`;
      return;
    }
    prog.classList.remove('indeterminate');
    bar.style.width = '0%';
  }

  function paintJob(job) {
    if (!job.dom) return;
    const { badge, sub, err, transcript, actions, prog, bar } = job.dom;

    badge.textContent = stateLabel(job);
    badge.className = `state ${
      job.status === 'done' ? 'done'
        : job.status === 'error' ? 'error'
        : job.status === 'running' || job.status === 'decoding' ? 'running'
        : 'queued'
    }`;

    const bits = [fmtBytes(job.size)];
    if (job.duration) bits.push(fmtTime(job.duration));
    if (job.backend) bits.push(job.backend === 'webgpu' ? 'GPU 加速' : 'CPU');
    if (job.status === 'done' && job.ms) bits.push(`用了 ${fmtTime(job.ms / 1000)}`);
    sub.textContent = bits.join(' · ');

    err.hidden = !job.error;
    err.textContent = job.error || '';

    paintProgress(job);

    transcript.hidden = !job.rendered;
    actions.hidden = !job.rendered;
  }

  function renderTranscript(job, segments) {
    const { transcript, actions } = job.dom;
    transcript.innerHTML = '';

    const showTs = segments.filter((s) => s.start != null).length > 1;
    for (const seg of segments) {
      const line = el('span', 'seg');
      if (showTs && seg.start != null) line.appendChild(el('span', 'ts', fmtTime(seg.start)));
      line.appendChild(document.createTextNode(seg.text));
      transcript.appendChild(line);
    }
    transcript.hidden = false;

    actions.innerHTML = '';
    const mk = (label, fn) => {
      const b = el('button', 'btn', label);
      b.type = 'button';
      b.addEventListener('click', fn);
      return b;
    };

    const copyBtn = mk('複製全部', async () => {
      try {
        await navigator.clipboard.writeText(job.plainText || '');
        copyBtn.textContent = '已複製 ✓';
        copyBtn.classList.add('copied');
        setTimeout(() => { copyBtn.textContent = '複製全部'; copyBtn.classList.remove('copied'); }, 1600);
      } catch (e) {
        const ta = document.createElement('textarea');
        ta.value = job.plainText || '';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch (e2) { /* ignore */ }
        ta.remove();
      }
    });

    actions.append(
      copyBtn,
      mk('下載 TXT', () => download(`${baseName(job.name)}.txt`, job.plainText || '')),
      mk('下載 SRT', () => download(`${baseName(job.name)}.srt`, job.srt || '', 'application/x-subrip;charset=utf-8'))
    );
    actions.hidden = false;
  }

  function buildSrt(segments) {
    const p = (v) => String(v).padStart(2, '0');
    const ts = (sec) => {
      const s = Math.max(0, sec);
      const ms = Math.round((s - Math.floor(s)) * 1000);
      const total = Math.floor(s);
      return `${p(Math.floor(total / 3600))}:${p(Math.floor((total % 3600) / 60))}:${p(total % 60)},${String(ms).padStart(3, '0')}`;
    };
    return segments.map((seg, i) => {
      const start = seg.start ?? 0;
      const end = seg.end ?? (segments[i + 1] ? segments[i + 1].start : start + 3);
      return `${i + 1}\n${ts(start)} --> ${ts(end)}\n${seg.text}\n`;
    }).join('\n');
  }

  /* ---------------- 佇列 ---------------- */

  function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    for (const file of files) {
      const job = {
        id: `job-${++state.seq}`,
        file,
        name: file.name || '錄音',
        size: file.size,
        status: 'queued',
        stage: null,
        ratio: 0,
        duration: 0,
        error: null,
        rendered: false,
        dom: null,
      };
      state.queue.push(job);
      state.jobs.set(job.id, job);
      const card = createCard(job);
      els.queue.appendChild(card);
      paintJob(job);
    }
    els.tips.hidden = true;
    processQueue();
  }

  function removeJob(job) {
    if (job.status === 'running' || job.status === 'decoding') {
      // 進行中嘅工作唔可以中途移除，避免 worker 同畫面狀態不同步
      job.dom.badge.textContent = '處理中…';
      setTimeout(() => paintJob(job), 1200);
      return;
    }
    if (job.dom && job.dom.card) job.dom.card.remove();
    state.jobs.delete(job.id);
    const i = state.queue.indexOf(job);
    if (i >= 0) state.queue.splice(i, 1);
    if (!state.queue.length) els.tips.hidden = false;
  }

  async function processQueue() {
    if (state.running) return;
    state.running = true;
    showStatus(true);
    try {
      for (;;) {
        const job = state.queue.find((j) => j.status === 'queued');
        if (!job) break;
        await runJob(job);
      }
    } finally {
      state.running = false;
      showStatus(false);
      const doneCount = state.queue.filter((j) => j.status === 'done').length;
      const errCount = state.queue.filter((j) => j.status === 'error').length;
      if (doneCount || errCount) {
        setStatus(
          `完成 ${doneCount} 個檔案${errCount ? `，${errCount} 個失敗` : ''}`,
          '',
          true
        );
      } else {
        hideStatus();
      }
    }
  }

  async function runJob(job) {
    job.status = 'decoding';
    job.stage = null;
    job.error = null;
    job.dom.prog.classList.add('indeterminate');
    paintJob(job);
    setStatus(`解碼音訊 · ${job.name}`, '');

    let audio;
    try {
      audio = await decodeFile(job.file);
    } catch (e) {
      failJob(job, e.message);
      return;
    }

    job.duration = audio.duration;
    job.status = 'running';
    job.stage = 'model';
    job.ratio = 0;
    job.dom.prog.classList.remove('indeterminate');
    job.dom.bar.style.width = '2%';
    paintJob(job);
    setStatus(`準備模型 · ${job.name}`, fmtTime(audio.duration));

    try {
      const res = await askWorker(
        {
          type: 'transcribe',
          jobId: job.id,
          model: state.model,
          lang: LANG_MAP[state.lang],
          samples: audio.samples,
          duration: audio.duration,
          preferGpu: state.preferGpu,
        },
        [audio.samples.buffer]
      );
      await finishJob(job, res);
    } catch (e) {
      failJob(job, e && e.message ? e.message : '辨識失敗');
    }
  }

  async function finishJob(job, res) {
    const raw = (res.chunks || []).filter((c) => c && c.text);
    const segments = [];

    const NOISE = /^[\[(](silence|music|applause|noise|laughter|blank_audio|inaudible)/i;

    for (const c of raw) {
      const t = String(c.text).replace(/\s+/g, ' ').trim();
      if (!t || NOISE.test(t)) continue;
      segments.push({
        start: Array.isArray(c.timestamp) ? c.timestamp[0] : null,
        end: Array.isArray(c.timestamp) ? c.timestamp[1] : null,
        raw: t,
      });
    }

    if (!segments.length) {
      const whole = String(res.text || '').replace(/\s+/g, ' ').trim();
      if (!whole || NOISE.test(whole)) {
        failJob(job, '冇辨識到任何語音，可能係靜音或者錄音太細聲。');
        return;
      }
      segments.push({ start: 0, end: job.duration, raw: whole });
    }

    for (const seg of segments) seg.text = await toTraditional(seg.raw);

    job.segments = segments;
    job.plainText = segments.map((s) => s.text).join('\n');
    job.srt = buildSrt(segments);
    job.status = 'done';
    job.rendered = true;
    job.ms = res.ms;

    renderTranscript(job, segments);
    paintJob(job);
  }

  function failJob(job, message) {
    job.status = 'error';
    job.error = message;
    job.dom.prog.classList.remove('indeterminate');
    job.dom.bar.style.width = '0%';
    paintJob(job);
  }

  /* ---------------- 狀態列 ---------------- */

  function showStatus(spinning) {
    els.statusbar.hidden = false;
    els.sbSpinner.classList.toggle('idle', !spinning);
    els.sbSpinner.classList.toggle('hidden', !spinning);
  }

  function hideStatus() {
    els.statusbar.hidden = true;
  }

  function setStatus(text, meta, idle) {
    showStatus(!idle);
    els.sbText.textContent = text || '';
    els.sbMeta.textContent = meta || '';
  }

  /* ---------------- 設定 ---------------- */

  function bindSegment(group, key, onChange) {
    const root = document.querySelector(`.segmented[data-group="${group}"]`);
    if (!root) return;
    root.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-value]');
      if (!btn || btn.classList.contains('active')) return;
      root.querySelectorAll('button').forEach((b) => {
        b.classList.toggle('active', b === btn);
        b.setAttribute('aria-pressed', b === btn ? 'true' : 'false');
      });
      state[key] = btn.dataset.value;
      if (onChange) onChange(btn.dataset.value);
    });
  }

  els.toTrad.addEventListener('change', () => {
    state.toTrad = els.toTrad.checked;
    for (const job of state.queue) {
      if (job.status === 'done' && job.segments) {
        (async () => {
          for (const seg of job.segments) {
            seg.text = await toTraditional(seg.raw);
          }
          job.plainText = job.segments.map((s) => s.text).join('\n');
          job.srt = buildSrt(job.segments);
          renderTranscript(job, job.segments);
        })();
      }
    }
  });

  /* ---------------- 檔案輸入 ---------------- */

  els.drop.addEventListener('click', () => els.fileInput.click());
  els.drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      els.fileInput.click();
    }
  });
  els.fileInput.addEventListener('change', (e) => {
    addFiles(e.target.files);
    e.target.value = '';
  });

  ['dragenter', 'dragover'].forEach((t) => {
    els.drop.addEventListener(t, (e) => {
      e.preventDefault();
      els.drop.classList.add('drag');
    });
  });
  ['dragleave', 'dragend'].forEach((t) => {
    els.drop.addEventListener(t, () => els.drop.classList.remove('drag'));
  });
  els.drop.addEventListener('drop', (e) => {
    e.preventDefault();
    els.drop.classList.remove('drag');
    if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
  });

  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  /* ---------------- 啟動 ---------------- */

  bindSegment('lang', 'lang', (v) => {
    if (v === 'yue' && state.model === 'tiny') {
      setStatus('廣東話建議改用「標準」或「高精度」模型，效果會好啲。', '', true);
      setTimeout(() => { if (!state.running) hideStatus(); }, 5200);
    }
  });
  bindSegment('model', 'model');

  // 先確認真係拎到 GPU adapter，避免無謂地試 WebGPU 再失敗
  (async () => {
    try {
      if (!navigator.gpu || !navigator.gpu.requestAdapter) return;
      const adapter = await navigator.gpu.requestAdapter();
      state.preferGpu = !!adapter;
    } catch (e) {
      state.preferGpu = false;
    }
  })();
  window.addEventListener('pagehide', () => {
    if (state.worker) { state.worker.terminate(); state.worker = null; }
  });
})();
