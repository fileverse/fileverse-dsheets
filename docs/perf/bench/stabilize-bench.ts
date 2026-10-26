/**
 * Node benchmark harness for TEC-3277 (dSheet Stabilize).
 *
 * Run from the repo root:
 *   npx vite-node docs/perf/bench/stabilize-bench.ts -- <label>
 *
 * Writes docs/perf/bench/results/<label>.json and prints a table.
 * Uses the package's own yjs, lodash and write helper (updateYdocSheetData),
 * so cell objects go through the same Yjs write path the editor uses.
 *
 * Scenarios mirror ticket section 2:
 *   S1 package work per local edit (today's handleOnChange body)
 *   S2 work per received remote update (SyncManager remote-apply path)
 *   S3 Yjs side of one per-feature hook firing (ySheetArrayToPlain)
 *   S4 small 100-row sheet with 100 sessions of history
 *   S5 change-detection signal: state vector, Y.snapshot, A1 fingerprint
 */
import fs from 'fs';
import path from 'path';
import * as Y from 'yjs';
import { fromUint8Array } from 'js-base64';
import throttle from 'lodash/throttle';
import {
  updateYdocSheetData,
  ySheetArrayToPlain,
  type SheetChangePath,
} from '../../../src/editor/utils/update-ydoc';
import { calcChainYdocUpdate } from '../../../src/editor/utils/calc-chain-ydoc-update';
import { dataVerificationYdocUpdate } from '../../../src/editor/utils/data-verification-ydoc-update';
import { configYdocUpdate } from '../../../src/editor/utils/config-ydoc-update';
import { getSheetWithLatestCelldata } from '../../../src/sheet-engine/core/api/common';

const label = process.argv.slice(2).filter((a) => a !== '--')[0] ?? 'run';
const DSHEET_ID = 'bench-dsheet';
const noop = () => {};

// ---------------------------------------------------------------- utilities

const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

type Stat = { median: number; p95: number; min: number; runs: number };

const measure = (fn: () => void, runs: number, warmup = 2): Stat => {
  for (let i = 0; i < warmup; i += 1) fn();
  const samples: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const pick = (q: number) =>
    samples[Math.min(samples.length - 1, Math.floor(q * samples.length))];
  return {
    median: +pick(0.5).toFixed(3),
    p95: +pick(0.95).toFixed(3),
    min: +samples[0].toFixed(4),
    runs,
  };
};

/** Realistic cell object: numbers, text, some formatting. */
const makeCell = (r: number, c: number, rand: () => number, tag = '') => {
  const kind = (r + c) % 4;
  const v: Record<string, unknown> =
    kind === 0
      ? { v: Math.round(rand() * 1e6) / 100, ct: { fa: 'General', t: 'n' } }
      : kind === 1
        ? { v: `Item ${r}-${c}${tag}`, ct: { fa: '@', t: 's' } }
        : kind === 2
          ? {
              v: Math.round(rand() * 1000),
              ct: { fa: '#,##0.00', t: 'n' },
              bl: 1,
              fc: '#1f2937',
            }
          : { v: `note ${tag}${Math.round(rand() * 1e4)}`, ct: { fa: 'General', t: 'g' }, ff: 1, fs: 11 };
  v.m = String(v.v);
  return { r, c, v };
};

const newSheetMap = (id: string, order: number) => {
  const sheet = new Y.Map<any>();
  sheet.set('id', id);
  sheet.set('name', `Sheet${order + 1}`);
  sheet.set('order', order);
  sheet.set('status', order === 0 ? 1 : 0);
  sheet.set('celldata', new Y.Map());
  sheet.set('config', new Y.Map());
  sheet.set('calcChain', new Y.Map());
  sheet.set('dataVerification', new Y.Map());
  sheet.set('luckysheet_conditionformat_save', new Y.Array());
  return sheet;
};

const cellChange = (
  sheetId: string,
  cell: { r: number; c: number; v: unknown },
): SheetChangePath => ({
  sheetId,
  path: ['celldata'],
  key: `${cell.r}_${cell.c}`,
  value: cell,
});

