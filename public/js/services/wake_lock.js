// Обёртка над Screen Wake Lock API с автопереподключением при visibilitychange.

export function createWakeLock(deps = {}) {
  const getNav = deps.getNavigator ?? (() => (typeof navigator !== 'undefined' ? navigator : null));
  const getDoc = deps.getDocument ?? (() => (typeof document !== 'undefined' ? document : null));

  let sentinel = null;
  let wanted = false;
  let listenerBound = false;

  async function requestLock() {
    if (!wanted) return false;
    const nav = getNav();
    if (!nav || !nav.wakeLock || typeof nav.wakeLock.request !== 'function') return false;
    if (sentinel && !sentinel.released) return true;
    try {
      const lock = await nav.wakeLock.request('screen');
      if (!wanted) {
        try { await lock.release(); } catch { /* ignore */ }
        return false;
      }
      sentinel = lock;
      if (typeof lock.addEventListener === 'function') {
        lock.addEventListener('release', () => {
          if (sentinel === lock) sentinel = null;
        }, { once: true });
      }
      return true;
    } catch {
      return false;
    }
  }

  function onVisibilityChange() {
    const doc = getDoc();
    if (wanted && doc && doc.visibilityState === 'visible') {
      requestLock().catch(() => {});
    }
  }

  async function acquire() {
    wanted = true;
    const doc = getDoc();
    if (doc && !listenerBound && typeof doc.addEventListener === 'function') {
      doc.addEventListener('visibilitychange', onVisibilityChange);
      listenerBound = true;
    }
    return requestLock();
  }

  async function release() {
    wanted = false;
    const doc = getDoc();
    if (doc && listenerBound && typeof doc.removeEventListener === 'function') {
      doc.removeEventListener('visibilitychange', onVisibilityChange);
      listenerBound = false;
    }
    const lock = sentinel;
    sentinel = null;
    if (lock && typeof lock.release === 'function') {
      try { await lock.release(); } catch { /* ignore */ }
    }
  }

  return {
    acquire,
    release,
    isSupported: () => {
      const nav = getNav();
      return !!(nav && nav.wakeLock && typeof nav.wakeLock.request === 'function');
    },
    isActive: () => !!(sentinel && !sentinel.released),
  };
}

export default createWakeLock;
