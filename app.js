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
  const MAX_LAYERS = (window.matchMedia && matchMedia('(pointer: coarse)').matches) ? 4 : 8;
  const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|wmv|mpg|mpeg|ogv|ogg|3gp|ts|flv)$/i;

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
  const SKIP_GENERIC = ['source', 'fileInput', 'dirInput', 'urlInput', 'fileSeek', 'webSeek'];
  const SKIP_SNAPSHOT = ['fileInput', 'dirInput', 'fileSeek', 'webSeek'];

  class Layer {
    constructor(index) {
      this.index = index;
      this.cur = null;
      this.media = null;          // current item { name, path, file }
      this.list = [];             // playlist of items
      this.idx = 0;
      this.history = [];
      this.fails = 0;
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
      this.wire();
      this.setIndex(index);
      this.refreshOutputs();
    }

    setIndex(i) {
      this.index = i;
      this.root.style.zIndex = String(i + 1);
      this.q('title').textContent = 'Layer ' + (i + 1) + (i === 0 ? ' (bottom)' : '');
      const rm = this.q('layerRemove');
      if (rm) rm.hidden = false;
    }

    destroy() {
      this.teardown();
      this.root.remove();
      this.ui.remove();
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
        const fs = Array.from(e.target.files || []);
        if (fs.length) this.loadFiles(fs);
        e.target.value = '';
      });
      this.q('dirBtn').addEventListener('click', () => this.q('dirInput').click());
      this.q('dirInput').addEventListener('change', (e) => {
        const fs = Array.from(e.target.files || []).filter((f) => (f.type || '').startsWith('video/') || VIDEO_EXT.test(f.name));
        if (fs.length) this.loadFiles(fs);
        else if (e.target.files && e.target.files.length) toast('No video files were found in that folder.');
        e.target.value = '';
      });
      this.q('plPrev').addEventListener('click', () => this.prev());
      this.q('plNext').addEventListener('click', () => this.next(false));
      this.q('layerRemove').addEventListener('click', () => removeLayer(this));
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
    loadFile(file) { this.loadFiles([file]); }

    loadFiles(files) {
      const items = files.map((file) => ({
        name: (file.webkitRelativePath || file.name),
        path: api && api.getPath ? api.getPath(file) : '',
        file
      }));
      items.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
      this.list = items;
      this.idx = 0;
      this.history = [];
      this.fails = 0;
      this.media = items[0];
      this.q('source').value = 'file';
      this.setSource('file');
    }

    updatePlaylistUi() {
      const n = this.list.length;
      this.q('fileName').textContent = this.media ? this.media.name.split('/').pop() : 'No file chosen';
      this.q('plRow').hidden = n < 2;
      this.q('plPos').textContent = n > 1 ? `${this.idx + 1} / ${n}` : '';
    }

    // move to another item of the playlist, reusing the same <video>
    playIndex(i, pushHistory = true) {
      const c = this.cur;
      if (!c || c.type !== 'file' || !this.list.length) return;
      if (pushHistory && i !== this.idx) this.history.push(this.idx);
      this.idx = i;
      this.media = this.list[i];
      if (this.objectUrl) { URL.revokeObjectURL(this.objectUrl); this.objectUrl = null; }
      const m = this.media;
      if (m.path) c.node.src = fileUrl(m.path);
      else if (m.file) { this.objectUrl = URL.createObjectURL(m.file); c.node.src = this.objectUrl; }
      this.ab = { a: null, b: null };
      this.updateAB();
      this.updatePlaylistUi();
      if (!state.paused) c.node.play().catch(() => {});
    }

    next(auto) {
      const n = this.list.length;
      if (n < 2) return;
      let i;
      if (this.v('shuffle')) {
        do { i = Math.floor(Math.random() * n); } while (i === this.idx);
      } else {
        i = this.idx + 1;
        if (i >= n) {
          if (auto && !this.v('loop')) return; // end of list, loop is off
          i = 0;
        }
      }
      this.playIndex(i);
    }

    prev() {
      const n = this.list.length;
      if (n < 2) return;
      const i = this.history.length ? this.history.pop() : (this.idx - 1 + n) % n;
      this.playIndex(i, false);
    }

    setSource(type) {
      this.teardown();
      this.ab = { a: null, b: null };
      this.updateAB();
      this.ui.querySelectorAll('[data-g]').forEach((g) => { g.hidden = g.dataset.g !== type; });
      if (type === 'spiral') this.buildSpiral();
      else if (type === 'file' && this.media) { this.buildFile(); }
      else if (type === 'url' && this.q('urlInput').value.trim()) this.buildUrl(this.q('urlInput').value);
      this.apply();
    }

    teardown() {
      const c = this.cur;
      if (c) {
        if (c.r) c.r.stop();
        if (c.ro) c.ro.disconnect();
        if (c.cleanup) c.cleanup();
        if (c.hello) clearInterval(c.hello);
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
      const vid = document.createElement('video');
      vid.className = 'fill';
      vid.loop = true;
      vid.playsInline = true;
      vid.addEventListener('error', () => this.onVideoError());
      vid.addEventListener('playing', () => { this.fails = 0; });
      vid.addEventListener('ended', () => { if (this.list.length > 1) this.next(true); });
      this.root.appendChild(vid);
      this.cur = { type: 'file', node: vid };
      this.seekTimer = setInterval(() => this.tick(), 200);
      this.playIndex(this.idx, false);
    }

    onVideoError() {
      const name = this.media ? this.media.name.split('/').pop() : 'this video';
      this.fails++;
      if (this.list.length > 1 && this.fails < this.list.length) {
        toast(`Skipped "${name}". Its format is not supported. Convert it to MP4 (H.264 video + AAC audio) to play it.`, 6000);
        this.next(true);
        if (this.list.length > 1 && this.idx === 0 && !this.v('loop')) return;
        return;
      }
      toast(`Can't play "${name}". The format may not be supported here (common with AVI, WMV, or HEVC/H.265 files). Convert it to MP4 with H.264 video and AAC audio, for example with the free HandBrake.`, 12000);
    }

    buildUrl(raw) {
      const status = this.q('status');
      const src = toEmbedUrl(raw);
      const isYt = /^https:\/\/www\.youtube\.com\/embed\//.test(src);
      const isVid = /\.(mp4|webm|m4v|mov|ogv|ogg)(\?|#|$)/i.test(src);
      let node;
      const c = { type: 'url', kind: isYt ? 'yt' : isVid ? 'video' : 'page', ready: false, yt: { t: 0, d: 0 } };
      if (isVid) {
        node = document.createElement('video');
        node.src = src;
        node.playsInline = true;
        node.loop = true;
        node.addEventListener('loadeddata', () => { c.ready = true; status.textContent = ''; });
        node.addEventListener('error', () => { status.textContent = "Couldn't play this video link. It may need to be a direct link to a video file."; });
        status.textContent = 'Loading\u2026';
        if (!state.paused) node.play().catch(() => {});
      } else {
        node = document.createElement('iframe');
        node.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
        node.setAttribute('allowfullscreen', '');
        node.referrerPolicy = 'strict-origin-when-cross-origin';
        let u = src;
        if (isYt) u += (u.includes('?') ? '&' : '?') + 'enablejsapi=1&playsinline=1&origin=' + encodeURIComponent(location.origin);
        node.src = u;
        status.textContent = isYt
          ? 'Loading YouTube\u2026 if it does not start, tap play inside the video. Some videos do not allow embedding.'
          : 'Most websites refuse to be shown inside another page. YouTube links and direct video links work best.';
        if (isYt) {
          const onMsg = (e) => {
            if (e.source !== node.contentWindow || typeof e.data !== 'string') return;
            let d; try { d = JSON.parse(e.data); } catch (_) { return; }
            if (d.event === 'onReady' || d.event === 'initialDelivery') { c.ready = true; this.pokeWeb(); }
            const i = d.info;
            if (i) {
              if (typeof i.currentTime === 'number') c.yt.t = i.currentTime;
              if (typeof i.duration === 'number') c.yt.d = i.duration;
              c.ready = true;
              if (i.playerState === 0 && this.v('forceLoop')) this.ytCmd('seekTo', [0, true]), this.ytCmd('playVideo');
            }
          };
          window.addEventListener('message', onMsg);
          c.cleanup = () => window.removeEventListener('message', onMsg);
          const hello = () => { try { node.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), '*'); } catch (_) {} };
          node.addEventListener('load', () => { hello(); c.hello = setInterval(() => { if (c.ready) { clearInterval(c.hello); } else hello(); }, 700); });
        }
      }
      node.className = 'fill';
      c.node = node;
      this.root.appendChild(node);
      this.cur = c;
      this.timer = setInterval(() => this.pokeWeb(), 2000);
      this.seekTimer = setInterval(() => this.tick(), 250);
    }

    ytCmd(func, args) {
      const c = this.cur;
      if (!c || c.kind !== 'yt') return;
      try { c.node.contentWindow.postMessage(JSON.stringify({ event: 'command', func, args: args || [] }), '*'); } catch (_) {}
    }

    pokeWeb() {
      const c = this.cur;
      if (!c || c.type !== 'url') return;
      const loop = this.v('forceLoop'), vol = this.v('webVolume');
      if (c.kind === 'video') {
        c.node.loop = loop; c.node.volume = vol;
        if (state.paused) c.node.pause(); else if (c.node.paused && !c.node.ended) c.node.play().catch(() => {});
      } else if (c.kind === 'yt') {
        this.ytCmd('setVolume', [Math.round(vol * 100)]);
        this.ytCmd('setLoop', [!!loop]);
        if (state.paused) this.ytCmd('pauseVideo');
      }
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
      } else if (c.type === 'url') {
        if (c.kind === 'video') this.showTime('web', c.node.currentTime, c.node.duration);
        else if (c.kind === 'yt') this.showTime('web', c.yt.t, c.yt.d);
        else this.showTime('web', 0, 0);
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
      } else if (c.type === 'url') {
        if (c.kind === 'video' && isFinite(c.node.duration)) c.node.currentTime = frac * c.node.duration;
        else if (c.kind === 'yt' && c.yt.d > 0) { c.yt.t = frac * c.yt.d; this.ytCmd('seekTo', [frac * c.yt.d, true]); }
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
          mode: Number(this.v('pattern')) || 0,
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
        c.node.loop = this.list.length <= 1 ? this.v('loop') : false;
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
      else if (c.type === 'url') { if (c.kind === 'yt') this.ytCmd(p ? 'pauseVideo' : 'playVideo'); else this.pokeWeb(); }
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
        list: this.list.filter((i) => i.path).map((i) => ({ name: i.name, path: i.path })),
        idx: this.idx,
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
      this.list = Array.isArray(s.list) && s.list.length
        ? s.list.map((i) => ({ name: i.name, path: i.path, file: null }))
        : (s.media && s.media.path ? [{ name: s.media.name, path: s.media.path, file: null }] : []);
      this.idx = Math.min(Math.max(parseInt(s.idx, 10) || 0, 0), Math.max(this.list.length - 1, 0));
      this.history = [];
      this.media = this.list[this.idx] || null;
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
    [['bgVol', (v) => Math.round(v * 100) + '%']].forEach(([id, f]) => {
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

  // ---------------------------------------------------------------- Audio boxes
  const audios = [];
  const MAX_AUDIOS = (window.matchMedia && matchMedia('(pointer: coarse)').matches) ? 3 : 6;
  let aFade = 1;
  const AUDIO_EXT = /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|wma|aif|aiff|webm)$/i;

  const plUrl = (it) => {
    if (it.path) return fileUrl(it.path);
    if (!it.blob && it.file) it.blob = URL.createObjectURL(it.file);
    return it.blob || '';
  };

  class AudioBox {
    constructor(index) {
      this.audio = new Audio();
      this.audio.preload = 'auto';
      this.items = [];
      this.idx = -1;
      this.seeking = false;
      this.was = false;
      this.ab = { a: null, b: null };
      this.ui = $('#audioTpl').content.firstElementChild.cloneNode(true);
      $('#audioBoxes').appendChild(this.ui);
      this.wire();
      this.setIndex(index);
      this.render();
      this.settings();
    }

    q(k) { return this.ui.querySelector(`[data-k="${k}"]`); }

    setIndex(i) {
      this.index = i;
      this.q('title').textContent = 'Audio ' + (i + 1);
    }

    settings() {
      const a = this.audio;
      a.volume = Math.min(1, parseFloat(this.q('vol').value) * aFade);
      a.playbackRate = parseFloat(this.q('speed').value);
      a.loop = this.q('loop').value === 'one';
      this.q('vol').parentElement.querySelector('output').textContent = Math.round(parseFloat(this.q('vol').value) * 100) + '%';
      this.q('speed').parentElement.querySelector('output').textContent = this.q('speed').value + 'x';
    }

    render() {
      const ul = this.q('list');
      ul.innerHTML = '';
      this.items.forEach((it, i) => {
        const li = document.createElement('li');
        if (i === this.idx) li.className = 'cur';
        const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = it.name;
        const x = document.createElement('span'); x.className = 'x'; x.textContent = '✕'; x.title = 'Remove';
        x.addEventListener('click', (e) => { e.stopPropagation(); this.removeTrack(i); });
        li.addEventListener('click', () => this.playTrack(i));
        li.append(nm, x);
        ul.appendChild(li);
      });
      this.q('empty').hidden = this.items.length > 0;
      this.q('play').textContent = (!this.audio.paused && !this.audio.ended) ? 'Pause' : 'Play';
    }

    playTrack(i) {
      const n = this.items.length;
      if (!n) return;
      this.idx = ((i % n) + n) % n;
      this.ab = { a: null, b: null };
      this.updateAB();
      this.audio.src = plUrl(this.items[this.idx]);
      this.settings();
      if (!state.paused) this.audio.play().catch(() => {}); else this.was = true;
      this.render();
    }

    addFiles(files, sort) {
      const wasEmpty = this.items.length === 0;
      let add = files.map((f) => ({ name: f.name, path: api && api.getPath ? api.getPath(f) : '', file: f }));
      if (sort) add.sort((x, y) => x.name.localeCompare(y.name, undefined, { numeric: true, sensitivity: 'base' }));
      this.items.push(...add);
      this.render();
      if (wasEmpty && this.items.length) this.playTrack(0);
    }

    nextIndex(dir) {
      const n = this.items.length;
      if (n > 1 && this.q('shuffle').checked && dir > 0) {
        let j; do { j = Math.floor(Math.random() * n); } while (j === this.idx);
        return j;
      }
      return this.idx + dir;
    }

    removeTrack(i) {
      const it = this.items[i];
      if (it && it.blob) URL.revokeObjectURL(it.blob);
      this.items.splice(i, 1);
      if (i === this.idx) { this.audio.pause(); this.audio.removeAttribute('src'); this.idx = -1; }
      else if (i < this.idx) this.idx--;
      this.render();
    }

    wire() {
      const a = this.audio;
      a.addEventListener('ended', () => {
        const mode = this.q('loop').value;
        if (mode === 'one') return;
        const n = this.items.length;
        if (mode === 'all' || this.idx < n - 1) this.playTrack(this.nextIndex(1)); else this.render();
      });
      a.addEventListener('play', () => this.render());
      a.addEventListener('pause', () => this.render());
      a.addEventListener('error', () => { if (a.src) toast("Couldn't play that audio file. Add it again, or convert it to MP3.", 5000); });
      a.addEventListener('timeupdate', () => {
        const dd = a.duration, t = a.currentTime;
        const ok = isFinite(dd) && dd > 0;
        this.q('time').textContent = ok ? `${fmtTime(t)} / ${fmtTime(dd)}` : '0:00 / 0:00';
        this.q('seek').disabled = !ok;
        if (ok && !this.seeking) this.q('seek').value = Math.round((t / dd) * 1000);
      });
      this.q('add').addEventListener('click', () => this.q('input').click());
      this.q('input').addEventListener('change', (e) => {
        this.addFiles([...e.target.files]);
        e.target.value = '';
      });
      this.q('addDir').addEventListener('click', () => this.q('dirInput').click());
      this.q('dirInput').addEventListener('change', (e) => {
        const all = [...e.target.files];
        const fs = all.filter((f) => (f.type || '').startsWith('audio/') || AUDIO_EXT.test(f.name));
        if (fs.length) this.addFiles(fs, true);
        else if (all.length) toast('No audio files were found in that folder.');
        e.target.value = '';
      });
      this.q('play').addEventListener('click', () => {
        if (!this.items.length) return;
        if (this.idx < 0) { this.playTrack(0); return; }
        if (a.paused) { this.was = false; a.play().catch(() => {}); } else a.pause();
      });
      this.q('next').addEventListener('click', () => { if (this.items.length) this.playTrack(this.nextIndex(1)); });
      this.q('prev').addEventListener('click', () => { if (this.items.length) this.playTrack(this.idx - 1); });
      const seek = this.q('seek');
      seek.addEventListener('pointerdown', () => { this.seeking = true; });
      seek.addEventListener('pointerup', () => { this.seeking = false; });
      seek.addEventListener('change', () => { this.seeking = false; });
      seek.addEventListener('input', (e) => {
        if (isFinite(a.duration)) a.currentTime = (parseFloat(e.target.value) / 1000) * a.duration;
      });
      ['vol', 'speed', 'loop'].forEach((k) => {
        this.q(k).addEventListener('input', () => this.settings());
        this.q(k).addEventListener('change', () => this.settings());
      });
      this.q('abA').addEventListener('click', () => this.setAB('a'));
      this.q('abB').addEventListener('click', () => this.setAB('b'));
      this.q('abClear').addEventListener('click', () => { this.ab = { a: null, b: null }; this.updateAB(); });
      this.abTimer = setInterval(() => this.abCheck(), 100);
      this.q('remove').addEventListener('click', () => removeAudio(this));
    }

    setAB(which) {
      if (!this.audio.src) return;
      this.ab[which] = this.audio.currentTime;
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

    abCheck() {
      const { a, b } = this.ab;
      const au = this.audio;
      if (a != null && b != null && b > a && !au.paused && au.currentTime >= b) au.currentTime = a;
    }

    setFade(f) { aFade = f; this.settings(); }

    setPaused(p, was) {
      const a = this.audio;
      if (p && !was) { this.was = !a.paused; a.pause(); }
      else if (!p && was) { if (this.was && a.src) a.play().catch(() => {}); this.was = false; }
    }

    snapshot() {
      return {
        vals: { aLoop: this.q('loop').value, aShuffle: this.q('shuffle').checked, aVol: this.q('vol').value, aSpeed: this.q('speed').value },
        items: this.items.filter((i) => i.path).map((i) => ({ name: i.name, path: i.path }))
      };
    }

    restore(s) {
      const v = (s && s.vals) || {};
      if (v.aLoop) this.q('loop').value = v.aLoop;
      this.q('shuffle').checked = !!v.aShuffle;
      if (v.aVol != null) this.q('vol').value = v.aVol;
      if (v.aSpeed != null) this.q('speed').value = v.aSpeed;
      this.audio.pause(); this.audio.removeAttribute('src');
      this.items.forEach((i) => { if (i.blob) URL.revokeObjectURL(i.blob); });
      this.items = ((s && s.items) || []).map((i) => ({ name: i.name, path: i.path, file: null }));
      this.idx = -1;
      this.ab = { a: null, b: null };
      this.updateAB();
      this.settings(); this.render();
    }

    destroy() {
      clearInterval(this.abTimer);
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.items.forEach((i) => { if (i.blob) URL.revokeObjectURL(i.blob); });
      this.ui.remove();
    }
  }

  function makeAudio() {
    const A = new AudioBox(audios.length);
    audios.push(A);
    audios.forEach((x, i) => x.setIndex(i));
    return A;
  }

  function addAudio() {
    if (audios.length >= MAX_AUDIOS) { toast(`You can have up to ${MAX_AUDIOS} audio boxes on this device.`, 4000); return; }
    const A = makeAudio();
    renderEvents();
    A.ui.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function removeAudio(A) {
    if (audios.length <= 1) { toast('Keep at least one audio box.', 3000); return; }
    const i = audios.indexOf(A);
    if (i < 0) return;
    A.destroy();
    audios.splice(i, 1);
    audios.forEach((x, k) => x.setIndex(k));
    renderEvents();
    saveSoon();
  }

  function ensureAudios(n) {
    while (audios.length < n) makeAudio();
    while (audios.length > n && audios.length > 1) audios.pop().destroy();
    audios.forEach((x, k) => x.setIndex(k));
  }

  function audioOpts() { return audios.map((_, i) => [String(i + 1), 'Audio ' + (i + 1)]); }

  const addAudioBtn = $('#addAudio');
  if (addAudioBtn) addAudioBtn.addEventListener('click', addAudio);

  // ---------------------------------------------------------------- Session timer
  const timer = { id: null, end: 0, total: 0, fadeMs: 0, last: 0 };
  let masterOpacity = 1, fadeMul = 1;

  function applyStageOpacity() { stage.style.opacity = masterOpacity * fadeMul; }

  function setFade(f) {
    fadeMul = f;
    tone.setFade(f);
    bg.setFade(f);
    audios.forEach((a) => a.setFade(f));
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
    audios.forEach((a) => a.audio.pause());
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

  const TARGETS_TAIL = [['flash.interval', 'Flash text: every (s)'], ['flash.duration', 'Flash text: shown for (ms)'],
    ['flash.size', 'Flash text: size'], ['flash.opacity', 'Flash text: opacity'],
    ['tone.volume', 'Tone: volume'], ['tone.freq', 'Tone: frequency (Hz)'], ['tone.beat', 'Tone: beat (Hz)'],
    ['bg.volume', 'Background sound: volume'], ['master', 'Master opacity']];
  function targetList() {
    const t = [];
    layers.forEach((_, i) => {
      const n = i + 1;
      t.push([`l${n}.speed`, `Layer ${n} spiral: speed`], [`l${n}.arms`, `Layer ${n} spiral: arms`],
        [`l${n}.twist`, `Layer ${n} spiral: tightness`], [`l${n}.soft`, `Layer ${n} spiral: edge softness`],
        [`l${n}.pulse`, `Layer ${n} spiral: pulse`], [`l${n}.opacity`, `Layer ${n}: opacity`]);
    });
    audios.forEach((_, i) => {
      const n = i + 1;
      t.push([`a${n}.volume`, `Audio ${n}: volume`], [`a${n}.speed`, `Audio ${n}: speed`]);
    });
    return t.concat(TARGETS_TAIL);
  }
  function layerOpts() { return layers.map((_, i) => [String(i + 1), 'Layer ' + (i + 1)]); }
  const TARGET_SEL = {
    'flash.interval': '#fInterval', 'flash.duration': '#fDuration', 'flash.size': '#fSize', 'flash.opacity': '#fOpacity',
    'tone.volume': '#tVol', 'tone.freq': '#tFreq', 'tone.beat': '#tBeat', 'bg.volume': '#bgVol',
    master: '#mOpacity'
  };
  const BG_KINDS = [['rain', 'Rain'], ['ocean', 'Ocean waves'], ['wind', 'Wind'], ['brown', 'Brown noise'], ['pink', 'Pink noise'], ['white', 'White noise']];
  const ON_OFF = [['1', 'On'], ['0', 'Off']];
  const TYPE_LABEL = {
    set: 'Change a setting', colors: 'Change spiral colors', layer: 'Show or hide a layer', flash: 'Flashing text',
    script: 'Switch flash script', tone: 'Tone', bg: 'Background sound', audio: 'Audio file', end: 'End the session'
  };
  const DEFAULTS = {
    set: { target: 'l1.speed', value: 1, ramp: 0 }, colors: { layer: '1', a: '#8f6bff', b: '#0d0820' },
    layer: { layer: '1', source: 'spiral' }, flash: { on: '1' }, script: { name: '' }, tone: { on: '1' },
    bg: { on: '1', kind: 'rain' }, audio: { box: '1', action: 'play' }, end: { fade: 30 }
  };

  function ctlFor(target) {
    const m = /^l(\d+)\.(.+)$/.exec(target);
    if (m) { const L = layers[Number(m[1]) - 1]; return L ? L.q(m[2]) : null; }
    const am = /^(?:a(\d+)|audio)\.(volume|speed)$/.exec(target);
    if (am) { const A = audios[(am[1] ? Number(am[1]) : 1) - 1]; return A ? A.q(am[2] === 'volume' ? 'vol' : 'speed') : null; }
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
      case 'set': return [['target', 'select', targetList(), 'Setting', true], ['value', 'number', null, 'Value'], ['ramp', 'number', null, 'Change gradually over (s)', true]];
      case 'colors': return [['layer', 'select', layerOpts(), 'Layer'], ['a', 'color', null, 'Band color'], ['b', 'color', null, 'Dark color']];
      case 'layer': return [['layer', 'select', layerOpts(), 'Layer'], ['source', 'select', [['off', 'Off'], ['spiral', 'Built-in spiral']], 'Show']];
      case 'flash': return [['on', 'select', ON_OFF, 'Flashing text']];
      case 'script': return [['name', 'select', scriptOptions(), 'Script (saved in Subliminal text)', true]];
      case 'tone': return [['on', 'select', ON_OFF, 'Tone (uses your tone settings)', true]];
      case 'bg': return [['on', 'select', ON_OFF, 'Sound'], ['kind', 'select', BG_KINDS, 'Type']];
      case 'audio': return [['box', 'select', audioOpts(), 'Audio box'], ['action', 'select', [['play', 'Play'], ['pause', 'Pause'], ['next', 'Next track']], 'Action', true]];
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
      {
        const A = audios[(Number(e.box) || 1) - 1];
        if (!A) break;
        if (e.action === 'play') { if (A.items.length) { if (A.idx < 0) A.playTrack(0); else A.audio.play().catch(() => {}); } }
        else if (e.action === 'pause') A.audio.pause();
        else if (e.action === 'next') { if (A.items.length) A.playTrack(A.nextIndex(1)); }
        break;
      }
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
    audios.forEach((a) => a.setPaused(p, was));
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

  // ---------------------------------------------------------------- Adding and removing layers
  function makeLayer() {
    const L = new Layer(layers.length);
    layers.push(L);
    layers.forEach((l, i) => l.setIndex(i));
    return L;
  }

  function addLayer() {
    if (layers.length >= MAX_LAYERS) { toast(`You can have up to ${MAX_LAYERS} layers on this device.`, 4000); return; }
    const L = makeLayer();
    L.q('source').value = 'spiral';
    L.q('opacity').value = 0.5;
    L.q('reverse').checked = layers.length % 2 === 0;
    L.q('colorA').value = ['#8f6bff', '#4fd0c0', '#ff7ab8', '#ffd166', '#7ab8ff'][layers.length % 5];
    L.refreshOutputs();
    L.setSource('spiral');
    renderEvents();
    L.ui.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function removeLayer(L) {
    if (layers.length <= 1) { toast('Keep at least one layer.', 3000); return; }
    const i = layers.indexOf(L);
    if (i < 0) return;
    L.destroy();
    layers.splice(i, 1);
    layers.forEach((l, k) => l.setIndex(k));
    renderEvents();
    saveSoon();
  }

  function ensureLayers(n) {
    while (layers.length < n) makeLayer();
    while (layers.length > n && layers.length > 1) {
      const L = layers.pop();
      L.destroy();
    }
    layers.forEach((l, k) => l.setIndex(k));
  }

  const addBtn = $('#addLayer');
  if (addBtn) addBtn.addEventListener('click', addLayer);

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
      audio: { boxes: audios.map((x) => x.snapshot()) },
      timer: { tmMin: $('#tmMin').value, tmFade: $('#tmFade').value },
      session: withSession ? { events: sess.events, start: sess.start } : undefined
    };
  }

  function applyData(d) {
    if (!d || !Array.isArray(d.layers)) return;
    ensureLayers(Math.min(d.layers.length, MAX_LAYERS));
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
      const boxes = Array.isArray(d.audio.boxes) ? d.audio.boxes : [d.audio];
      ensureAudios(Math.min(Math.max(boxes.length, 1), MAX_AUDIOS));
      boxes.slice(0, audios.length).forEach((s, i) => audios[i].restore(s));
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
  makeLayer(); makeLayer(); makeAudio();
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

  if (seen) {
    accept();
  } else {
    $('#ack').addEventListener('click', () => {
      try { localStorage.setItem('spiralStageAck', '1'); } catch (_) { /* ignore */ }
      accept();
      setPaused(false);
    });
  }

  function saveSoon() { scheduleSave(); }
  window.__spiral = { state, layers, addLayer, removeLayer, setOverlay, onMode, tone, bg, audios, addAudio, removeAudio, capture, applyData, sess, run };
})();
