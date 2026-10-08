(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const api = window.api || null;   // missing only when opened in a plain browser
  const stage = $('#stage');
  const flashEl = $('#flash');
  const state = { paused: false, blackout: false, overlay: false, acked: false, fps: 60, scale: 1, auto: false };
  const effFps = () => (state.overlay && state.auto) ? (state.fps === 0 ? 30 : Math.min(state.fps, 30)) : state.fps;
  const effScale = () => (state.overlay && state.auto) ? Math.min(state.scale, 0.5) : state.scale;
  const layers = [];

  const hexToRgb = (h) => {
    const n = parseInt(h.slice(1), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  };

  const fmtTime = (t) => {
    if (!isFinite(t) || t < 0) t = 0;
    const s = Math.floor(t), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
  };

  const fileUrl = (p) => 'file:///' + p.replace(/\\/g, '/').split('/')
    .map((seg, i) => (i === 0 && /^[A-Za-z]:$/.test(seg)) ? seg : encodeURIComponent(seg)).join('/');

  function toEmbedUrl(raw) {
    let text = raw.trim();
    if (!/^https?:\/\//i.test(text)) text = 'https://' + text;
    try {
      const u = new URL(text);
      const host = u.hostname.replace(/^www\./, '');
      let id = null;
      if (host === 'youtu.be') id = u.pathname.slice(1);
      else if (host === 'youtube.com' || host === 'm.youtube.com') {
        if (u.pathname === '/watch') id = u.searchParams.get('v');
        else if (u.pathname.startsWith('/embed/') || u.pathname.startsWith('/shorts/')) id = u.pathname.split('/')[2];
      }
      const list = u.searchParams.get('list');
      if (list && (host.includes('youtube.com') || host === 'youtu.be')) {
        return `https://www.youtube.com/embed/${id || 'videoseries'}?list=${encodeURIComponent(list)}&autoplay=1&loop=1&rel=0`;
      }
      if (id) return `https://www.youtube.com/embed/${id}?autoplay=1&loop=1&playlist=${id}&rel=0&playsinline=1`;
    } catch (_) { /* fall through */ }
    return text;
  }

  function toast(msg, ms = 7000) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { t.hidden = true; }, ms);
  }

  // ---------------------------------------------------------------- Layers
  const SKIP_GENERIC = ['source', 'fileInput', 'urlInput', 'fileSeek', 'webSeek'];
  const SKIP_SNAPSHOT = ['fileInput', 'fileSeek', 'webSeek'];

  class Layer {
    constructor(index) {
      this.index = index;
      this.cur = null;
      this.media = null;          // { name, path, file }
      this.objectUrl = null;
      this.timer = null;
      this.seekTimer = null;
      this.seeking = false;
      this.ab = { a: null, b: null };
      this.webTick = 0;

      this.root = document.createElement('div');
      this.root.className = 'layer';
      this.root.style.zIndex = String(index + 1);
      stage.insertBefore(this.root, flashEl);

      this.ui = $('#layerTpl').content.firstElementChild.cloneNode(true);
      $('#layers').appendChild(this.ui);
      this.q('title').textContent = index === 0 ? 'Layer 1 (bottom)' : 'Layer 2 (top)';
      this.wire();
      this.refreshOutputs();
    }

    q(k) { return this.ui.querySelector(`[data-k="${k}"]`); }

    v(k) {
      const e = this.q(k);
      if (e.type === 'checkbox') return e.checked;
      if (e.type === 'range') return parseFloat(e.value);
      return e.value;
    }

    refreshOutputs() {
      this.ui.querySelectorAll('input[type="range"]').forEach((r) => {
        const out = r.parentElement.querySelector('output');
        if (out) out.textContent = r.value;
      });
    }

    wire() {
      this.ui.querySelectorAll('input, select').forEach((el) => {
        if (SKIP_GENERIC.includes(el.dataset.k)) return;
        el.addEventListener('input', () => { this.refreshOutputs(); this.apply(); });
      });
      this.q('source').addEventListener('change', () => this.setSource(this.v('source')));
      this.q('fileBtn').addEventListener('click', () => this.q('fileInput').click());
      this.q('fileInput').addEventListener('change', (e) => {
        const f = e.target.files[0];
        if (f) this.loadFile(f);
        e.target.value = '';
      });
      this.q('urlGo').addEventListener('click', () => this.setSource('url'));
      this.q('urlInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') this.setSource('url'); });

      for (const k of ['fileSeek', 'webSeek']) {
        const el = this.q(k);
        el.addEventListener('pointerdown', () => { this.seeking = true; });
        el.addEventListener('input', () => this.seekTo(parseFloat(el.value) / 1000));
        el.addEventListener('change', () => { this.seeking = false; });
        el.addEventListener('pointerup', () => { this.seeking = false; });
      }
      this.q('abA').addEventListener('click', () => this.setAB('a'));
      this.q('abB').addEventListener('click', () => this.setAB('b'));
      this.q('abClear').addEventListener('click', () => { this.ab = { a: null, b: null }; this.updateAB(); });
    }

    // ---- sources
    loadFile(file) {
      const path = api && api.getPath ? api.getPath(file) : '';
      this.media = { name: file.name, path, file };
      this.q('fileName').textContent = file.name;
      this.q('source').value = 'file';
      this.setSource('file');
    }

    setSource(type) {
      this.teardown();
      this.ab = { a: null, b: null };
      this.updateAB();
      this.ui.querySelectorAll('[data-g]').forEach((g) => { g.hidden = g.dataset.g !== type; });
      if (type === 'spiral') this.buildSpiral();
      else if (type === 'file' && this.media) this.buildFile();
      else if (type === 'url' && this.q('urlInput').value.trim()) this.buildUrl(this.q('urlInput').value);
      this.apply();
    }

    teardown() {
      const c = this.cur;
      if (c) {
        if (c.r) c.r.stop();
        if (c.ro) c.ro.disconnect();
        if (c.node) c.node.remove();
      }
      if (this.objectUrl) { URL.revokeObjectURL(this.objectUrl); this.objectUrl = null; }
      clearInterval(this.timer);
      clearInterval(this.seekTimer);
      this.cur = null;
      this.root.style.pointerEvents = 'none';
    }

    buildSpiral() {
      const canvas = document.createElement('canvas');
      canvas.className = 'fill';
      this.root.appendChild(canvas);
      const r = new SpiralRenderer(canvas);
      r.fps = effFps();
      r.scale = effScale();
      const ro = new ResizeObserver(() => r.resize());
      ro.observe(canvas);
      this.cur = { type: 'spiral', node: canvas, r, ro };
      if (!r.ok) console.error('WebGL is not available for the spiral layer.');
      if (!state.paused) r.start();
    }

    buildFile() {
      const m = this.media;
      const vid = document.createElement('video');
      vid.className = 'fill';
      if (m.path) vid.src = fileUrl(m.path);
      else if (m.file) { this.objectUrl = URL.createObjectURL(m.file); vid.src = this.objectUrl; }
      vid.loop = true;
      vid.playsInline = true;
      vid.addEventListener('error', () => toast(`Couldn't play "${m.name}". Choose the video again.`));
      this.root.appendChild(vid);
      this.cur = { type: 'file', node: vid };
      this.q('fileName').textContent = m.name;
      if (!state.paused) vid.play().catch(() => {});
      this.seekTimer = setInterval(() => this.tick(), 200);
    }

    buildUrl(raw) {
      const wv = document.createElement('webview');
      wv.className = 'fill';
      const ua = navigator.userAgent.replace(/ Electron\/\S+/, '').replace(/ spiral-stage\/\S+/, '');
      wv.setAttribute('useragent', ua);
      wv.setAttribute('src', toEmbedUrl(raw));
      const status = this.q('status');
      status.textContent = 'Loading…';
      const c = { type: 'url', node: wv, ready: false };
      wv.addEventListener('dom-ready', () => { c.ready = true; status.textContent = ''; this.pokeWeb(); });
      wv.addEventListener('did-fail-load', (e) => {
        if (e.errorCode === -3 || !e.isMainFrame) return;
        status.textContent = `Couldn't load this page (${e.errorDescription}).`;
      });
      this.root.appendChild(wv);
      this.cur = c;
      this.timer = setInterval(() => this.pokeWeb(), 2000);
      this.seekTimer = setInterval(() => this.tick(), 250);
    }

    pokeWeb() {
      const c = this.cur;
      if (!c || c.type !== 'url' || !c.ready) return;
      const loop = this.v('forceLoop');
      const vol = this.v('webVolume');
      const act = state.paused ? 'v.pause()' : 'if(v.paused&&!v.ended){v.play().catch(function(){})}';
      const js = `document.querySelectorAll('video').forEach(function(v){v.loop=${loop};v.volume=${vol};${act}})`;
      try { c.node.executeJavaScript(js).catch(() => {}); } catch (_) { /* not ready */ }
    }

    // ---- seek bar and A-B loop
    tick() {
      const c = this.cur;
      if (!c) return;
      if (c.type === 'file') {
        const v = c.node;
        this.showTime('file', v.currentTime, v.duration);
        const { a, b } = this.ab;
        if (a != null && b != null && b > a && v.currentTime >= b) v.currentTime = a;
      } else if (c.type === 'url' && c.ready) {
        const js = '(function(){var v=document.querySelector("video");return v?[v.currentTime,v.duration]:null})()';
        try {
          c.node.executeJavaScript(js).then((r) => { if (r) this.showTime('web', r[0], r[1]); }).catch(() => {});
        } catch (_) { /* not ready */ }
      }
    }

    showTime(kind, t, d) {
      const slider = this.q(kind + 'Seek'), label = this.q(kind + 'Time');
      const live = !isFinite(d) || d <= 0;
      slider.disabled = live;
      label.textContent = live ? 'no length' : `${fmtTime(t)} / ${fmtTime(d)}`;
      if (!this.seeking && !live) slider.value = Math.round((t / d) * 1000);
    }

    seekTo(frac) {
      const c = this.cur;
      if (!c) return;
      if (c.type === 'file') {
        const d = c.node.duration;
        if (isFinite(d)) c.node.currentTime = frac * d;
      } else if (c.type === 'url' && c.ready) {
        const js = `(function(){var v=document.querySelector("video");if(v&&isFinite(v.duration)){v.currentTime=${frac}*v.duration}})()`;
        try { c.node.executeJavaScript(js).catch(() => {}); } catch (_) { /* not ready */ }
      }
    }

    setAB(which) {
      const c = this.cur;
      if (!c || c.type !== 'file') return;
      this.ab[which] = c.node.currentTime;
      this.updateAB();
    }

    updateAB() {
      const { a, b } = this.ab;
      const parts = [];
      if (a != null) parts.push('A ' + fmtTime(a));
      if (b != null) parts.push('B ' + fmtTime(b));
      let txt = parts.join('   ');
      if (a != null && b != null && b <= a) txt += '  (B must be after A)';
      this.q('abLabel').textContent = txt;
    }

    // ---- apply settings
    apply() {
      this.root.style.opacity = this.v('opacity');
      this.root.style.mixBlendMode = this.v('blend');
      const c = this.cur;
      if (!c) return;
      if (c.type === 'spiral') {
        Object.assign(c.r.params, {
          speed: this.v('speed'),
          arms: Math.round(this.v('arms')),
          twist: this.v('twist'),
          soft: this.v('soft'),
          pulse: this.v('pulse'),
          dir: this.v('reverse') ? -1 : 1,
          cut: state.overlay && this.v('cut'),
          a: hexToRgb(this.v('colorA')),
          b: hexToRgb(this.v('colorB'))
        });
        if (!c.r.running) c.r.draw();
      } else if (c.type === 'file') {
        c.node.loop = this.v('loop');
        c.node.playbackRate = this.v('rate');
        c.node.volume = this.v('volume');
        c.node.style.objectFit = this.v('fit');
      } else if (c.type === 'url') {
        this.root.style.pointerEvents = (!state.overlay && this.v('interactive')) ? 'auto' : 'none';
        this.pokeWeb();
      }
    }

    setPaused(p) {
      const c = this.cur;
      if (!c) return;
      if (c.type === 'spiral') { p ? c.r.stop() : c.r.start(); }
      else if (c.type === 'file') { p ? c.node.pause() : c.node.play().catch(() => {}); }
      else if (c.type === 'url') this.pokeWeb();
    }

    applyPerf() {
      const c = this.cur;
      if (c && c.type === 'spiral') {
        c.r.fps = effFps();
        c.r.scale = effScale();
        c.r.resize();
      }
    }

    // ---- presets
    snapshot() {
      const values = {};
      this.ui.querySelectorAll('[data-k]').forEach((el) => {
        const k = el.dataset.k;
        if (!['INPUT', 'SELECT'].includes(el.tagName) || SKIP_SNAPSHOT.includes(k)) return;
        values[k] = el.type === 'checkbox' ? el.checked : el.value;
      });
      return {
        values,
        media: this.media ? { name: this.media.name, path: this.media.path } : null,
        ab: this.ab
      };
    }

    restore(s) {
      if (!s) return;
      for (const [k, val] of Object.entries(s.values || {})) {
        const el = this.q(k);
        if (!el) continue;
        if (el.type === 'checkbox') el.checked = !!val; else el.value = val;
      }
      this.refreshOutputs();
      this.media = s.media && s.media.path ? { name: s.media.name, path: s.media.path, file: null } : null;
      let src = this.v('source');
      if (src === 'file' && !this.media) { src = 'off'; this.q('source').value = 'off'; }
      this.setSource(src);
      if (s.ab && this.media) { this.ab = { a: s.ab.a, b: s.ab.b }; this.updateAB(); }
    }
  }

  // ---------------------------------------------------------------- Subliminal text
  const flash = { timer: null, hideTimer: null, i: 0 };
  const MIN_INTERVAL = 0.4;
  const FLASH_IDS = ['fOn', 'fMsgs', 'fInterval', 'fDuration', 'fSize', 'fOpacity', 'fColor', 'fOrder'];

  const fCfg = () => ({
    on: $('#fOn').checked,
    msgs: $('#fMsgs').value.split('\n').map((s) => s.trim()).filter(Boolean),
    interval: Math.max(MIN_INTERVAL, parseFloat($('#fInterval').value)),
    duration: parseFloat($('#fDuration').value),
    size: parseFloat($('#fSize').value),
    opacity: parseFloat($('#fOpacity').value),
    color: $('#fColor').value,
    order: $('#fOrder').value
  });

  function flashStop() {
    clearTimeout(flash.timer);
    clearTimeout(flash.hideTimer);
    flashEl.style.opacity = 0;
  }

  function flashSchedule() {
    clearTimeout(flash.timer);
    const c = fCfg();
    if (!c.on || state.paused) return;
    flash.timer = setTimeout(flashShow, c.interval * 1000);
  }

  function flashShow() {
    const c = fCfg();
    if (!c.on || state.paused) return;
    if (!c.msgs.length) { flashSchedule(); return; }
    const msg = c.order === 'random'
      ? c.msgs[Math.floor(Math.random() * c.msgs.length)]
      : c.msgs[flash.i++ % c.msgs.length];
    flashEl.textContent = msg;
    flashEl.style.fontSize = c.size + 'vmin';
    flashEl.style.color = c.color;
    flashEl.style.opacity = c.opacity;
    const hold = Math.min(c.duration, c.interval * 1000 - 100);
    flash.hideTimer = setTimeout(() => { flashEl.style.opacity = 0; flashSchedule(); }, hold);
  }

  function refreshFlashOutputs() {
    $('#flashCard').querySelectorAll('input[type="range"]').forEach((r) => {
      const out = r.parentElement.querySelector('output');
      if (out) out.textContent = r.value;
    });
  }

  FLASH_IDS.forEach((id) => {
    $('#' + id).addEventListener('input', () => {
      refreshFlashOutputs();
      if (id === 'fOn') { flashStop(); flashSchedule(); }
    });
  });

  // ---------------------------------------------------------------- Saved flash scripts
  const SCRIPT_FIELDS = ['fMsgs', 'fInterval', 'fDuration', 'fSize', 'fOpacity', 'fColor', 'fOrder'];

  function scriptStore() {
    try { return JSON.parse(localStorage.getItem('ss.scripts') || '{}'); } catch (_) { return {}; }
  }
  function scriptWrite(obj) {
    try { localStorage.setItem('ss.scripts', JSON.stringify(obj)); return true; } catch (_) { return false; }
  }

  function refreshScriptList(select) {
    const list = $('#scList');
    const names = Object.keys(scriptStore()).sort((x, y) => x.localeCompare(y));
    list.innerHTML = '';
    if (!names.length) {
      const o = document.createElement('option');
      o.value = ''; o.textContent = 'No saved scripts yet';
      list.appendChild(o);
    }
    names.forEach((n) => { const o = document.createElement('option'); o.value = n; o.textContent = n; list.appendChild(o); });
    if (select && names.includes(select)) list.value = select;
  }

  $('#scSave').addEventListener('click', () => {
    const name = $('#scName').value.trim();
    if (!name) { toast('Type a name for the script first.', 3500); return; }
    const data = {};
    SCRIPT_FIELDS.forEach((id) => { data[id] = $('#' + id).value; });
    const all = scriptStore();
    all[name] = data;
    if (scriptWrite(all)) { refreshScriptList(name); toast(`Saved script "${name}".`, 3000); }
    else toast("Couldn't save the script.", 4000);
  });

  $('#scLoad').addEventListener('click', () => {
    const name = $('#scList').value;
    const data = name && scriptStore()[name];
    if (!data) return;
    SCRIPT_FIELDS.forEach((id) => { if (data[id] != null) $('#' + id).value = data[id]; });
    refreshFlashOutputs();
    $('#scName').value = name;
    flashStop(); flashSchedule();
    $('#fMsgs').dispatchEvent(new Event('input', { bubbles: true }));
    toast(`Loaded script "${name}".`, 3000);
  });

  $('#scDelete').addEventListener('click', () => {
    const name = $('#scList').value;
    if (!name) return;
    const all = scriptStore();
    delete all[name];
    scriptWrite(all);
    refreshScriptList();
  });

  $('#scImport').addEventListener('click', () => $('#scFile').click());
  $('#scFile').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      const text = String(rd.result).replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
      $('#fMsgs').value = text;
      $('#scName').value = f.name.replace(/\.[^.]+$/, '');
      flashStop(); flashSchedule();
      $('#fMsgs').dispatchEvent(new Event('input', { bubbles: true }));
      const n = text ? text.split('\n').filter((l) => l.trim()).length : 0;
      toast(`Imported ${n} message${n === 1 ? '' : 's'} from "${f.name}". Use Save script to keep it.`, 5000);
    };
    rd.onerror = () => toast("Couldn't read that file.", 4000);
    rd.readAsText(f, 'utf-8');
  });

  $('#scExport').addEventListener('click', () => {
    const text = $('#fMsgs').value.replace(/\r?\n/g, '\r\n');
    const name = ($('#scName').value.trim() || 'flash-script').replace(/[\\/:*?"<>|]+/g, '-');
    const blob = new Blob(['﻿' + text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name + '.txt';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  });

  // ---------------------------------------------------------------- Tones
  class ToneEngine {
    constructor() { this.ctx = null; this.nodes = null; this.volume = 0.3; this.fade = 1; }

    ensureCtx() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        this.ctx = new AC();
      }
      return this.ctx;
    }

    setFade(f) {
      this.fade = f;
      if (this.nodes) this.nodes.master.gain.setTargetAtTime(this.gainFor(this.volume), this.ctx.currentTime, 0.05);
    }

    get playing() { return !!this.nodes; }

    gainFor(v) { return v * v * 0.6 * this.fade; }   // gentle curve so the low end is easy to control

    start(cfg) {
      this.stop(true);
      const ctx = this.ensureCtx();
      if (!ctx) return false;
      ctx.resume();
      const master = ctx.createGain();
      master.gain.value = 0;
      master.connect(ctx.destination);
      const amp = ctx.createGain();
      amp.connect(master);
      const merger = ctx.createChannelMerger(2);
      merger.connect(amp);
      const oscL = ctx.createOscillator(), oscR = ctx.createOscillator();
      oscL.type = oscR.type = cfg.wave;
      const half = cfg.mode === 'binaural' ? cfg.beat / 2 : 0;
      oscL.frequency.value = Math.max(20, cfg.freq - half);
      oscR.frequency.value = Math.max(20, cfg.freq + half);
      oscL.connect(merger, 0, 0);
      oscR.connect(merger, 0, 1);
      let lfo = null;
      amp.gain.value = 1;
      if (cfg.mode === 'isochronic') {
        amp.gain.value = 0.5;
        lfo = ctx.createOscillator();
        lfo.frequency.value = cfg.beat;
        const depth = ctx.createGain();
        depth.gain.value = 0.5;
        lfo.connect(depth);
        depth.connect(amp.gain);
        lfo.start();
      }
      oscL.start();
      oscR.start();
      master.gain.setTargetAtTime(this.gainFor(this.volume), ctx.currentTime, 0.4);   // soft fade in
      this.nodes = { master, oscL, oscR, lfo, mode: cfg.mode };
      return true;
    }

    update(cfg) {
      const n = this.nodes;
      if (!n) return;
      if (n.mode !== cfg.mode) { this.start(cfg); return; }
      const t = this.ctx.currentTime;
      const half = cfg.mode === 'binaural' ? cfg.beat / 2 : 0;
      n.oscL.type = n.oscR.type = cfg.wave;
      n.oscL.frequency.setTargetAtTime(Math.max(20, cfg.freq - half), t, 0.05);
      n.oscR.frequency.setTargetAtTime(Math.max(20, cfg.freq + half), t, 0.05);
      if (n.lfo) n.lfo.frequency.setTargetAtTime(cfg.beat, t, 0.05);
    }

    setVolume(v) {
      this.volume = v;
      if (this.nodes) this.nodes.master.gain.setTargetAtTime(this.gainFor(v), this.ctx.currentTime, 0.05);
    }

    stop(immediate) {
      const n = this.nodes;
      if (!n) return;
      this.nodes = null;
      const t = this.ctx.currentTime;
      n.master.gain.cancelScheduledValues(t);
      n.master.gain.setTargetAtTime(0, t, immediate ? 0.01 : 0.15);
      const end = t + (immediate ? 0.1 : 0.8);
      [n.oscL, n.oscR, n.lfo].forEach((o) => { if (o) { try { o.stop(end); } catch (_) { /* already stopped */ } } });
      setTimeout(() => { try { n.master.disconnect(); } catch (_) { /* gone */ } }, (immediate ? 150 : 900));
    }

    suspend() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend(); }
    resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }
  }

  const tone = new ToneEngine();
  const TONE_IDS = ['tMode', 'tPreset', 'tFreq', 'tBeatPreset', 'tBeat', 'tWave', 'tVol'];

  const toneCfg = () => ({
    mode: $('#tMode').value,
    freq: Math.min(2000, Math.max(20, parseFloat($('#tFreq').value) || 432)),
    beat: Math.min(60, Math.max(0.5, parseFloat($('#tBeat').value) || 10)),
    wave: $('#tWave').value
  });

  function toneRefreshUi() {
    $('#tBeatRows').hidden = $('#tMode').value === 'pure';
    const vol = $('#tVol');
    vol.parentElement.querySelector('output').textContent = Math.round(vol.value * 100) + '%';
    $('#toneBtn').textContent = tone.playing ? 'Stop tone' : 'Play tone';
  }

  function toneSyncPresets(fromPreset) {
    const f = $('#tFreq'), p = $('#tPreset');
    if (fromPreset) { if (p.value !== 'custom') f.value = p.value; }
    else p.value = [...p.options].some((o) => o.value === String(parseFloat(f.value))) ? String(parseFloat(f.value)) : 'custom';
    const b = $('#tBeat'), bp = $('#tBeatPreset');
    if (fromPreset === 'beat') { if (bp.value !== 'custom') b.value = bp.value; }
    else if (fromPreset === false) { /* leave beat preset */ }
  }

  $('#tPreset').addEventListener('change', () => { toneSyncPresets(true); tone.update(toneCfg()); });
  $('#tFreq').addEventListener('input', () => { toneSyncPresets(false); tone.update(toneCfg()); });
  $('#tBeatPreset').addEventListener('change', () => {
    if ($('#tBeatPreset').value !== 'custom') $('#tBeat').value = $('#tBeatPreset').value;
    tone.update(toneCfg());
  });
  $('#tBeat').addEventListener('input', () => {
    const v = String(parseFloat($('#tBeat').value));
    const bp = $('#tBeatPreset');
    bp.value = [...bp.options].some((o) => o.value === v) ? v : 'custom';
    tone.update(toneCfg());
  });
  $('#tMode').addEventListener('change', () => { toneRefreshUi(); tone.update(toneCfg()); });
  $('#tWave').addEventListener('change', () => tone.update(toneCfg()));
  $('#tVol').addEventListener('input', (e) => { tone.setVolume(parseFloat(e.target.value)); toneRefreshUi(); });
  $('#toneBtn').addEventListener('click', () => {
    if (tone.playing) tone.stop(); else if (!state.paused) tone.start(toneCfg());
    toneRefreshUi();
  });
  tone.volume = parseFloat($('#tVol').value);

  // ---------------------------------------------------------------- Background sounds
  class BgEngine {
    constructor(toneEngine) { this.tone = toneEngine; this.node = null; this.volume = 0.3; this.fade = 1; this.cache = {}; }

    get playing() { return !!this.node; }

    gain() { return this.volume * this.volume * 0.9 * this.fade; }

    buffer(ctx, kind) {
      const key = (kind === 'white' || kind === 'rain') ? 'white' : (kind === 'brown' || kind === 'ocean') ? 'brown' : 'pink';
      if (this.cache[key]) return this.cache[key];
      const len = ctx.sampleRate * 8;
      const buf = ctx.createBuffer(2, len, ctx.sampleRate);
      for (let ch = 0; ch < 2; ch++) {
        const d = buf.getChannelData(ch);
        let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
        for (let i = 0; i < len; i++) {
          const w = Math.random() * 2 - 1;
          if (key === 'white') d[i] = w;
          else if (key === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
          else {
            b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
            b2 = 0.96900 * b2 + w * 0.1538520; b3 = 0.86650 * b3 + w * 0.3104856;
            b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
            d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
            b6 = w * 0.115926;
          }
        }
      }
      this.cache[key] = buf;
      return buf;
    }

    start(kind) {
      this.stop(true);
      const ctx = this.tone.ensureCtx();
      if (!ctx) return false;
      ctx.resume();
      const src = ctx.createBufferSource();
      src.buffer = this.buffer(ctx, kind);
      src.loop = true;
      const out = ctx.createGain();
      out.gain.value = 0;
      out.connect(ctx.destination);
      const extra = [];
      let tail = src;
      const chain = (n) => { tail.connect(n); tail = n; };
      const lfoTo = (param, freq, depth) => {
        const l = ctx.createOscillator(); l.frequency.value = freq;
        const d = ctx.createGain(); d.gain.value = depth;
        l.connect(d); d.connect(param); l.start(); extra.push(l);
      };
      if (kind === 'rain') {
        const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 700;
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 9000;
        chain(hp); chain(lp);
      } else if (kind === 'ocean') {
        const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 800;
        const swell = ctx.createGain(); swell.gain.value = 0.6;
        chain(lp); chain(swell);
        lfoTo(swell.gain, 0.09, 0.4);
        lfoTo(lp.frequency, 0.09, 250);
      } else if (kind === 'wind') {
        const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 500; bp.Q.value = 0.7;
        const sw = ctx.createGain(); sw.gain.value = 0.7;
        chain(bp); chain(sw);
        lfoTo(bp.frequency, 0.13, 300);
        lfoTo(sw.gain, 0.21, 0.3);
      }
      tail.connect(out);
      src.start();
      out.gain.setTargetAtTime(this.gain(), ctx.currentTime, 0.5);
      this.node = { src, out, extra, kind };
      return true;
    }

    setVolume(v) { this.volume = v; this.apply(); }
    setFade(f) { this.fade = f; this.apply(); }
    apply() { if (this.node) this.node.out.gain.setTargetAtTime(this.gain(), this.tone.ctx.currentTime, 0.05); }

    stop(immediate) {
      const n = this.node;
      if (!n) return;
      this.node = null;
      const ctx = this.tone.ctx, t = ctx.currentTime;
      n.out.gain.cancelScheduledValues(t);
      n.out.gain.setTargetAtTime(0, t, immediate ? 0.01 : 0.2);
      const end = t + (immediate ? 0.1 : 1.2);
      try { n.src.stop(end); } catch (_) { /* stopped */ }
      n.extra.forEach((o) => { try { o.stop(end); } catch (_) { /* stopped */ } });
      setTimeout(() => { try { n.out.disconnect(); } catch (_) { /* gone */ } }, immediate ? 150 : 1400);
    }
  }

  const bg = new BgEngine(tone);

  function updateOuts() {
    [['bgVol', (v) => Math.round(v * 100) + '%'], ['aVol', (v) => Math.round(v * 100) + '%'], ['aSpeed', (v) => v + 'x']].forEach(([id, f]) => {
      const r = $('#' + id);
      r.parentElement.querySelector('output').textContent = f(parseFloat(r.value));
    });
    $('#bgBtn').textContent = bg.playing ? 'Stop sound' : 'Play sound';
  }

  $('#bgBtn').addEventListener('click', () => {
    if (bg.playing) bg.stop(); else if (!state.paused) bg.start($('#bgType').value);
    updateOuts();
  });
  $('#bgType').addEventListener('change', () => { if (bg.playing) bg.start($('#bgType').value); });
  $('#bgVol').addEventListener('input', (e) => { bg.setVolume(parseFloat(e.target.value)); updateOuts(); });
  bg.volume = parseFloat($('#bgVol').value);

  // ---------------------------------------------------------------- Audio files
  const audio = new Audio();
  audio.preload = 'auto';
  const pl = { items: [], idx: -1 };
  let aSeeking = false, aWas = false, aFade = 1;

  const plUrl = (it) => {
    if (it.path) return fileUrl(it.path);
    if (!it.blob && it.file) it.blob = URL.createObjectURL(it.file);
    return it.blob || '';
  };

  function applyAudioSettings() {
    audio.volume = Math.min(1, parseFloat($('#aVol').value) * aFade);
    audio.playbackRate = parseFloat($('#aSpeed').value);
    audio.loop = $('#aLoop').value === 'one';
  }

  function renderList() {
    const ul = $('#aList');
    ul.innerHTML = '';
    pl.items.forEach((it, i) => {
      const li = document.createElement('li');
      if (i === pl.idx) li.className = 'cur';
      const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = it.name;
      const x = document.createElement('span'); x.className = 'x'; x.textContent = '✕'; x.title = 'Remove';
      x.addEventListener('click', (e) => { e.stopPropagation(); removeTrack(i); });
      li.addEventListener('click', () => playTrack(i));
      li.append(nm, x);
      ul.appendChild(li);
    });
    $('#aEmpty').hidden = pl.items.length > 0;
    $('#aPlay').textContent = (!audio.paused && !audio.ended) ? 'Pause' : 'Play';
  }

  function playTrack(i) {
    const n = pl.items.length;
    if (!n) return;
    pl.idx = ((i % n) + n) % n;
    audio.src = plUrl(pl.items[pl.idx]);
    applyAudioSettings();
    if (!state.paused) audio.play().catch(() => {}); else aWas = true;
    renderList();
  }

  function nextIndex(dir) {
    const n = pl.items.length;
    if (n > 1 && $('#aShuffle').checked && dir > 0) {
      let j; do { j = Math.floor(Math.random() * n); } while (j === pl.idx);
      return j;
    }
    return pl.idx + dir;
  }

  function removeTrack(i) {
    const it = pl.items[i];
    if (it && it.blob) URL.revokeObjectURL(it.blob);
    pl.items.splice(i, 1);
    if (i === pl.idx) { audio.pause(); audio.removeAttribute('src'); pl.idx = -1; }
    else if (i < pl.idx) pl.idx--;
    renderList();
  }

  audio.addEventListener('ended', () => {
    const mode = $('#aLoop').value;
    if (mode === 'one') return;
    const n = pl.items.length;
    if (mode === 'all' || pl.idx < n - 1) playTrack(nextIndex(1)); else renderList();
  });
  audio.addEventListener('play', renderList);
  audio.addEventListener('pause', renderList);
  audio.addEventListener('error', () => { if (audio.src) toast("Couldn't play that audio file. Add it again.", 4000); });
  audio.addEventListener('timeupdate', () => {
    const d = audio.duration, t = audio.currentTime;
    const ok = isFinite(d) && d > 0;
    $('#aTime').textContent = ok ? `${fmtTime(t)} / ${fmtTime(d)}` : '0:00 / 0:00';
    $('#aSeek').disabled = !ok;
    if (ok && !aSeeking) $('#aSeek').value = Math.round((t / d) * 1000);
  });

  $('#aAdd').addEventListener('click', () => $('#aInput').click());
  $('#aInput').addEventListener('change', (e) => {
    const wasEmpty = pl.items.length === 0;
    [...e.target.files].forEach((f) => {
      pl.items.push({ name: f.name, path: api && api.getPath ? api.getPath(f) : '', file: f });
    });
    e.target.value = '';
    renderList();
    if (wasEmpty && pl.items.length) playTrack(0);
  });
  $('#aPlay').addEventListener('click', () => {
    if (!pl.items.length) return;
    if (pl.idx < 0) { playTrack(0); return; }
    if (audio.paused) { aWas = false; audio.play().catch(() => {}); } else audio.pause();
  });
  $('#aNext').addEventListener('click', () => { if (pl.items.length) playTrack(nextIndex(1)); });
  $('#aPrev').addEventListener('click', () => { if (pl.items.length) playTrack(pl.idx - 1); });
  $('#aSeek').addEventListener('pointerdown', () => { aSeeking = true; });
  $('#aSeek').addEventListener('pointerup', () => { aSeeking = false; });
  $('#aSeek').addEventListener('change', () => { aSeeking = false; });
  $('#aSeek').addEventListener('input', (e) => {
    if (isFinite(audio.duration)) audio.currentTime = (parseFloat(e.target.value) / 1000) * audio.duration;
  });
  ['aVol', 'aSpeed', 'aLoop'].forEach((id) => $('#' + id).addEventListener('input', () => { applyAudioSettings(); updateOuts(); }));
  $('#aLoop').addEventListener('change', applyAudioSettings);

  // ---------------------------------------------------------------- Session timer
  const timer = { id: null, end: 0, total: 0, fadeMs: 0, last: 0 };
  let masterOpacity = 1, fadeMul = 1;

  function applyStageOpacity() { stage.style.opacity = masterOpacity * fadeMul; }

  function setFade(f) {
    fadeMul = f;
    tone.setFade(f);
    bg.setFade(f);
    aFade = f;
    applyAudioSettings();
    applyStageOpacity();
  }

  function timerStop(label) {
    clearInterval(timer.id);
    timer.id = null;
    setFade(1);
    $('#tmBtn').textContent = 'Start timer';
    $('#tmLabel').textContent = label || 'When time is up, the sound, tone, audio, spiral and text fade out together, then everything stops.';
  }

  function timerFinish() {
    timerStop('Session finished.');
    tone.stop(true);
    bg.stop(true);
    audio.pause();
    toneRefreshUi();
    updateOuts();
    if (state.overlay) setOverlay(false);
    setBlackout(true);
    toast('Session finished. Press "Show again" to bring everything back.', 8000);
  }

  function timerTick() {
    const now = performance.now();
    if (state.paused) { timer.end += now - timer.last; timer.last = now; return; }
    timer.last = now;
    const left = timer.end - now;
    if (left <= 0) { timerFinish(); return; }
    const s = Math.ceil(left / 1000);
    $('#tmLabel').textContent = `Time left: ${fmtTime(s)}`;
    setFade(timer.fadeMs > 0 && left < timer.fadeMs ? Math.max(0, left / timer.fadeMs) : 1);
  }

  $('#tmBtn').addEventListener('click', () => {
    if (timer.id) { timerStop('Timer cancelled.'); return; }
    const mins = Math.min(600, Math.max(0.1, parseFloat($('#tmMin').value) || 30));
    const fadeS = Math.min(600, Math.max(0, parseFloat($('#tmFade').value) || 0));
    timer.total = mins * 60000;
    timer.fadeMs = Math.min(fadeS * 1000, timer.total);
    timer.last = performance.now();
    timer.end = timer.last + timer.total;
    timer.id = setInterval(timerTick, 250);
    $('#tmBtn').textContent = 'Cancel timer';
    timerTick();
  });

  // ---------------------------------------------------------------- Timeline sessions
  const sess = { events: [], start: null };
  const run = { id: null, clock: 0, last: 0, idx: 0, list: [], ramps: [], endFade: null };

  const TARGETS = [];
  [1, 2].forEach((n) => {
    TARGETS.push([`l${n}.speed`, `Layer ${n} spiral: speed`], [`l${n}.arms`, `Layer ${n} spiral: arms`],
      [`l${n}.twist`, `Layer ${n} spiral: tightness`], [`l${n}.soft`, `Layer ${n} spiral: edge softness`],
      [`l${n}.pulse`, `Layer ${n} spiral: pulse`], [`l${n}.opacity`, `Layer ${n}: opacity`]);
  });
  TARGETS.push(['flash.interval', 'Flash text: every (s)'], ['flash.duration', 'Flash text: shown for (ms)'],
    ['flash.size', 'Flash text: size'], ['flash.opacity', 'Flash text: opacity'],
    ['tone.volume', 'Tone: volume'], ['tone.freq', 'Tone: frequency (Hz)'], ['tone.beat', 'Tone: beat (Hz)'],
    ['bg.volume', 'Background sound: volume'], ['audio.volume', 'Audio file: volume'],
    ['audio.speed', 'Audio file: speed'], ['master', 'Master opacity']);
  const TARGET_SEL = {
    'flash.interval': '#fInterval', 'flash.duration': '#fDuration', 'flash.size': '#fSize', 'flash.opacity': '#fOpacity',
    'tone.volume': '#tVol', 'tone.freq': '#tFreq', 'tone.beat': '#tBeat', 'bg.volume': '#bgVol',
    'audio.volume': '#aVol', 'audio.speed': '#aSpeed', master: '#mOpacity'
  };
  const BG_KINDS = [['rain', 'Rain'], ['ocean', 'Ocean waves'], ['wind', 'Wind'], ['brown', 'Brown noise'], ['pink', 'Pink noise'], ['white', 'White noise']];
  const ON_OFF = [['1', 'On'], ['0', 'Off']];
  const LAYER_OPTS = [['1', 'Layer 1'], ['2', 'Layer 2']];
  const TYPE_LABEL = {
    set: 'Change a setting', colors: 'Change spiral colors', layer: 'Show or hide a layer', flash: 'Flashing text',
    script: 'Switch flash script', tone: 'Tone', bg: 'Background sound', audio: 'Audio file', end: 'End the session'
  };
  const DEFAULTS = {
    set: { target: 'l1.speed', value: 1, ramp: 0 }, colors: { layer: '1', a: '#8f6bff', b: '#0d0820' },
    layer: { layer: '1', source: 'spiral' }, flash: { on: '1' }, script: { name: '' }, tone: { on: '1' },
    bg: { on: '1', kind: 'rain' }, audio: { action: 'play' }, end: { fade: 30 }
  };

  function ctlFor(target) {
    const m = /^l([12])\.(.+)$/.exec(target);
    if (m) return layers[Number(m[1]) - 1].q(m[2]);
    return TARGET_SEL[target] ? $(TARGET_SEL[target]) : null;
  }

  function setCtl(el, v) {
    const lo = parseFloat(el.min), hi = parseFloat(el.max);
    if (isFinite(lo)) v = Math.max(lo, v);
    if (isFinite(hi)) v = Math.min(hi, v);
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function parseTime(txt) {
    const parts = String(txt).trim().split(':').map((x) => parseFloat(x));
    if (!parts.length || parts.some((x) => !isFinite(x) || x < 0)) return null;
    return parts.reduce((acc, x) => acc * 60 + x, 0);
  }

  function scriptOptions() {
    return Object.keys(scriptStore()).sort((x, y) => x.localeCompare(y)).map((n) => [n, n]);
  }

  function fieldDefs(e) {
    switch (e.type) {
      case 'set': return [['target', 'select', TARGETS, 'Setting', true], ['value', 'number', null, 'Value'], ['ramp', 'number', null, 'Change gradually over (s)', true]];
      case 'colors': return [['layer', 'select', LAYER_OPTS, 'Layer'], ['a', 'color', null, 'Band color'], ['b', 'color', null, 'Dark color']];
      case 'layer': return [['layer', 'select', LAYER_OPTS, 'Layer'], ['source', 'select', [['off', 'Off'], ['spiral', 'Built-in spiral']], 'Show']];
      case 'flash': return [['on', 'select', ON_OFF, 'Flashing text']];
      case 'script': return [['name', 'select', scriptOptions(), 'Script (saved in Subliminal text)', true]];
      case 'tone': return [['on', 'select', ON_OFF, 'Tone (uses your tone settings)', true]];
      case 'bg': return [['on', 'select', ON_OFF, 'Sound'], ['kind', 'select', BG_KINDS, 'Type']];
      case 'audio': return [['action', 'select', [['play', 'Play'], ['pause', 'Pause'], ['next', 'Next track']], 'Action', true]];
      case 'end': return [['fade', 'number', null, 'Fade everything out over (s)', true]];
      default: return [];
    }
  }

  function sessionTotal() {
    let m = 0;
    sess.events.forEach((e) => {
      m = Math.max(m, e.t + (e.type === 'end' ? (Number(e.fade) || 0) : 0) + (e.type === 'set' ? (Number(e.ramp) || 0) : 0));
    });
    return m;
  }

  function renderEvents() {
    const box = $('#seList');
    box.innerHTML = '';
    if (!sess.events.length) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = 'No events yet. Pick a type below and press Add event, or load the example.';
      box.appendChild(p);
    }
    sess.events.forEach((e, i) => {
      const row = document.createElement('div');
      row.className = 'ev';
      const top = document.createElement('div');
      top.className = 'top';
      const t = document.createElement('input');
      t.type = 'text'; t.className = 't'; t.value = fmtTime(e.t); t.title = 'Time (m:ss)';
      t.addEventListener('change', () => {
        const v = parseTime(t.value);
        if (v == null) { t.value = fmtTime(e.t); return; }
        e.t = v;
        sess.events.sort((x, y) => x.t - y.t);
        renderEvents(); updateSessionLabel();
      });
      const lbl = document.createElement('span');
      lbl.className = 'lbl'; lbl.textContent = TYPE_LABEL[e.type] || e.type;
      const x = document.createElement('button');
      x.className = 'x'; x.textContent = '✕'; x.title = 'Remove this event';
      x.addEventListener('click', () => { sess.events.splice(i, 1); renderEvents(); updateSessionLabel(); });
      top.append(t, lbl, x);
      row.appendChild(top);

      const fields = document.createElement('div');
      fields.className = 'fields';
      fieldDefs(e).forEach(([k, kind, opts, label, wide]) => {
        const lab = document.createElement('label');
        if (wide) lab.className = 'wide2';
        let text = label;
        let input;
        if (kind === 'select') {
          input = document.createElement('select');
          (opts.length ? opts : [['', 'None saved yet']]).forEach(([val, name]) => {
            const o = document.createElement('option'); o.value = val; o.textContent = name; input.appendChild(o);
          });
          input.value = String(e[k] ?? '');
          if (input.value !== String(e[k] ?? '') && opts.length) { e[k] = input.value; }
        } else {
          input = document.createElement('input');
          input.type = kind; input.value = e[k] ?? '';
          if (kind === 'number') {
            input.step = 'any'; input.min = '0';
            if (e.type === 'set' && k === 'value') {
              const c = ctlFor(e.target);
              if (c && c.min !== '' && c.max !== '') text = `Value (${c.min} to ${c.max})`;
            }
          }
        }
        lab.append(text, input);
        input.addEventListener('change', () => {
          e[k] = kind === 'number' ? (parseFloat(input.value) || 0) : input.value;
          if (e.type === 'set' && k === 'target') {
            const c = ctlFor(e.target);
            e.value = c ? parseFloat(c.value) : 0;
            renderEvents();
          }
          updateSessionLabel();
        });
        fields.appendChild(lab);
      });
      row.appendChild(fields);
      box.appendChild(row);
    });
    updateSessionLabel();
  }

  function updateSessionLabel() {
    if (run.id) return;
    const total = sessionTotal();
    $('#seLabel').textContent = sess.events.length
      ? `Not playing. ${sess.events.length} event${sess.events.length === 1 ? '' : 's'}, length ${fmtTime(total)}.`
      : 'Not playing. Add events below.';
    $('#seFill').style.width = '0%';
  }

  function updateStartLabel() {
    $('#seStartLabel').textContent = sess.start ? 'Start setup saved' : 'No start setup';
  }

  $('#seAdd').addEventListener('click', () => {
    const type = $('#seType').value;
    const last = sess.events.length ? sess.events[sess.events.length - 1].t : -10;
    const ev = { t: last + 10, type, ...JSON.parse(JSON.stringify(DEFAULTS[type])) };
    if (type === 'script') { const o = scriptOptions(); ev.name = o.length ? o[0][0] : ''; }
    if (type === 'set') { const c = ctlFor(ev.target); if (c) ev.value = parseFloat(c.value); }
    sess.events.push(ev);
    sess.events.sort((x, y) => x.t - y.t);
    renderEvents();
  });

  $('#seStart').addEventListener('click', () => {
    sess.start = capture(false);
    updateStartLabel();
    toast('Start setup saved. The session will begin from this setup every time.', 4500);
  });

  function fireEvent(e, now) {
    const on = e.on === '1' || e.on === true;
    switch (e.type) {
      case 'set': {
        const el = ctlFor(e.target);
        if (!el) return;
        const ramp = (Number(e.ramp) || 0) * 1000;
        const to = Number(e.value);
        run.ramps = run.ramps.filter((r) => r.el !== el);
        if (ramp > 0) run.ramps.push({ el, from: parseFloat(el.value), to, t0: now, dur: ramp });
        else setCtl(el, to);
        break;
      }
      case 'colors': {
        const L = layers[Number(e.layer) - 1];
        if (!L) return;
        [['colorA', e.a], ['colorB', e.b]].forEach(([k, val]) => { const el = L.q(k); el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); });
        break;
      }
      case 'layer': {
        const L = layers[Number(e.layer) - 1];
        if (!L) return;
        L.q('source').value = e.source;
        L.q('source').dispatchEvent(new Event('change', { bubbles: true }));
        break;
      }
      case 'flash':
        $('#fOn').checked = on;
        $('#fOn').dispatchEvent(new Event('input', { bubbles: true }));
        break;
      case 'script': {
        const data = scriptStore()[e.name];
        if (!data) return;
        SCRIPT_FIELDS.forEach((id) => { if (data[id] != null) $('#' + id).value = data[id]; });
        refreshFlashOutputs();
        flashStop(); flashSchedule();
        break;
      }
      case 'tone':
        if (on) { if (!tone.playing) tone.start(toneCfg()); } else tone.stop();
        toneRefreshUi();
        break;
      case 'bg':
        if (on) { $('#bgType').value = e.kind; bg.start(e.kind); } else bg.stop();
        updateOuts();
        break;
      case 'audio':
        if (e.action === 'play') { if (pl.items.length) { if (pl.idx < 0) playTrack(0); else audio.play().catch(() => {}); } }
        else if (e.action === 'pause') audio.pause();
        else if (e.action === 'next') { if (pl.items.length) playTrack(nextIndex(1)); }
        break;
      case 'end':
        run.endFade = { t0: now, dur: Math.max(0, (Number(e.fade) || 0) * 1000) };
        break;
      default: break;
    }
  }

  function sessionStop(msg) {
    clearInterval(run.id);
    run.id = null;
    run.ramps = [];
    if (run.endFade) { run.endFade = null; setFade(1); }
    $('#sessionCard').classList.remove('playing');
    $('#seBtn').textContent = 'Play session';
    if (msg) $('#seLabel').textContent = msg; else updateSessionLabel();
    if (msg) $('#seFill').style.width = '0%';
  }

  function sessionTick() {
    const now = performance.now();
    const dt = now - run.last;
    run.last = now;
    if (state.paused) { run.clock += dt; run.ramps.forEach((r) => { r.t0 += dt; }); if (run.endFade) run.endFade.t0 += dt; return; }
    const elapsed = (now - run.clock) / 1000;
    while (run.idx < run.list.length && run.list[run.idx].t <= elapsed) fireEvent(run.list[run.idx++], now);
    run.ramps = run.ramps.filter((r) => {
      const f = Math.min(1, (now - r.t0) / r.dur);
      setCtl(r.el, r.from + (r.to - r.from) * f);
      return f < 1;
    });
    if (run.endFade) {
      const f = run.endFade.dur > 0 ? Math.min(1, (now - run.endFade.t0) / run.endFade.dur) : 1;
      setFade(1 - f);
      if (f >= 1) { sessionStop('Session finished.'); timerFinish(); return; }
    }
    const total = sessionTotal();
    $('#seFill').style.width = total > 0 ? Math.min(100, (elapsed / total) * 100) + '%' : '0%';
    $('#seLabel').textContent = `Playing ${fmtTime(elapsed)} / ${fmtTime(total)}`;
    if (run.idx >= run.list.length && !run.ramps.length && !run.endFade) sessionStop('Session complete. Everything stays as it is.');
  }

  function sessionPlay() {
    if (!state.acked) return;
    if (!sess.events.length) { toast('Add at least one event first.', 3500); return; }
    if (state.blackout) setBlackout(false);
    if (state.paused) setPaused(false);
    if (sess.start) applyData(sess.start);
    run.list = sess.events.slice().sort((x, y) => x.t - y.t);
    run.idx = 0; run.ramps = []; run.endFade = null;
    run.last = performance.now();
    run.clock = run.last;
    $('#sessionCard').classList.add('playing');
    $('#seBtn').textContent = 'Stop session';
    run.id = setInterval(sessionTick, 100);
    sessionTick();
  }

  $('#seBtn').addEventListener('click', () => { if (run.id) sessionStop('Session stopped.'); else sessionPlay(); });

  // saved sessions
  const seStore = () => { try { return JSON.parse(localStorage.getItem('ss.sessions') || '{}'); } catch (_) { return {}; } };
  const seWrite = (o) => { try { localStorage.setItem('ss.sessions', JSON.stringify(o)); return true; } catch (_) { return false; } };

  function refreshSessionList(select) {
    const list = $('#seSaved');
    const names = Object.keys(seStore()).sort((x, y) => x.localeCompare(y));
    list.innerHTML = '';
    if (!names.length) { const o = document.createElement('option'); o.value = ''; o.textContent = 'No saved sessions yet'; list.appendChild(o); }
    names.forEach((n) => { const o = document.createElement('option'); o.value = n; o.textContent = n; list.appendChild(o); });
    if (select && names.includes(select)) list.value = select;
  }

  function loadSessionData(d) {
    if (!d || !Array.isArray(d.events)) return false;
    sess.events = d.events.filter((e) => e && typeof e.t === 'number' && DEFAULTS[e.type]).sort((x, y) => x.t - y.t);
    sess.start = d.start || null;
    renderEvents(); updateStartLabel();
    return true;
  }

  $('#seSave').addEventListener('click', () => {
    const name = $('#seName').value.trim();
    if (!name) { toast('Type a name for the session first.', 3500); return; }
    const all = seStore();
    all[name] = { events: sess.events, start: sess.start };
    if (seWrite(all)) { refreshSessionList(name); toast(`Saved session "${name}".`, 3000); } else toast("Couldn't save the session.", 4000);
  });
  $('#seLoad').addEventListener('click', () => {
    if (run.id) return;
    const name = $('#seSaved').value;
    if (name && loadSessionData(seStore()[name])) { $('#seName').value = name; toast(`Loaded session "${name}".`, 3000); }
  });
  $('#seDelete').addEventListener('click', () => {
    const name = $('#seSaved').value;
    if (!name) return;
    const all = seStore(); delete all[name]; seWrite(all); refreshSessionList();
  });
  $('#seExample').addEventListener('click', () => {
    if (run.id) return;
    loadSessionData({
      events: [
        { t: 0, type: 'set', target: 'l1.opacity', value: 0, ramp: 0 },
        { t: 0, type: 'layer', layer: '1', source: 'spiral' },
        { t: 1, type: 'set', target: 'l1.opacity', value: 0.8, ramp: 20 },
        { t: 5, type: 'tone', on: '1' },
        { t: 30, type: 'flash', on: '1' },
        { t: 120, type: 'set', target: 'l1.speed', value: 1.2, ramp: 60 },
        { t: 300, type: 'colors', layer: '1', a: '#4fd0c0', b: '#06141a' },
        { t: 540, type: 'set', target: 'l1.speed', value: 0.3, ramp: 40 },
        { t: 570, type: 'end', fade: 30 }
      ],
      start: null
    });
    toast('Example loaded: a 10 minute calm session. Press Play session to try it, or edit it first.', 6000);
  });
  $('#seImport').addEventListener('click', () => $('#seFile').click());
  $('#seFile').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const d = JSON.parse(String(rd.result).replace(/^﻿/, ''));
        if (loadSessionData(d)) { $('#seName').value = f.name.replace(/\.[^.]+$/, ''); toast('Session imported. Use Save session to keep it.', 4500); }
        else toast("That file isn't a Spiral Stage session.", 4500);
      } catch (_) { toast("That file isn't a Spiral Stage session.", 4500); }
    };
    rd.readAsText(f, 'utf-8');
  });
  $('#seExport').addEventListener('click', () => {
    const name = ($('#seName').value.trim() || 'session').replace(/[\\/:*?"<>|]+/g, '-');
    const blob = new Blob([JSON.stringify({ app: 'spiral-stage', events: sess.events, start: sess.start }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = name + '.json';
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  });

  // ---------------------------------------------------------------- Global controls
  function setPaused(p) {
    const was = state.paused;
    state.paused = p;
    layers.forEach((l) => l.setPaused(p));
    if (p) { flashStop(); tone.suspend(); } else { flashSchedule(); tone.resume(); }
    if (p && !was) { aWas = !audio.paused; audio.pause(); }
    else if (!p && was) { if (aWas && audio.src) audio.play().catch(() => {}); aWas = false; }
    $('#btnPause').textContent = p ? 'Resume' : 'Pause';
  }

  function setBlackout(b) {
    state.blackout = b;
    stage.classList.toggle('blackout', b);
    $('#btnBlackout').textContent = b ? 'Show again' : 'Hide all';
    setPaused(b);
  }

  function setPanel(show) {
    $('#app').classList.toggle('nopanel', !show);
    $('#reveal').hidden = show;
  }

  const panelShown = () => !$('#app').classList.contains('nopanel');

  function setOverlay(on) {
    if (!state.acked) return;
    if (api) api.setOverlay(on); else onMode(on ? 'overlay' : 'normal');
  }

  function onMode(mode) {
    state.overlay = mode === 'overlay';
    document.body.classList.toggle('overlay', state.overlay);
    $('#btnOverlay').textContent = state.overlay ? 'Stop overlay' : 'Start overlay';
    layers.forEach((l) => l.apply());
    layers.forEach((l) => l.applyPerf());
    lastOver = null;
    if (state.overlay) {
      toast('Overlay is on. Clicks pass through to your apps.\nCtrl+Alt+O stops it. Ctrl+Alt+P hides this panel.\nCtrl+Alt+H hides everything at once.');
    }
  }

  let lastOver = null;
  document.addEventListener('mousemove', (e) => {
    if (!state.overlay || !api) return;
    const over = !!e.target.closest('#panel, #reveal, #warning');
    if (over !== lastOver) { lastOver = over; api.setIgnore(!over); }
  });

  function toggleBig() {
    if (api) { api.toggleBig(); return; }
    if (document.fullscreenElement) document.exitFullscreen();
    else if (stage.requestFullscreen) stage.requestFullscreen().catch(() => {});
  }

  $('#btnPause').addEventListener('click', () => setPaused(!state.paused));
  $('#btnBlackout').addEventListener('click', () => setBlackout(!state.blackout));
  $('#btnFull').addEventListener('click', toggleBig);
  $('#btnHide').addEventListener('click', () => setPanel(false));
  $('#reveal').addEventListener('click', () => setPanel(true));
  $('#btnOverlay').addEventListener('click', () => setOverlay(!state.overlay));
  $('#tbBig').addEventListener('click', toggleBig);
  $('#tbMin').addEventListener('click', () => api && api.minimize());
  $('#tbClose').addEventListener('click', () => api && api.quit());

  $('#mOpacity').addEventListener('input', (e) => {
    masterOpacity = parseFloat(e.target.value);
    applyStageOpacity();
    e.target.parentElement.querySelector('output').textContent = e.target.value;
  });

  document.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    const k = e.key.toLowerCase();
    if (k === ' ') { e.preventDefault(); setPaused(!state.paused); }
    else if (k === 'b') setBlackout(!state.blackout);
    else if (k === 'f') toggleBig();
    else if (k === 'h') setPanel(!panelShown());
  });

  $('#pFps').addEventListener('change', (e) => {
    state.fps = parseInt(e.target.value, 10);
    layers.forEach((l) => l.applyPerf());
  });
  $('#pScale').addEventListener('change', (e) => {
    state.scale = parseFloat(e.target.value);
    layers.forEach((l) => l.applyPerf());
  });

  $('#pAuto').addEventListener('change', (e) => {
    state.auto = e.target.checked;
    layers.forEach((l) => l.applyPerf());
  });
  if (api && api.getSettings) $('#pSoft').checked = !!api.getSettings().software;
  $('#pSoft').addEventListener('change', (e) => {
    if (!api || !api.setSoftware) return;
    saveLast();
    toast('Restarting Spiral Stage…', 3000);
    setTimeout(() => api.setSoftware(e.target.checked), 400);
  });

  if (api) {
    api.onMode(onMode);
    api.onCmd((cmd) => {
      if (!state.acked) return;
      if (cmd === 'overlay') setOverlay(!state.overlay);
      else if (cmd === 'panel') setPanel(!panelShown());
      else if (cmd === 'blackout') setBlackout(!state.blackout);
      else if (cmd === 'pause') setPaused(!state.paused);
    });
  }

  // ---------------------------------------------------------------- Presets and last session
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (_) { return fallback; }
    },
    set(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); return true; } catch (_) { return false; } }
  };

  function capture(withSession = true) {
    const flashVals = {};
    FLASH_IDS.forEach((id) => { const e = $('#' + id); flashVals[id] = e.type === 'checkbox' ? e.checked : e.value; });
    const toneVals = {};
    TONE_IDS.forEach((id) => { toneVals[id] = $('#' + id).value; });
    return {
      v: 1,
      layers: layers.map((l) => l.snapshot()),
      flash: flashVals,
      tone: toneVals,
      perf: { fps: $('#pFps').value, scale: $('#pScale').value, auto: $('#pAuto').checked },
      master: $('#mOpacity').value,
      bg: { bgType: $('#bgType').value, bgVol: $('#bgVol').value },
      audio: {
        vals: { aLoop: $('#aLoop').value, aShuffle: $('#aShuffle').checked, aVol: $('#aVol').value, aSpeed: $('#aSpeed').value },
        items: pl.items.filter((i) => i.path).map((i) => ({ name: i.name, path: i.path }))
      },
      timer: { tmMin: $('#tmMin').value, tmFade: $('#tmFade').value },
      session: withSession ? { events: sess.events, start: sess.start } : undefined
    };
  }

  function applyData(d) {
    if (!d || !Array.isArray(d.layers)) return;
    d.layers.forEach((s, i) => { if (layers[i]) layers[i].restore(s); });
    for (const [id, val] of Object.entries(d.flash || {})) {
      const e = $('#' + id);
      if (!e) continue;
      if (e.type === 'checkbox') e.checked = !!val; else e.value = val;
    }
    refreshFlashOutputs();
    flashStop(); flashSchedule();
    for (const [id, val] of Object.entries(d.tone || {})) { const e = $('#' + id); if (e) e.value = val; }
    tone.volume = parseFloat($('#tVol').value);
    toneRefreshUi();
    if (tone.playing) tone.update(toneCfg());
    if (d.perf) {
      $('#pFps').value = d.perf.fps; $('#pScale').value = d.perf.scale;
      state.fps = parseInt(d.perf.fps, 10); state.scale = parseFloat(d.perf.scale);
      $('#pAuto').checked = !!d.perf.auto; state.auto = !!d.perf.auto;
      layers.forEach((l) => l.applyPerf());
    }
    if (d.bg) {
      $('#bgType').value = d.bg.bgType; $('#bgVol').value = d.bg.bgVol;
      bg.setVolume(parseFloat(d.bg.bgVol));
      if (bg.playing) bg.start(d.bg.bgType);
    }
    if (d.audio) {
      const v = d.audio.vals || {};
      if (v.aLoop) $('#aLoop').value = v.aLoop;
      $('#aShuffle').checked = !!v.aShuffle;
      if (v.aVol != null) $('#aVol').value = v.aVol;
      if (v.aSpeed != null) $('#aSpeed').value = v.aSpeed;
      audio.pause(); audio.removeAttribute('src');
      pl.items.forEach((i) => { if (i.blob) URL.revokeObjectURL(i.blob); });
      pl.items = (d.audio.items || []).map((i) => ({ name: i.name, path: i.path, file: null }));
      pl.idx = -1;
      applyAudioSettings(); renderList();
    }
    if (d.session && !run.id) { loadSessionData(d.session); }
    if (d.timer) { $('#tmMin').value = d.timer.tmMin; $('#tmFade').value = d.timer.tmFade; }
    updateOuts();
    if (d.master != null) { $('#mOpacity').value = d.master; $('#mOpacity').dispatchEvent(new Event('input')); }
  }

  function refreshPresetList(select) {
    const list = $('#prList');
    const presets = store.get('ss.presets', {});
    const names = Object.keys(presets).sort((a, b) => a.localeCompare(b));
    list.innerHTML = '';
    if (!names.length) {
      const o = document.createElement('option');
      o.value = ''; o.textContent = 'No saved presets yet';
      list.appendChild(o);
    }
    names.forEach((n) => { const o = document.createElement('option'); o.value = n; o.textContent = n; list.appendChild(o); });
    if (select && names.includes(select)) list.value = select;
  }

  $('#prSave').addEventListener('click', () => {
    const name = $('#prName').value.trim();
    if (!name) { toast('Type a name for the preset first.', 3500); return; }
    const presets = store.get('ss.presets', {});
    presets[name] = capture();
    if (store.set('ss.presets', presets)) { refreshPresetList(name); toast(`Saved preset "${name}".`, 3000); }
    else toast("Couldn't save the preset.", 4000);
  });
  $('#prLoad').addEventListener('click', () => {
    const name = $('#prList').value;
    const d = name && store.get('ss.presets', {})[name];
    if (!d) return;
    applyData(d);
    toast(`Loaded "${name}".`, 3000);
  });
  $('#prDelete').addEventListener('click', () => {
    const name = $('#prList').value;
    if (!name) return;
    const presets = store.get('ss.presets', {});
    delete presets[name];
    store.set('ss.presets', presets);
    refreshPresetList();
  });

  let saveTimer = null;
  const saveLast = () => { try { store.set('ss.last', capture()); } catch (_) { /* ignore */ } };
  const scheduleSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveLast, 1500); };
  document.addEventListener('input', scheduleSave, true);
  document.addEventListener('change', scheduleSave, true);
  window.addEventListener('beforeunload', saveLast);

  // ---------------------------------------------------------------- Start up
  layers.push(new Layer(0), new Layer(1));
  refreshFlashOutputs();
  refreshPresetList();
  refreshScriptList();
  refreshSessionList();
  renderEvents();
  updateStartLabel();
  $('#mOpacity').dispatchEvent(new Event('input'));

  const warning = $('#warning');
  const accept = () => { state.acked = true; warning.classList.add('done'); };
  let seen = false;
  try { seen = !!localStorage.getItem('spiralStageAck'); } catch (_) { /* storage blocked */ }
  if (!seen) setPaused(true);

  const last = store.get('ss.last', null);
  if (last && Array.isArray(last.layers)) {
    try { applyData(last); } catch (e) { console.error('Could not restore last session', e); }
  } else {
    layers[0].q('source').value = 'spiral';
    layers[0].setSource('spiral');
    layers[1].q('opacity').value = 0.6;
    layers[1].refreshOutputs();
    layers[1].apply();
  }
  toneRefreshUi();
  updateOuts();
  renderList();
  applyAudioSettings();

  if (seen) {
    accept();
  } else {
    $('#ack').addEventListener('click', () => {
      try { localStorage.setItem('spiralStageAck', '1'); } catch (_) { /* ignore */ }
      accept();
      setPaused(false);
    });
  }

  window.__spiral = { state, layers, setOverlay, onMode, tone, bg, audio, pl, capture, applyData, sess, run };
})();
