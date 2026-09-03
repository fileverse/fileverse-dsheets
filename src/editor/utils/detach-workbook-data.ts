import cloneDeep from "lodash/cloneDeep";

/**
 * Creates a private data snapshot for the workbook. The workbook deep-freezes
 * its input when storing it in Immer state, so passing currentDataRef directly
 * would also freeze the Yjs-derived collaboration data. Later sync and comment
 * marker updates would then throw when mutating that shared source. Cloning here
 * keeps workbook state immutable while collaboration data remains mutable.
 */
export const detachWorkbookData = <T>(data: T): T => cloneDeep(data);