const buildDoc = (tabs: number, rows: number, cols: number, seed = 1) => {
  const doc = new Y.Doc();
  const arr = doc.getArray<any>(DSHEET_ID);
  doc.transact(() => {
    for (let t = 0; t < tabs; t += 1) arr.push([newSheetMap(`s${t}`, t)]);
  });
  const rand = mulberry32(seed);
  for (let t = 0; t < tabs; t += 1) {
    const changes: SheetChangePath[] = [];
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        changes.push(cellChange(`s${t}`, makeCell(r, c, rand)));
      }
    }
    updateYdocSheetData(doc, DSHEET_ID, changes, noop);
  }
  return doc;
};

const storeStats = (doc: Y.Doc) => {
  let structs = 0;
  doc.store.clients.forEach((list) => {
    structs += list.length;
  });
  const ds = Y.createDeleteSetFromStructStore(doc.store);
  let deleted = 0;
  ds.clients.forEach((items) =>
    items.forEach((item) => {
      deleted += item.len;
    }),
  );
  return { structs, deletedLen: deleted, clients: doc.store.clients.size };
};

/** Today's handleOnChange body (editor-context.tsx). */
const handleOnChangeBody = (doc: Y.Doc) => {
  const encoded = fromUint8Array(Y.encodeStateAsUpdate(doc));
  const plain = ySheetArrayToPlain(doc.getArray(DSHEET_ID) as any);
  return encoded.length + plain.length;
};

// ---------------------------------------------------------------- scenarios

const results: Record<string, unknown> = {
  label,
  date: new Date().toISOString(),
  node: process.version,
  yjs: JSON.parse(
    fs.readFileSync(path.resolve('node_modules/yjs/package.json'), 'utf8'),
  ).version,
};
const log = (name: string, value: unknown) => {
  results[name] = value;
  console.log(name.padEnd(48), JSON.stringify(value));
};

// Modules added by Stabilize; absent on the base commit.
const fpMod = await import('../../../src/editor/utils/content-fingerprint').catch(
  () => null,
);
const cc = await import('../../../src/editor/utils/content-change').catch(
  () => null,
);

