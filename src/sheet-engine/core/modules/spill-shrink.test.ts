import { beforeAll, describe, expect, it, vi } from "vitest";
import { loadLocale } from "../locale";
import type { Context } from "../context";
import type { CellMatrix } from "../types";
import { setCellValue } from "./cell";
import { spillSortResult } from "./sort";

beforeAll(() => loadLocale("en"));

function workbook(data: CellMatrix) {
  const updateCellYdoc = vi.fn();
  const ctx = {
    currentSheetId: "sheet",
    lang: "en",
    luckysheetfile: [
      {
        id: "sheet",
        name: "Sheet1",
        data,
        row: data.length,
        column: data[0].length,
      },
    ],
    hooks: { updateCellYdoc },
    luckysheetCellUpdate: [],
    config: {},
  } as unknown as Context;
  return { ctx, updateCellYdoc };
}

describe("shrinking array formula output", () => {
  it("clears old SEQUENCE rows and includes the cleared cells in persistence updates", () => {
    const data: CellMatrix = [[null], [null], [null]];
    const { ctx, updateCellYdoc } = workbook(data);
    spillSortResult(ctx, 0, 0, { f: "=SEQUENCE(3)", v: [[1], [2], [3]] });
    updateCellYdoc.mockClear();

    spillSortResult(ctx, 0, 0, { f: "=SEQUENCE(1)", v: [[1]] });

    expect(data[0][0]).toMatchObject({ f: "=SEQUENCE(1)", v: 1 });
    expect(data[1][0]?.v).toBeUndefined();
    expect(data[2][0]?.v).toBeUndefined();
    expect(data[1][0]?.m).toBeUndefined();
    expect(data[2][0]?.m).toBeUndefined();
    const changes = updateCellYdoc.mock.calls.flatMap(([batch]) => batch);
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "1_0",
          value: { r: 1, c: 0, v: data[1][0] },
        }),
        expect.objectContaining({
          key: "2_0",
          value: { r: 2, c: 0, v: data[2][0] },
        }),
      ]),
    );
  });

  it("clears old columns as well as rows and preserves cell formatting", () => {
    const data: CellMatrix = [
      [null, { bg: "#ff0000" }],
      [null, null],
    ];
    const { ctx } = workbook(data);
    spillSortResult(ctx, 0, 0, {
      f: "=SEQUENCE(2,2)",
      v: [
        [1, 2],
        [3, 4],
      ],
    });

    spillSortResult(ctx, 0, 0, { f: "=SEQUENCE(1)", v: [[1]] });

    expect(data[0][1]?.v).toBeUndefined();
    expect(data[0][1]?.bg).toBe("#ff0000");
    expect(data[1][0]?.v).toBeUndefined();
    expect(data[1][1]?.v).toBeUndefined();
  });

  it("keeps output cells that the user has replaced with their own data", () => {
    const data: CellMatrix = [
      [null, null],
      [null, { v: "unrelated" }],
      [null, null],
    ];
    const { ctx } = workbook(data);
    spillSortResult(ctx, 0, 0, { f: "=SEQUENCE(3)", v: [[1], [2], [3]] });
    setCellValue(ctx, 1, 0, data, "manual edit");

    spillSortResult(ctx, 0, 0, { f: "=SEQUENCE(1)", v: [[1]] });

    expect(data[1][0]?.v).toBe("manual edit");
    expect(data[1][1]?.v).toBe("unrelated");
    expect(data[2][0]?.v).toBeUndefined();
  });

  it("retains ownership across save/load and supports growing again after shrinking", () => {
    const data: CellMatrix = [[null], [null], [null]];
    const { ctx } = workbook(data);
    spillSortResult(ctx, 0, 0, { f: "=SEQUENCE(3)", v: [[1], [2], [3]] });
    const restored: CellMatrix = JSON.parse(JSON.stringify(data));
    const { ctx: restoredCtx } = workbook(restored);

    spillSortResult(restoredCtx, 0, 0, { f: "=SEQUENCE(1)", v: [[1]] });
    expect(restored[1][0]?.v).toBeUndefined();
    expect(restored[2][0]?.v).toBeUndefined();
    spillSortResult(restoredCtx, 0, 0, {
      f: "=SEQUENCE(3)",
      v: [[1], [2], [3]],
    });
    expect(restored.map((row) => row[0]?.v)).toEqual([1, 2, 3]);
  });

  it.each(["=SORT(A1:A3)", "=XLOOKUP(A1,B1:B3,C1:C3)"])(
    "also clears stale output for %s",
    (f) => {
      const data: CellMatrix = [[null], [null], [null]];
      const { ctx } = workbook(data);
      spillSortResult(ctx, 0, 0, { f, v: [[1], [2], [3]] });
      spillSortResult(ctx, 0, 0, { f, v: [[1]] });
      expect(data[1][0]?.v).toBeUndefined();
      expect(data[2][0]?.v).toBeUndefined();
    },
  );
});
