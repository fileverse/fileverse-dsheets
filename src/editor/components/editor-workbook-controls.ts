import {
  CELL_CONTEXT_MENU_ITEMS,
  HEADER_CONTEXT_MENU_ITEMS,
  TOOL_BAR_ITEMS,
} from "../constants/shared-constants";

interface WorkbookControlItemsInput {
  isReadOnly: boolean;
  allowComments: boolean;
  isRTCActive: boolean;
}

export const getWorkbookControlItems = ({
  isReadOnly,
  allowComments,
}: WorkbookControlItemsInput) => ({
  // RTC state intentionally does not gate comments; host permissions do.
  cellContextMenu: isReadOnly
    ? allowComments
      ? ["comment", "copy"]
      : ["copy"]
    : CELL_CONTEXT_MENU_ITEMS,
  headerContextMenu: isReadOnly ? ["filter"] : HEADER_CONTEXT_MENU_ITEMS,
  toolbarItems: isReadOnly
    ? allowComments
      ? ["filter", "sort", "comment"]
      : ["filter", "sort"]
    : TOOL_BAR_ITEMS,
});
