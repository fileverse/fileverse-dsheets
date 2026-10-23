import { describe, expect, it, vi } from "vitest";
import type { Context } from "../context";
import type { CellMatrix } from "../types";
import { sortSelection, sortSheetBySelectedColumn } from "./sort";
import { jfrefreshgrid } from "./refresh";

// Test the sort operation without starting the canvas/formula evaluation loop.
vi.mock("./refresh", () => ({ jfrefreshgrid: vi.fn() }));

function workbook(data: CellMatrix, column: [number, number] = [1, 1]) {
  const calcChain = data.flatMap((row, r) =>
    row.flatMap((cell, c) => (cell?.f ? [{ r, c, id: "sheet" }] : [])),
  );
  const updateCellYdoc = vi.fn();
  const sheet = { id: "sheet", name: "Sheet1", data, calcChain };
  const ctx = {
    currentSheetId: sheet.id,
    luckysheetfile: [sheet],
    allowEdit: true,
    luckysheet_select_save: [{ row: [0, 1], column }],
    hooks: { updateCellYdoc },
  } as unknown as Context;
  return { ctx, sheet, updateCellYdoc };
}

describe("sortSelection formula references", () => {
  it.each([true, false])(
    "preserves references and dependency locations outside the sorted columns (ascending=%s)",
    (ascending) => {
      const data: CellMatrix = [
        [{ v: 100 }, { v: ascending ? 2 : 1 }, { f: "=A1", v: 100 }],
        [{ v: 200 }, { v: ascending ? 1 : 2 }, { f: "=$A$2", v: 200 }],
      ];
      const { ctx, sheet } = workbook(data);

      sortSelection(ctx, ascending);

      expect(data.map((row) => row[1]?.v)).toEqual(ascending ? [1, 2] : [2, 1]);
      expect(data.map((row) => row[0]?.v)).toEqual([100, 200]);
      expect(data[0][2]?.f).toBe("=A1");
      expect(data[1][2]?.f).toBe("=$A$2");
      expect(sheet.calcChain).toEqual([
        { r: 0, c: 2, id: "sheet" },
        { r: 1, c: 2, id: "sheet" },
      ]);
    },
  );

  it("remaps references to moved cells while preserving other columns in the same formula", () => {
    const data: CellMatrix = [
      [{ v: 100 }, { v: 2 }, { f: "=A1+$B$1+Sheet1!B2+Other!B1", v: 103 }],
      [{ v: 200 }, { v: 1 }, null],
    ];
    const { ctx, updateCellYdoc } = workbook(data);

    sortSelection(ctx, true);

    expect(data[0][2]?.f).toBe("=A1+$B$2+Sheet1!B1+Other!B1");
    expect(
      updateCellYdoc.mock.calls.flatMap(([changes]) => changes),
    ).toContainEqual(
      expect.objectContaining({
        key: "0_2",
        value: { r: 0, c: 2, v: data[0][2] },
      }),
    );
    expect(jfrefreshgrid).toHaveBeenLastCalledWith(
      ctx,
      data,
      expect.arrayContaining([{ row: [0, 0], column: [2, 2] }]),
    );
  });

  it("moves dependency locations only for formulas inside the sort range", () => {
    const data: CellMatrix = [
      [{ v: 100 }, { f: "=A1", v: 100 }, { f: "=A1", v: 100 }],
      [{ v: 200 }, { f: "=A2", v: 200 }, null],
    ];
    const { ctx, sheet } = workbook(data);

    sortSelection(ctx, false);

    expect(data[0][1]?.f).toBe("=A2");
    expect(data[1][1]?.f).toBe("=A1");
    expect(data[0][2]?.f).toBe("=A1");
    expect(sheet.calcChain).toEqual([
      { r: 1, c: 1, id: "sheet" },
      { r: 0, c: 2, id: "sheet" },
      { r: 0, c: 1, id: "sheet" },
    ]);
  });

  it("preserves references outside the selected rows and columns in range expressions", () => {
    const data: CellMatrix = [
      [
        { v: 100 },
        { v: 2 },
        { v: 20 },
        { f: "=SUM(A1:A2)+SUM(B1:B2)+B3", v: 303 },
      ],
      [{ v: 200 }, { v: 1 }, { v: 10 }, null],
      [null, { v: 9 }, null, null],
    ];
    const { ctx } = workbook(data, [1, 2]);

    sortSelection(ctx, true);

    expect(data[0][3]?.f).toBe("=SUM(A1:A2)+SUM(B2:B1)+B3");
    expect(data[0][2]?.v).toBe(10);
    expect(data[1][2]?.v).toBe(20);
    expect(data[2][1]?.v).toBe(9);
  });

  it("still remaps references when sorting the entire sheet", () => {
    const data: CellMatrix = [
      [{ v: 100 }, { v: 2 }, { f: "=A1", v: 100 }],
      [{ v: 200 }, { v: 1 }, { f: "=A2", v: 200 }],
    ];
    const { ctx, sheet } = workbook(data);

    sortSheetBySelectedColumn(ctx, true);

    expect(data.map((row) => row[0]?.v)).toEqual([200, 100]);
    expect(data[0][2]?.f).toBe("=A1");
    expect(data[1][2]?.f).toBe("=A2");
    expect(sheet.calcChain).toEqual([
      { r: 1, c: 2, id: "sheet" },
      { r: 0, c: 2, id: "sheet" },
    ]);
  });
});