// S1: package work per local edit
for (const tabs of [1, 3]) {
  const doc = buildDoc(tabs, 4000, 25);
  const rand = mulberry32(99);
  let i = 0;
  const editOnly = measure(() => {
    i += 1;
    updateYdocSheetData(
      doc,
      DSHEET_ID,
      [cellChange('s0', makeCell(i % 4000, i % 25, rand, `e${i}`))],
      noop,
    );
  }, 30);
  const perEdit = measure(() => {
    i += 1;
    updateYdocSheetData(
      doc,
      DSHEET_ID,
      [cellChange('s0', makeCell(i % 4000, i % 25, rand, `e${i}`))],
      noop,
    );
    handleOnChangeBody(doc);
  }, 15);
  log(`S1 ${tabs}x(4000x25) Yjs write only`, editOnly);
  log(`S1 ${tabs}x(4000x25) write + handleOnChange body`, perEdit);
  if (cc && fpMod) {
    // A1: what onContentChange builds. Upper bound: it actually fires at
    // most once per second, not per edit.
    const live = new Y.Doc();
    const tracker = fpMod.attachContentFingerprint(live);
    const edits = cc.attachUserEditTracker(live, () => null);
    Y.applyUpdate(live, Y.encodeStateAsUpdate(doc), 'remote');
    log(`S1 ${tabs}x(4000x25) write + A1 change built`, measure(() => {
      i += 1;
      updateYdocSheetData(
        live,
        DSHEET_ID,
        [cellChange('s0', makeCell(i % 4000, i % 25, rand, `e${i}`))],
        noop,
      );
      ({
        hasContent: cc.computeHasContent(live, DSHEET_ID),
        userEdited: edits.userEdited(),
        fingerprint: tracker.getFingerprint(),
      });
    }, 30));
  }
  if (tabs === 1) {
    log('S1 1x(4000x25) encodeStateAsUpdate+base64', measure(() => {
      fromUint8Array(Y.encodeStateAsUpdate(doc));
    }, 15));
    log('S1 1x(4000x25) ySheetArrayToPlain', measure(() => {
      ySheetArrayToPlain(doc.getArray(DSHEET_ID) as any);
    }, 15));
    // S3: the Yjs side of getSheetYdocSyncContext is one ySheetArrayToPlain.
    log('S3 1x(4000x25) hook firing (Yjs side)', measure(() => {
      ySheetArrayToPlain(doc.getArray(DSHEET_ID) as any);
    }, 15));

    // S3 real hooks: the editor's per-feature sync functions, with an editor
    // ref backed by an engine context holding the same sheet as a dense grid.
    // getSheet is the engine's real WorkbookInstance.getSheet body.
    const plain = ySheetArrayToPlain(doc.getArray(DSHEET_ID) as any) as any[];
    const dense = Array.from({ length: 4000 }, () => Array(25).fill(null));
    plain[0].celldata.forEach((e: any) => {
      dense[e.r][e.c] = e.v;
    });
    const engineCtx: any = {
      currentSheetId: 's0',
      luckysheetfile: [
        { ...plain[0], data: dense, celldata: undefined, calcChain: [], dataVerification: {} },
      ],
    };
    const sheetEditorRef: any = {
      current: {
        getWorkbookContext: () => engineCtx,
        getSheet: (opts: any = {}) => getSheetWithLatestCelldata(engineCtx, opts),
      },
    };
    const hookArgs = { sheetEditorRef, ydocRef: { current: doc }, dsheetId: DSHEET_ID };
    log('S3 1x(4000x25) calcChainYdocUpdate (real hook)', measure(() => {
      calcChainYdocUpdate(hookArgs);
    }, 15));
    log('S3 1x(4000x25) dataVerificationYdocUpdate (real hook)', measure(() => {
      dataVerificationYdocUpdate(hookArgs);
    }, 15));
    log('S3 1x(4000x25) configYdocUpdate (real hook)', measure(() => {
      configYdocUpdate(hookArgs);
    }, 15));

    // S2: receiver applies a one-cell remote delta, then SyncManager encodes
    // the whole doc for onLocalUpdate.
    const receiver = new Y.Doc();
    Y.applyUpdate(receiver, Y.encodeStateAsUpdate(doc));
    const deltas: Uint8Array[] = [];
    const sender = new Y.Doc();
    Y.applyUpdate(sender, Y.encodeStateAsUpdate(doc));
    sender.on('update', (u: Uint8Array) => deltas.push(u));
    for (let k = 0; k < 40; k += 1) {
      updateYdocSheetData(
        sender,
        DSHEET_ID,
        [cellChange('s0', makeCell(k, 3, rand, `remote${k}`))],
        noop,
      );
    }
    for (let k = 40; k < 120; k += 1) {
      updateYdocSheetData(
        sender,
        DSHEET_ID,
        [cellChange('s0', makeCell(k, 3, rand, `remote${k}`))],
        noop,
      );
    }
    let d = 0;
    log('S2 1x(4000x25) remote apply + full encode', measure(() => {
      Y.applyUpdate(receiver, deltas[d++], 'remote');
      fromUint8Array(Y.encodeStateAsUpdate(receiver));
    }, 40, 2));
    log('S2 1x(4000x25) remote apply only', measure(() => {
      Y.applyUpdate(receiver, deltas[d++], 'remote');
    }, 30, 2));
  }
}

