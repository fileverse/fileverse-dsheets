import { freeze } from "immer";
import { describe, expect, it, vi } from "vitest";

// Keep this unit test isolated from the UI package imported by shared constants.
vi.mock("../constants/shared-constants", () => ({
  CELL_COMMENT_DEFAULT_VALUE: { isShow: false },
}));

import { applyCommentMarkers } from "./apply-comment-markers";
import { detachWorkbookData } from "./detach-workbook-data";

describe("detachWorkbookData", () => {
  it.each([
    {
      name: "dense data",
      source: [
        {
          id: "dense",
          order: 0,
          data: [[{ v: "A1" }]],
        },
      ],
      getCell: (sheets: any[]) => sheets[0].data[0][0],
    },
    {
      name: "sparse celldata",
      source: [
        {
          id: "sparse",
          order: 0,
          celldata: [{ r: 0, c: 0, v: { v: "A1" } }],
        },
      ],
      getCell: (sheets: any[]) => sheets[0].celldata[0].v,
    },
  ])(
    "keeps the mutable $name source outside Immer ownership",
    ({ source, getCell }) => {
      const workbookData = detachWorkbookData(source);

      expect(workbookData).not.toBe(source);
      expect(workbookData[0]).not.toBe(source[0]);
      expect(getCell(workbookData)).not.toBe(getCell(source));

      freeze(workbookData, true);

      expect(Object.isFrozen(getCell(workbookData))).toBe(true);
      expect(() =>
        applyCommentMarkers(
          source,
          { [`${source[0].id}_0_0`]: { id: "comment" } },
          true,
        ),
      ).not.toThrow();
      expect(getCell(source).ps).toBeDefined();
      expect(Object.isFrozen(getCell(source))).toBe(false);
    },
  );
});
