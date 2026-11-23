import type { WorkbookInstance } from '@sheet-engine/react';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { configYdocUpdate } from './config-ydoc-update';
import { filterSelectYdocUpdate } from './filter-select-ydoc-update';
import { updateYdocSheetData, ySheetArrayToPlain } from './update-ydoc';

const workbookId = 'workbook';
const sheetId = 'sheet';
const initialRange = { row: [0, 2], column: [0, 1] };
const cell = { r: 0, c: 0, v: { v: 'Name' } };

function addSheet(
  selection: Record<string, number[]> = initialRange,
  config?: Record<string, unknown>,
) {
  const doc = new Y.Doc();
  const sheet = new Y.Map();
  sheet.set('id', sheetId);
  sheet.set('celldata', [cell]);
  sheet.set('filter_select', new Y.Map(Object.entries(selection)));
  if (config) {
    sheet.set('filter', new Y.Map([['0', { rowhidden: { 1: 0 } }]]));
    sheet.set('config', new Y.Map(Object.entries(config)));
  }
  doc.getArray(workbookId).push([sheet]);
  return { doc, sheet };
}

function load(doc: Y.Doc) {
  return ySheetArrayToPlain(doc.getArray<Y.Map<unknown>>(workbookId))[0];
}

function save(
  doc: Y.Doc,
  selection: typeof initialRange | undefined,
  config?: ReturnType<typeof load>['config'],
) {
  const onSave = vi.fn();
  const workbook = {
    getWorkbookContext: () => ({ currentSheetId: sheetId }),
    getSheet: () => ({ filter_select: selection, config }),
  } as WorkbookInstance;
  const args = {
    sheetEditorRef: { current: workbook },
    ydocRef: { current: doc },
    dsheetId: workbookId,
    handleContentPortal: onSave,
  };
  // The workbook syncs config before the filter range when clearing a filter.
  if (config) configYdocUpdate(args);
  filterSelectYdocUpdate(args);
  return onSave;
}

describe('saved filter range', () => {
  it('keeps an existing valid range and rules without rewriting it', () => {
    const { doc, sheet } = addSheet(initialRange, { rowhidden: { 1: 0 } });
    const map = sheet.get('filter_select');
    expect(load(doc).filter_select).toEqual(initialRange);
    expect(load(doc).filter).toEqual({ 0: { rowhidden: { 1: 0 } } });
    expect(save(doc, initialRange)).not.toHaveBeenCalled();
    expect(sheet.get('filter_select')).toBe(map);
    doc.destroy();
  });

  it.each([
    { rowhidden_manual: { 2: 0 }, rowhidden: { 1: 0, 2: 0 } },
    { rowhidden: { 1: 0, 2: 0 } },
  ])(
    'ignores an incomplete saved filter without rewriting the document',
    (config) => {
      const { doc, sheet } = addSheet({ row: [0, 2] }, config);
      const before = Y.encodeStateAsUpdate(doc);
      expect(load(doc)).toMatchObject({
        celldata: [cell],
        config: {
          rowhidden: { 2: 0 },
          rowhidden_manual: { 2: 0 },
          rowhidden_filter: {},
        },
      });
      expect(load(doc).filter_select).toBeUndefined();
      expect(load(doc).filter).toBeUndefined();
      expect(save(doc, undefined)).not.toHaveBeenCalled();
      expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
      expect((sheet.get('filter_select') as Y.Map<unknown>).toJSON()).toEqual({
        row: [0, 2],
      });
      doc.destroy();
    },
  );

  it('removes orphaned filter rules and filter-only hides when saving a new range', () => {
    const { doc, sheet } = addSheet(
      { row: [0, 2] },
      {
        rowhidden_manual: { 2: 0 },
        rowhidden: { 1: 0, 2: 0 },
        rowlen: { 3: 30 },
      },
    );
    save(doc, initialRange);
    expect((sheet.get('filter_select') as Y.Map<unknown>).toJSON()).toEqual(
      initialRange,
    );
    expect(load(doc).filter).toBeUndefined();
    expect(load(doc).config?.rowhidden).toEqual({ 2: 0 });
    expect(load(doc).config?.rowlen).toEqual({ 3: 30 });
    doc.destroy();
  });

  it.each([false, true])(
    'only reads visibility fields and cleans up when filter-hidden rows exist (%s)',
    (hasHiddenRows) => {
      const { doc, sheet } = addSheet();
      sheet.delete('filter_select');
      const config = new Y.Map<unknown>([
        ['rowlen', { 3: 30 }],
        ['rowhidden_manual', { 2: 0 }],
        ['rowhidden', hasHiddenRows ? { 1: 0, 2: 0 } : { 2: 0 }],
        ['rowhidden_filter', hasHiddenRows ? { 1: 0 } : {}],
      ]);
      sheet.set('config', config);
      const get = vi.spyOn(config, 'get');
      const toJSON = vi.spyOn(config, 'toJSON');
      const onConfigChange = vi.fn();
      config.observe(onConfigChange);

      updateYdocSheetData(
        doc,
        workbookId,
        [{ sheetId, path: ['filter_select'], value: initialRange }],
        undefined,
      );

      expect(toJSON).not.toHaveBeenCalled();
      expect(get.mock.calls.map(([key]) => key)).not.toContain('rowlen');
      if (hasHiddenRows) {
        expect(onConfigChange).toHaveBeenCalled();
        expect(config.get('rowhidden')).toEqual({ 2: 0 });
      } else {
        expect(get.mock.calls).toEqual([['rowhidden_filter']]);
        expect(onConfigChange).not.toHaveBeenCalled();
      }
      doc.destroy();
    },
  );

  it('keeps a complete range after merging concurrent valid saves', () => {
    const { doc, sheet } = addSheet();
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));

    const first = { row: [0, 3], column: [0, 1] };
    const second = { row: [0, 2], column: [0, 2] };
    const original = sheet.get('filter_select');
    save(doc, first);
    save(peer, second);
    expect(sheet.get('filter_select')).toBeInstanceOf(Y.Map);
    expect(sheet.get('filter_select')).not.toBe(original);

    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer));
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    expect([first, second]).toContainEqual(load(doc).filter_select);
    expect(load(peer).filter_select).toEqual(load(doc).filter_select);
    peer.destroy();
    doc.destroy();
  });

  it('clears the whole range and keeps manual hides', () => {
    const { doc, sheet } = addSheet(initialRange, {
      rowhidden_manual: { 2: 0 },
      rowhidden: { 1: 0, 2: 0 },
    });
    save(doc, undefined, {
      rowhidden: { 2: 0 },
      rowhidden_manual: { 2: 0 },
      rowhidden_filter: {},
    });
    expect(sheet.has('filter_select')).toBe(false);
    expect(sheet.has('filter')).toBe(false);
    expect(load(doc).filter).toBeUndefined();
    expect(load(doc).config?.rowhidden).toEqual({ 2: 0 });
    doc.destroy();
  });
});
