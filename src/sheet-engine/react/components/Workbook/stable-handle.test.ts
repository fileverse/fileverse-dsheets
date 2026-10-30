import { describe, expect, it, vi } from 'vitest';
import { createStableHandle } from './stable-handle';

const makeApi = (tag: string) => ({
  getTag: () => tag,
  add: (a: number, b: number) => a + b,
  value: tag.length,
});

describe('createStableHandle', () => {
  it('has the keys of the first api and does not change identity', () => {
    let latest = makeApi('one');
    const handle = createStableHandle(() => latest);
    const first = handle;
    latest = makeApi('three');
    expect(handle).toBe(first);
    expect(Object.keys(handle).sort()).toEqual(['add', 'getTag', 'value']);
  });

  it('calls the latest api, not the one it was built from', () => {
    let latest = makeApi('one');
    const handle = createStableHandle(() => latest);
    expect(handle.getTag()).toBe('one');
    latest = makeApi('two');
    expect(handle.getTag()).toBe('two');
  });

  it('forwards arguments and the return value', () => {
    const add = vi.fn((a: number, b: number) => a + b);
    const handle = createStableHandle(() => ({ add }));
    expect(handle.add(2, 3)).toBe(5);
    expect(add).toHaveBeenCalledWith(2, 3);
  });

  it('reads non-function members from the latest api', () => {
    let latest = makeApi('one');
    const handle = createStableHandle(() => latest);
    expect(handle.value).toBe(3);
    latest = makeApi('three');
    expect(handle.value).toBe(5);
  });

  it('lets a host assign extra methods onto the handle', () => {
    const handle = createStableHandle(() => makeApi('one')) as Record<
      string,
      unknown
    >;
    handle.refreshIndexedDB = () => 'ok';
    expect((handle.refreshIndexedDB as () => string)()).toBe('ok');
  });
});
