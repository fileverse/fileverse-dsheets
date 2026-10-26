export type PlainCelldataEntry = { r: number; c: number; v: unknown };

export type CelldataPatch = {
  key: string;
  action: 'delete' | 'update';
  v?: unknown;
};

type ParsedPatch = {
  r: number;
  c: number;
  action: 'delete' | 'update';
  v?: unknown;
  index: number;
};

/**
 * Apply a remote batch of cell changes to a sheet's plain celldata array in
 * place. Keys are `r_c` and unique within a batch.
 *
 * One pass over celldata finds every patched cell (A5): O(entries + changes)
 * instead of a findIndex per changed key. The lookup is by row then column
 * number, so the pass allocates nothing per entry.
 */
export function patchPlainCelldata(
  celldata: PlainCelldataEntry[],
  patches: Iterable<CelldataPatch>,
) {
  const parsed: ParsedPatch[] = [];
  const byRow = new Map<number, Map<number, ParsedPatch>>();
  for (const { key, action, v } of patches) {
    const sep = key.lastIndexOf('_');
    const patch: ParsedPatch = {
      r: parseInt(key.slice(0, sep), 10),
      c: parseInt(key.slice(sep + 1), 10),
      action,
      v,
      index: -1,
    };
    parsed.push(patch);
    let row = byRow.get(patch.r);
    if (!row) byRow.set(patch.r, (row = new Map()));
    row.set(patch.c, patch);
  }
  if (parsed.length === 0) return;

  for (let i = 0; i < celldata.length; i += 1) {
    const cell = celldata[i];
    if (!cell) continue;
    const patch = byRow.get(cell.r)?.get(cell.c);
    if (patch && patch.index < 0) patch.index = i;
  }

  let deleted: Set<number> | null = null;
  for (const patch of parsed) {
    if (patch.action === 'delete') {
      if (patch.index >= 0) (deleted ??= new Set()).add(patch.index);
      continue;
    }
    const entry = { r: patch.r, c: patch.c, v: patch.v ?? null };
    if (patch.index >= 0) celldata[patch.index] = entry;
    else celldata.push(entry);
  }

  if (deleted) {
    let write = 0;
    for (let read = 0; read < celldata.length; read += 1) {
      if (deleted.has(read)) continue;
      celldata[write] = celldata[read];
      write += 1;
    }
    celldata.length = write;
  }
}
