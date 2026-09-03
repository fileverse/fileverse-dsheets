import React from "react";
import type { WorkbookInstance } from "@sheet-engine/react";
import { describe, expect, it, vi } from "vitest";

import type { DSheetEditorHandle } from "../types";
import {
  attachDSheetEditorHandle,
  type DSheetEditorMethods,
} from "./editor-handle";

const methods = (): DSheetEditorMethods => ({
  refreshIndexedDB: vi.fn(async () => undefined),
  terminateSession: vi.fn(),
  updateCollaboratorName: vi.fn(),
  updateSessionTitle: vi.fn(),
});

describe("DSheetEditorHandle composition", () => {
  it("supports sealed React object refs and includes every public method", async () => {
    const ref = React.createRef<DSheetEditorHandle>();
    const callbackRef = vi.fn();
    const workbook = {} as WorkbookInstance;
    const publicMethods = methods();

    attachDSheetEditorHandle(workbook, publicMethods, [ref, callbackRef]);

    expect(ref.current).toBe(workbook);
    expect(callbackRef).toHaveBeenLastCalledWith(workbook);
    await ref.current?.refreshIndexedDB();
    ref.current?.terminateSession();
    ref.current?.updateCollaboratorName("Ada");
    ref.current?.updateSessionTitle({
      encryptedTitle: "ciphertext",
      documentTitle: "Budget",
    });
    expect(publicMethods.refreshIndexedDB).toHaveBeenCalledOnce();
    expect(publicMethods.terminateSession).toHaveBeenCalledOnce();
    expect(publicMethods.updateCollaboratorName).toHaveBeenCalledWith("Ada");
    expect(publicMethods.updateSessionTitle).toHaveBeenCalledOnce();
  });

  it("reattaches methods after a Fortune remount and clears both ref forms", () => {
    const ref = React.createRef<DSheetEditorHandle>();
    const callbackRef = vi.fn();
    const first = {} as WorkbookInstance;
    const second = {} as WorkbookInstance;
    const publicMethods = methods();

    attachDSheetEditorHandle(first, publicMethods, [ref, callbackRef]);
    attachDSheetEditorHandle(second, publicMethods, [ref, callbackRef]);
    expect(ref.current).toBe(second);
    expect(second).toMatchObject(publicMethods);

    attachDSheetEditorHandle(null, publicMethods, [ref, callbackRef]);
    expect(ref.current).toBeNull();
    expect(callbackRef).toHaveBeenLastCalledWith(null);
  });
});