// S4: small sheet with history
const ROWS = 100;
const COLS = 10;
const runSession = (doc: Y.Doc, s: number, rand: () => number) => {
  const sheetId = 's0';
  const cells = (doc.getArray<any>(DSHEET_ID).get(0) as Y.Map<any>).get(
    'celldata',
  ) as Y.Map<any>;
  const read = (r: number, c: number) => cells.get(`${r}_${c}`);
  // 1. insert a row near the top: rows 1..98 shift to 2..99, row 1 cleared.
  const shift: SheetChangePath[] = [];
  for (let r = ROWS - 1; r >= 2; r -= 1) {
    for (let c = 0; c < COLS; c += 1) {
      const prev = read(r - 1, c);
      if (prev) shift.push(cellChange(sheetId, { r, c, v: prev.v }));
    }
  }
  for (let c = 0; c < COLS; c += 1) {
    shift.push({ sheetId, path: ['celldata'], key: `1_${c}`, value: null, type: 'delete' });
  }
  updateYdocSheetData(doc, DSHEET_ID, shift, noop);
  // 2. fill 3 columns with colour.
  const fill: SheetChangePath[] = [];
  const bg = s % 2 === 0 ? '#fde68a' : '#bfdbfe';
  for (let r = 0; r < ROWS; r += 1) {
    for (let c = 0; c < 3; c += 1) {
      const prev = read(r, c);
      const v = prev?.v ?? { v: `x${r}`, m: `x${r}`, ct: { fa: 'General', t: 'g' } };
      fill.push(cellChange(sheetId, { r, c, v: { ...v, bg } }));
    }
  }
  updateYdocSheetData(doc, DSHEET_ID, fill, noop);
  // 3. re-save a dropdown column (one dataVerification entry per cell).
  const dv: SheetChangePath[] = [];
  for (let r = 0; r < ROWS; r += 1) {
    dv.push({
      sheetId,
      path: ['dataVerification'],
      key: `${r}_4`,
      value: {
        type: 'dropdown',
        value1: 'Open,In progress,Done,Blocked',
        checked: false,
        hintShow: false,
        prohibitInput: false,
      },
    });
  }
  updateYdocSheetData(doc, DSHEET_ID, dv, noop);
  // 4. save one conditional format (the list is written whole).
  updateYdocSheetData(
    doc,
    DSHEET_ID,
    [
      {
        sheetId,
        path: ['luckysheet_conditionformat_save'],
        value: [
          {
            type: 'default',
            cellrange: [{ row: [0, ROWS - 1], column: [5, 5] }],
            format: { textColor: '#991b1b', cellColor: '#fee2e2' },
            conditionName: 'greaterThan',
            conditionRange: [],
            conditionValue: [String(s)],
          },
        ],
      },
    ],
    noop,
  );
  // 5. type in 30 cells.
  const typed: SheetChangePath[] = [];
  for (let k = 0; k < 30; k += 1) {
    const r = Math.floor(rand() * ROWS);
    const c = 5 + Math.floor(rand() * 5);
    typed.push(cellChange(sheetId, makeCell(r, c, rand, `s${s}k${k}`)));
  }
  updateYdocSheetData(doc, DSHEET_ID, typed, noop);
};

const freshCopyOf = (doc: Y.Doc) => {
  const plain = ySheetArrayToPlain(doc.getArray(DSHEET_ID) as any) as any[];
  const fresh = new Y.Doc();
  const arr = fresh.getArray<any>(DSHEET_ID);
  fresh.transact(() => {
    plain.forEach((sheet, i) => {
      const m = newSheetMap(sheet.id, i);
      // Prelim Y types must be integrated before they can be written to.
      arr.push([m]);
      const cd = m.get('celldata') as Y.Map<any>;
      for (const cell of sheet.celldata) cd.set(`${cell.r}_${cell.c}`, cell);
      const dvMap = m.get('dataVerification') as Y.Map<any>;
      Object.entries(sheet.dataVerification ?? {}).forEach(([k, v]) =>
        dvMap.set(k, v),
      );
      (m.get('luckysheet_conditionformat_save') as Y.Array<any>).insert(
        0,
        sheet.luckysheet_conditionformat_save ?? [],
      );
    });
  });
  return fresh;
};

