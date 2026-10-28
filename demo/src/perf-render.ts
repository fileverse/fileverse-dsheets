// Demo-only render counter, active with ?perfRender=1. Must be imported before
// react-dom so the DevTools-style hook exists when React injects itself.
// window.__perfRender.reset() / .snapshot() -> { commits, renders, mounts, byName }.
type Fiber = {
  tag: number;
  type: any;
  flags: number;
  alternate: Fiber | null;
  child: Fiber | null;
  sibling: Fiber | null;
};

if (new URLSearchParams(window.location.search).get('perfRender') === '1') {
  const PERFORMED_WORK = 1;
  const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15]);
  let commits = 0;
  let byName: Record<string, number> = {};

  const nameOf = (f: Fiber) => {
    const t = f.type;
    if (!t) return 'anonymous';
    return (
      t.displayName ||
      t.name ||
      t.render?.displayName ||
      t.render?.name ||
      t.type?.displayName ||
      t.type?.name ||
      `anonymous(tag${f.tag})`
    );
  };

  // Same rule as React DevTools: only descend where the child pointer changed;
  // a bailed-out subtree keeps old flags and must not be counted again.
  let mounts = 0;
  const walk = (next: Fiber, prev: Fiber | null) => {
    if (!prev) {
      mounts += 1;
      return;
    }
    if (COMPONENT_TAGS.has(next.tag) && (next.flags & PERFORMED_WORK) !== 0) {
      const n = nameOf(next);
      byName[n] = (byName[n] || 0) + 1;
    }
    if (next.child !== prev.child) {
      for (let c = next.child; c; c = c.sibling) walk(c, c.alternate);
    }
  };

  let nextId = 1;
  (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    isDisabled: false,
    renderers: new Map(),
    inject() {
      return nextId++;
    },
    checkDCE() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onCommitFiberRoot(_id: number, root: { current: Fiber }) {
      commits += 1;
      const cur = root.current;
      if (cur.alternate) walk(cur, cur.alternate);
    },
  };

  (window as any).__perfRender = {
    reset() {
      commits = 0;
      mounts = 0;
      byName = {};
    },
    snapshot() {
      const renders = Object.values(byName).reduce((a, b) => a + b, 0);
      return { commits, renders, mounts, byName: { ...byName } };
    },
  };
}

export {};
