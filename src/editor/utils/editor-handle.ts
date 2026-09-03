import type { MutableRefObject, Ref } from "react";
import type { WorkbookInstance } from "@sheet-engine/react";
import type { DSheetEditorHandle } from "../types";

export type DSheetEditorMethods = Pick<
  DSheetEditorHandle,
  | "refreshIndexedDB"
  | "terminateSession"
  | "updateCollaboratorName"
  | "updateSessionTitle"
>;

const assignRef = <T>(ref: Ref<T> | undefined, value: T | null): void => {
  if (!ref) return;
  if (typeof ref === "function") {
    ref(value);
    return;
  }
  (ref as MutableRefObject<T | null>).current = value;
};

/**
 * Compose Fortune's regenerated imperative handle with dSheet lifecycle methods.
 * React callback refs invoke this again after every Workbook remount, so both
 * standard forwarded refs and the legacy sheetEditorRef prop stay current.
 */
export const attachDSheetEditorHandle = (
  workbook: WorkbookInstance | null,
  methods: DSheetEditorMethods,
  refs: Array<Ref<DSheetEditorHandle> | undefined>,
): DSheetEditorHandle | null => {
  const handle = workbook
    ? (Object.assign(workbook, methods) as DSheetEditorHandle)
    : null;

  for (const ref of new Set(refs)) assignRef(ref, handle);
  return handle;
};