{
  // Each session is its own client, as each reopen is in the app.
  const rand = mulberry32(7);
  let doc = buildDoc(1, ROWS, COLS, 3);
  for (let s = 0; s < 100; s += 1) {
    const next = new Y.Doc();
    Y.applyUpdate(next, Y.encodeStateAsUpdate(doc));
    doc.destroy();
    doc = next;
    runSession(doc, s, rand);
  }
  const fresh = freshCopyOf(doc);
  const body = Y.encodeStateAsUpdate(doc);
  const freshBody = Y.encodeStateAsUpdate(fresh);
  log('S4 old 100x10 store', { ...storeStats(doc), bodyBytes: body.byteLength });
  log('S4 fresh copy store', { ...storeStats(fresh), bodyBytes: freshBody.byteLength });
  log('S4 old full encode', measure(() => Y.encodeStateAsUpdate(doc), 20));
  log('S4 fresh full encode', measure(() => Y.encodeStateAsUpdate(fresh), 20));
  log('S4 old full decode (new doc + apply)', measure(() => {
    Y.applyUpdate(new Y.Doc(), body);
  }, 10));
  log('S4 fresh full decode (new doc + apply)', measure(() => {
    Y.applyUpdate(new Y.Doc(), freshBody);
  }, 10));
  log('S4 old write + handleOnChange body', measure(() => {
    updateYdocSheetData(doc, DSHEET_ID, [cellChange('s0', makeCell(3, 7, rand, 'x'))], noop);
    handleOnChangeBody(doc);
  }, 20));

  // S5: change-detection signals on the old sheet.
  log('S5 old encodeStateVector+base64', measure(() => {
    fromUint8Array(Y.encodeStateVector(doc));
  }, 50));
  log('S5 old Y.snapshot+encodeSnapshot', measure(() => {
    Y.encodeSnapshot(Y.snapshot(doc));
  }, 30));

  const fp = fpMod;
  if (fp) {
    // Attach at creation and replay the body, as use-editor-sync does.
    const live = new Y.Doc();
    const tracker = fp.attachContentFingerprint(live);
    Y.applyUpdate(live, body);
    log('S5 old fingerprint getFingerprint()', measure(() => {
      tracker.getFingerprint();
    }, 50));
    log('S5 old fingerprintFromUpdate(body)', measure(() => {
      fp.fingerprintFromUpdate(body);
    }, 20));
    let k = 0;
    log('S5 old write with tracker attached', measure(() => {
      k += 1;
      updateYdocSheetData(live, DSHEET_ID, [cellChange('s0', makeCell(3, 7, rand, `t${k}`))], noop);
    }, 50));
    const bare = new Y.Doc();
    Y.applyUpdate(bare, body);
    log('S5 old write without tracker', measure(() => {
      k += 1;
      updateYdocSheetData(bare, DSHEET_ID, [cellChange('s0', makeCell(3, 7, rand, `t${k}`))], noop);
    }, 50));
    tracker.dispose();
    // Open: the tracker walks every struct the load integrates.
    log('S5 old open (apply body) with tracker', measure(() => {
      const d = new Y.Doc();
      fp.attachContentFingerprint(d);
      Y.applyUpdate(d, body);
    }, 10));
    log('S5 old open (apply body) without tracker', measure(() => {
      Y.applyUpdate(new Y.Doc(), body);
    }, 10));
  }
}

// S7: a remote batch of 50 cells on a 4000x25 sheet (A5).
// - plain snapshot patch (patchPlainCelldata) on 100k celldata entries
// - engine apply: today one produceWithPatches per cell (setContextWithProduce
//   without noHistory); A5 one produce for the batch (applyRemoteCells).
{
  const { patchPlainCelldata } = await import(
    '../../../src/editor/utils/patch-plain-celldata'
  );
  const rand = mulberry32(11);
  const base = Array.from({ length: 4000 * 25 }, (_, i) =>
    makeCell(Math.floor(i / 25), i % 25, rand),
  );
  const patches = Array.from({ length: 50 }, (_, k) => ({
    key: `${(k * 79) % 4000}_${k % 25}`,
    action: (k % 10 === 0 ? 'delete' : 'update') as 'delete' | 'update',
    v: { v: `remote ${k}`, m: `remote ${k}` },
  }));
  let copy: any[] = [];
  // Patching mutates, so time each run on a fresh copy.
  const timed: number[] = [];
  for (let i = 0; i < 15; i += 1) {
    copy = base.slice();
    const t0 = performance.now();
    patchPlainCelldata(copy, patches);
    timed.push(performance.now() - t0);
  }
  timed.sort((a, b) => a - b);
  log('S7 patchPlainCelldata, 50 cells into 100k (fresh copy each run)', {
    median: +timed[7].toFixed(3),
    p95: +timed[14].toFixed(3),
    runs: 15,
  });

  const { enablePatches, produce, produceWithPatches } = await import('immer');
  enablePatches();
  const { defaultContext } = await import('../../../src/sheet-engine/core/context');
  const { loadLocale } = await import('../../../src/sheet-engine/core/locale');
  const cellApi = await import('../../../src/sheet-engine/core/api/cell');
  await loadLocale('en');
  const makeEngineCtx = () => {
    const ctx: any = defaultContext({
      globalCache: { undoList: [], redoList: [] },
      cellInput: { current: null },
      fxInput: { current: null },
      canvas: { current: null },
      cellArea: { current: null },
      workbookContainer: { current: null },
    } as any);
    const data = Array.from({ length: 4000 }, (_, r) =>
      Array.from({ length: 25 }, (__, c) => base[r * 25 + c].v),
    );
    ctx.luckysheetfile = [
      { id: 's0', name: 'Sheet1', order: 0, status: 1, data, config: {}, calcChain: [] },
    ];
    ctx.currentSheetId = 's0';
    return ctx;
  };
  const cells = patches.map(({ key, action, v }) => {
    const [r, c] = key.split('_').map(Number);
    return { r, c, v: action === 'delete' ? null : v };
  });
  let engineCtx = makeEngineCtx();
  log('S7 engine apply, 50 cells: one produceWithPatches per cell', measure(() => {
    for (const { r, c, v } of cells) {
      [engineCtx] = produceWithPatches(engineCtx, (d: any) =>
        cellApi.applyRemoteCellValue(d, r, c, v, { id: 's0' }),
      ) as any;
    }
  }, 10));
  if ('applyRemoteCells' in cellApi) {
    engineCtx = makeEngineCtx();
    log('S7 engine apply, 50 cells: one produce (applyRemoteCells)', measure(() => {
      engineCtx = produce(engineCtx, (d: any) =>
        (cellApi as any).applyRemoteCells(d, cells, { id: 's0' }),
      );
    }, 10));
  }
}

