import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LEGACY_ON_CHANGE_WAIT_MS,
  createLegacyOnChangeThrottle,
} from './legacy-on-change';

// PR 466 review (#5): a new host `onChange` must not cancel the pending call.

describe('createLegacyOnChangeThrottle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = () => {
    let handler: ((d: unknown, u: string) => void) | undefined;
    const buildArgs = vi.fn(() => ({ data: 'plain', update: 'enc' }));
    const throttled = createLegacyOnChangeThrottle(() => handler, buildArgs);
    return {
      throttled,
      buildArgs,
      setHandler: (h: typeof handler) => {
        handler = h;
      },
    };
  };

  it('calls the host once, after the wait, with data and update', () => {
    const { throttled, setHandler } = make();
    const onChange = vi.fn();
    setHandler(onChange);
    throttled();
    throttled();
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(LEGACY_ON_CHANGE_WAIT_MS);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('plain', 'enc');
  });

  it('calls the handler the host holds when it fires, not the one at the edit', () => {
    const { throttled, setHandler } = make();
    const first = vi.fn();
    const second = vi.fn();
    setHandler(first);
    throttled();
    // The host re-renders with a new inline onChange before the wait is over.
    vi.advanceTimersByTime(LEGACY_ON_CHANGE_WAIT_MS / 2);
    setHandler(second);
    vi.advanceTimersByTime(LEGACY_ON_CHANGE_WAIT_MS);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('does not encode the document when the host has no handler', () => {
    const { throttled, buildArgs } = make();
    throttled();
    vi.advanceTimersByTime(LEGACY_ON_CHANGE_WAIT_MS);
    expect(buildArgs).not.toHaveBeenCalled();
  });

  it('cancel drops the pending call and flush sends it at once', () => {
    const { throttled, setHandler } = make();
    const onChange = vi.fn();
    setHandler(onChange);
    throttled();
    throttled.cancel();
    vi.advanceTimersByTime(LEGACY_ON_CHANGE_WAIT_MS);
    expect(onChange).not.toHaveBeenCalled();
    throttled();
    throttled.flush();
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
