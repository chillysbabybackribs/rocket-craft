/** Agent-tab only: bump a counter when the SPA route changes via pushState/replaceState/popstate. */

export const SPA_HOOK = `(function(){
  if (globalThis.__rocketSpaHook) return;
  globalThis.__rocketSpaHook = true;
  let seq = 0;
  const bump = () => {
    seq += 1;
    globalThis.__rocketSpaNavigation = { seq, hash: location.hash, href: location.href, at: Date.now() };
  };
  bump();
  const wrap = (fn) => function(...args) { const out = fn.apply(this, args); bump(); return out; };
  history.pushState = wrap(history.pushState);
  history.replaceState = wrap(history.replaceState);
  addEventListener('popstate', bump);
  addEventListener('hashchange', bump);
})()`