// S8: engine hot spots per draw / per commit (C1, C2, C3, C6, C7).
{
  const { defaultContext } = await import('../../../src/sheet-engine/core/context');
  const { loadLocale } = await import('../../../src/sheet-engine/core/locale');
  await loadLocale('en');
  const textMod = await import('../../../src/sheet-engine/core/modules/text');
  const cfMod = await import('../../../src/sheet-engine/core/modules/ConditionFormat');
  const formulaMod = await import('../../../src/sheet-engine/core/modules/formula');
  const borderMod: any = await import('../../../src/sheet-engine/core/modules/border');
  const dvMod = await import('../../../src/sheet-engine/core/modules/dataVerification');
  const rand = mulberry32(21);
  const ROWS8 = 4000;
  const COLS8 = 25;
  const makeCtx8 = () => {
    const ctx: any = defaultContext({
      globalCache: { undoList: [], redoList: [] },
      cellInput: { current: null },
      fxInput: { current: null },
      canvas: { current: null },
      cellArea: { current: null },
      workbookContainer: { current: null },
    } as any);
    const data = Array.from({ length: ROWS8 }, (_, r) =>
      Array.from({ length: COLS8 }, (__, c) => makeCell(r, c, rand).v),
    );
    ctx.luckysheetfile = [
      { id: 's0', name: 'Sheet1', order: 0, status: 1, data, config: {}, calcChain: [] },
    ];
    ctx.currentSheetId = 's0';
    ctx.config = ctx.luckysheetfile[0].config;
    ctx.zoomRatio = 1;
    return ctx;
  };

  // C1: 1,000 visible cell texts measured on two consecutive frames.
  {
    const ctx = makeCtx8();
    let calls = 0;
    const renderCtx: any = {
      font: 'normal normal 400 14.6px Arial',
      textBaseline: 'top',
      measureText: (t: string) => {
        calls += 1;
        return { width: t.length * 7, actualBoundingBoxAscent: 0, actualBoundingBoxDescent: 11 };
      },
    };
    textMod.clearMeasureTextCache();
    const texts = Array.from({ length: 1000 }, (_, i) => `cell ${i}`);
    texts.forEach((t) => textMod.getMeasureText(t, renderCtx, ctx));
    const firstFrame = calls;
    calls = 0;
    const t0 = performance.now();
    texts.forEach((t) => textMod.getMeasureText(t, renderCtx, ctx));
    log('S8 C1 measureText calls, second frame of 1000 texts', {
      firstFrame,
      secondFrame: calls,
      secondFrameMs: +(performance.now() - t0).toFixed(3),
    });
  }

  // C2: one greaterThan rule over all 100k cells, repeated draws.
  {
    const ctx = makeCtx8();
    ctx.luckysheetfile[0].luckysheet_conditionformat_save = [
      {
        type: 'default',
        cellrange: [{ row: [0, ROWS8 - 1], column: [0, COLS8 - 1] }],
        format: { textColor: '#000', cellColor: '#ff0' },
        conditionName: 'greaterThan',
        conditionRange: [],
        conditionValue: ['500'],
      },
    ];
    log('S8 C2 getComputeMap per draw, 1 rule over 100k cells', measure(() => {
      cfMod.getComputeMap(ctx);
    }, 15));
  }

  // C3: plain-value commit with 500 formulas in the chain (cell not in it).
  {
    const ctx = makeCtx8();
    ctx.luckysheetfile[0].calcChain = Array.from({ length: 500 }, (_, i) => ({
      r: i,
      c: 24,
      id: 's0',
    }));
    ctx.luckysheetfile[0].dynamicArray = Array.from({ length: 50 }, (_, i) => ({
      r: i,
      c: 23,
      f: '=A1',
      data: [[1, 2], [3, 4]],
    }));
    log('S8 C3 delFunctionGroup, cell not in 500-entry chain', measure(() => {
      formulaMod.delFunctionGroup(ctx, 3000, 3, 's0');
    }, 200));
  }

  // C6: 300 border entries and 200 merges; one 50x20 viewport, repeated draws.
  {
    const ctx = makeCtx8();
    const borderInfo: any[] = [];
    const types = ['border-all', 'border-left', 'border-right', 'border-top', 'border-bottom', 'border-outside'];
    for (let i = 0; i < 300; i += 1) {
      const r = Math.floor(rand() * 200);
      const c = Math.floor(rand() * 20);
      borderInfo.push({
        rangeType: 'range',
        borderType: types[i % types.length],
        color: '#000',
        style: '1',
        range: [{ row: [r, r + 5], column: [c, c + 3] }],
      });
    }
    const merge: Record<string, any> = {};
    for (let i = 0; i < 200; i += 1) {
      const r = (i * 7) % 3000;
      const c = (i * 3) % 20;
      merge[`${r}_${c}`] = { r, c, rs: 2, cs: 2 };
      ctx.luckysheetfile[0].data[r][c] = { ...(ctx.luckysheetfile[0].data[r][c] ?? {}), mc: { r, c, rs: 2, cs: 2 } };
    }
    ctx.luckysheetfile[0].config.borderInfo = borderInfo;
    ctx.luckysheetfile[0].config.merge = merge;
    const draw = borderMod.getBorderInfoComputeRangeCached ?? borderMod.getBorderInfoComputeRange;
    log('S8 C6 border compute per draw, 300 entries, 200 merges', measure(() => {
      draw(ctx, 0, 49, 0, 19);
    }, 30));
  }

  // C7: 400 visible dropdown cells, 200 options each.
  {
    const ctx = makeCtx8();
    const options = Array.from({ length: 200 }, (_, i) => `opt${i}`).join(',');
    const item = { type: 'dropdown', value1: options, value2: '' };
    log('S8 C7 validateCellData for 400 dropdown cells, 200 options', measure(() => {
      for (let i = 0; i < 400; i += 1) dvMod.validateCellData(ctx, item, `opt${i % 250}`);
    }, 30));
  }
}

// S6: how many whole-doc encodes the legacy onChange throttle runs for 4
// edits 50 ms apart, then 10 edits 50 ms apart. Replays editor-context's
// throttle setup with lodash: base = call + flush() per write (removed by A1);
// Stabilize = trailing-only, no per-write flush.
{
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const run = async (edits: number, perWrite: (t: any) => void, opts?: object) => {
    let encodes = 0;
    const t = throttle(() => {
      encodes += 1;
    }, 1000, opts);
    for (let e = 0; e < edits; e += 1) {
      perWrite(t);
      await sleep(50);
    }
    await sleep(1100);
    t.flush();
    return encodes;
  };
  const base = (t: any) => {
    t();
    t.flush();
  };
  const stabilize = (t: any) => t();
  for (const edits of [4, 10]) {
    log(`S6 legacy onChange encodes, ${edits} edits 50 ms apart`, {
      base: await run(edits, base),
      stabilize: await run(edits, stabilize, { leading: false, trailing: true }),
    });
  }
}

const outDir = path.resolve('docs/perf/bench/results');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, `${label}.json`), JSON.stringify(results, null, 2));
console.log(`\nwrote ${path.join(outDir, `${label}.json`)}`);
