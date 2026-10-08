// Web-only extras: keep the screen awake, register the offline worker, and lighter defaults on phones.
(() => {
  'use strict';

  let lock = null;
  async function keepAwake() {
    try {
      if (!('wakeLock' in navigator) || lock) return;
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => { lock = null; });
    } catch (_) { /* not allowed right now */ }
  }
  document.addEventListener('click', keepAwake, { once: true });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') keepAwake(); });

  // Phones get lighter spiral settings the first time (a saved setup keeps whatever you chose).
  let hasSaved = false;
  try { hasSaved = !!localStorage.getItem('ss.last'); } catch (_) { /* storage blocked */ }
  if (!hasSaved && window.matchMedia('(pointer: coarse)').matches) {
    const fps = document.querySelector('#pFps'), sc = document.querySelector('#pScale');
    fps.value = '30'; fps.dispatchEvent(new Event('change', { bubbles: true }));
    sc.value = '0.75'; sc.dispatchEvent(new Event('change', { bubbles: true }));
  }

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
  }
})();
