import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { Context } from '@sheet-engine/core/context';
import { updateFormatCell } from '@sheet-engine/core/modules/toolbar';
import type { CellMatrix, Sheet } from '@sheet-engine/core/types';
import { buildSheetDataMatrixForExport } from '@sheet-engine/core/utils/range-format';
import { updateYdocSheetData, ySheetArrayToPlain } from './update-ydoc';

function setup(config: Sheet['config'] = {}, rowCount = 2) {
  const doc = new Y.Doc();
  const sheet = new Y.Map();
  sheet.set('id', 'sheet');
  sheet.set('row', rowCount);
  sheet.set('column', 2);
  sheet.set('config', new Y.Map(Object.entries(config ?? {})));
  doc.getArray('workbook').push([sheet]);

  const data: CellMatrix = Array.from({ length: rowCount }, () => [null, null]);
  const persist = vi.fn((changes: Parameters<typeof updateYdocSheetData>[2]) =>
    updateYdocSheetData(doc, 'workbook', changes, vi.fn()),
  );
  const ctx = {
    currentSheetId: 'sheet',
    config: { ...config },
    luckysheetfile: [{ id: 'sheet', config: { ...config } }],
    hooks: {
      updateCellYdoc: (changes: Parameters<typeof updateYdocSheetData>[2]) =>
        persist(changes),
    },
  } as Context;

  function reload() {
    const fresh = new Y.Doc();
    Y.applyUpdate(fresh, Y.encodeStateAsUpdate(doc));
    const [saved] = ySheetArrayToPlain(fresh.getArray('workbook'));
    fresh.destroy();
    return {
      ...saved,
      data: buildSheetDataMatrixForExport(saved),
    };
  }

  return { ctx, data, reload, persist };
}

describe('Reset fill', () => {
  it('does not bring a cleared fill back after bold and reload', () => {
    const { ctx, data, reload } = setup();
    updateFormatCell(ctx, data, 'bg', '#ff0000', 0, 0, 0, 1);
    expect(reload().data[0][0]?.bg).toBe('#ff0000');
    updateFormatCell(ctx, data, 'bg', undefined, 0, 0, 0, 0);
    updateFormatCell(ctx, data, 'bl', 1, 0, 0, 0, 0);

    const saved = reload();
    expect(saved.data[0][0]).toEqual({ bl: 1 });
    expect(saved.data[0][1]?.bg).toBe('#ff0000');
  });

  it('resets multiple visible blocks while preserving hidden rows and other styles', () => {
    const { ctx, data, reload, persist } = setup(
      {
        cellFormatRanges: [
          { row: [0, 6], column: [0, 1], bg: '#ff0000', it: 1 },
        ],
        rowhidden: { 2: 0, 3: 0, 5: 0 },
      },
      7,
    );

    updateFormatCell(ctx, data, 'bg', undefined, 1, 5, 0, 0);

    const saved = reload();
    expect(saved.data.map((row) => row[0])).toEqual(
      Array.from({ length: 7 }, (_, row) =>
        row === 1 || row === 4 ? { it: 1 } : { bg: '#ff0000', it: 1 },
      ),
    );
    expect(saved.data.every((row) => row[1]?.bg === '#ff0000')).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);

    persist.mockClear();
    updateFormatCell(ctx, data, 'bg', undefined, 2, 3, 0, 0);
    expect(persist).not.toHaveBeenCalled();
  });

  it('does not store a format range for a cleared blank cell', () => {
    const { ctx, data, reload } = setup();
    updateFormatCell(ctx, data, 'bg', '#ff0000', 0, 0, 0, 0);
    updateFormatCell(ctx, data, 'bg', undefined, 0, 0, 0, 0);
    expect(reload().config?.cellFormatRanges ?? []).toEqual([]);
  });
});
