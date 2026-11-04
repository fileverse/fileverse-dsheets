/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  applyCompactionChangesInChunks,
  canRunCompaction,
  createCompactionRetrier,
} from './use-celldata-compaction';
import { planYdocCompaction } from '../utils/compact-committed-celldata';

// K9: compaction runs from an idle callback. It must not start while a
// structural remount is pending (the engine still has the old grid), and a
// run that spans several chunks must stop when the document changes between
// chunks, because its plan (a whole-value borderInfo write included) was
// made from the document as it was.

const ID = 'dsheet-k9';

describe('canRunCompaction', () => {
  const refs = (remote: boolean, pending: boolean) => ({
    remoteUpdateRef: { current: remote },
    structuralRemountPendingRef: { current: pending },
  });

  it('is true when nothing is in progress', () => {
    expect(canRunCompaction(refs(false, false), false)).toBe(true);
  });

  it('is false during a remote apply', () => {
    expect(canRunCompaction(refs(true, false), false)).toBe(false);
  });

  it('is false while a structural remount is pending', () => {
    expect(canRunCompaction(refs(false, true), false)).toBe(false);
  });

  it('is false while collaboration is syncing', () => {
    expect(canRunCompaction(refs(false, false), true)).toBe(false);
  });
});

const GHOSTS = 6;

const seed = () => {
  const doc = new Y.Doc();
  doc.transact(() => {
    const arr = doc.getArray<any>(ID);
    const m = new Y.Map<any>();
    arr.push([m]);
    m.set('id', 'a');
    m.set('order', 0);
    const cd = new Y.Map<any>();
    // Ghosts: entries with no content.
    for (let i = 0; i < GHOSTS; i += 1)
      cd.set(`${i}_0`, { r: i, c: 0, v: null });
    cd.set('9_9', { r: 9, c: 9, v: { v: 'keep', m: 'keep' } });
    m.set('celldata', cd);
    m.set('config', new Y.Map());
  });
  return doc;
};

const celldataKeys = (doc: Y.Doc) => {
  const sheet = doc.getArray<any>(ID).get(0) as Y.Map<any>;
  return [...(sheet.get('celldata') as Y.Map<any>).keys()].sort();
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('applyCompactionChangesInChunks', () => {
  const stubIdle = (onIdle: () => void) => {
    vi.stubGlobal('window', {
      requestIdleCallback: (cb: () => void) => {
        onIdle();
        cb();
        return 0;
      },
      setTimeout: (cb: () => void) => {
        onIdle();
        cb();
        return 0;
      },
    });
  };

  const run = (doc: Y.Doc, chunkSize: number) => {
    const plan = planYdocCompaction(doc, ID);
    return applyCompactionChangesInChunks(
      doc,
      ID,
      plan.changes,
      () => {},
      () => false,
      { current: null },
      chunkSize,
    );
  };

  it('applies every chunk when nothing else touches the document', async () => {
    const doc = seed();
    stubIdle(() => {});
    expect(await run(doc, 2)).toBe(true);
    expect(celldataKeys(doc)).toEqual(['9_9']);
  });

  it('stops after the chunk during which the document changed', async () => {
    const doc = seed();
    let idleCalls = 0;
    stubIdle(() => {
      idleCalls += 1;
      if (idleCalls === 1) {
        // A peer (or the user) writes between chunk 1 and chunk 2.
        doc.transact(() => {
          const sheet = doc.getArray<any>(ID).get(0) as Y.Map<any>;
          (sheet.get('celldata') as Y.Map<any>).set('8_8', {
            r: 8,
            c: 8,
            v: { v: 'new', m: 'new' },
          });
        }, 'remote-peer');
      }
    });
    expect(await run(doc, 2)).toBe(false);
    // Chunk 1 (2 deletes) was applied; the rest were left for the next run.
    expect(celldataKeys(doc)).toEqual([
      '2_0',
      '3_0',
      '4_0',
      '5_0',
      '8_8',
      '9_9',
    ]);
  });

  it('stops without writing when it is cancelled', async () => {
    const doc = seed();
    stubIdle(() => {});
    const plan = planYdocCompaction(doc, ID);
    const done = await applyCompactionChangesInChunks(
      doc,
      ID,
      plan.changes,
      () => {},
      () => true,
      { current: null },
      2,
    );
    expect(done).toBe(false);
    expect(celldataKeys(doc)).toHaveLength(GHOSTS + 1);
  });
});

// PR 466 round 4 (N10): a run that was refused (gate closed) or stopped (the
// document changed between chunks) is tried again later, not once per open.
describe('createCompactionRetrier', () => {
  afterEach(() => vi.useRealTimers());

  const setup = (results: Array<'done' | 'retry'>, maxRetries?: number) => {
    vi.useFakeTimers();
    const attempt = vi.fn(async () => results.shift() ?? 'done');
    const retry = vi.fn();
    const retrier = createCompactionRetrier({
      attempt,
      retry,
      delayMs: 1_000,
      maxRetries,
    });
    return { attempt, retry, retrier };
  };

  it('does not schedule anything after a finished run', async () => {
    const { retry, retrier } = setup(['done']);
    await retrier.run();
    vi.advanceTimersByTime(60_000);
    expect(retry).not.toHaveBeenCalled();
  });

  it('asks for another run after the delay when a run must be retried', async () => {
    const { retry, retrier } = setup(['retry']);
    await retrier.run();
    expect(retry).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('stops after the maximum number of retries', async () => {
    const { retry, retrier } = setup(['retry', 'retry', 'retry', 'retry'], 2);
    for (let i = 0; i < 4; i += 1) {
      await retrier.run();
      vi.advanceTimersByTime(1_000);
    }
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it('cancel clears the pending retry', async () => {
    const { retry, retrier } = setup(['retry']);
    await retrier.run();
    retrier.cancel();
    vi.advanceTimersByTime(10_000);
    expect(retry).not.toHaveBeenCalled();
  });
});
