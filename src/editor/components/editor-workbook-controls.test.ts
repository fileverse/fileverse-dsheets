import { describe, expect, it, vi } from "vitest";

vi.mock("@sheet-engine/react", () => ({
  ERROR_MESSAGES_FLAG: {},
  SERVICES_API_KEY: "",
}));

import { getWorkbookControlItems } from "./editor-workbook-controls";

describe("getWorkbookControlItems", () => {
  it.each([
    { isReadOnly: false, name: "edit permission" },
    { isReadOnly: true, name: "comment permission" },
  ])(
    "keeps comment actions enabled during RTC with $name",
    ({ isReadOnly }) => {
      const controls = getWorkbookControlItems({
        isReadOnly,
        allowComments: true,
        isRTCActive: true,
      });

      expect(controls.toolbarItems).toContain("comment");
      expect(controls.cellContextMenu).toContain("comment");
    },
  );

  it("keeps comment actions unavailable for view-only permission during RTC", () => {
    const controls = getWorkbookControlItems({
      isReadOnly: true,
      allowComments: false,
      isRTCActive: true,
    });

    expect(controls.toolbarItems).not.toContain("comment");
    expect(controls.cellContextMenu).not.toContain("comment");
  });
});
