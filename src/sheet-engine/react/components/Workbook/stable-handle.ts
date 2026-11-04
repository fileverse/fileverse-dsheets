/**
 * An object with the keys of `getLatest()` whose identity never changes. Each
 * function member calls the function of the same name on the latest api, and
 * each other member reads the latest value, so a host that keeps the handle
 * across renders always sees current state (E3). The key set is taken from the
 * first call and is expected to stay the same.
 */
export function createStableHandle<T extends object>(getLatest: () => T): T {
  const handle = {} as T;
  (Object.keys(getLatest()) as (keyof T)[]).forEach((key) => {
    if (typeof getLatest()[key] === 'function') {
      Object.defineProperty(handle, key, {
        enumerable: true,
        configurable: true,
        writable: true,
        value: (...args: unknown[]) =>
          (getLatest()[key] as unknown as (...a: unknown[]) => unknown)(
            ...args,
          ),
      });
    } else {
      Object.defineProperty(handle, key, {
        enumerable: true,
        configurable: true,
        get: () => getLatest()[key],
      });
    }
  });
  return handle;
}
