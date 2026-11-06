import _ from 'lodash';

export type DataVerificationMap = Record<string, any>;

export type DataVerificationChange = {
  key: string;
  type: 'update' | 'delete';
  value?: any;
};

function parseKey(key: string): [number, number] | null {
  const m = /^(\d+)_(\d+)$/.exec(key);
  if (!m) return null;
  return [Number(m[1]), Number(m[2])];
}

/**
 * Sorting permutes whole rows. Data verification (incl. checkbox `checked`
 * state) is keyed by "r_c", so it has to follow its cell to the new row.
 *
 * `absoluteRowMap` maps old absolute row -> new absolute row for the sorted
 * range. Only columns `stc..edc` are touched.
 *
 * Cost scales with the number of existing rules, not with the size of the
 * sorted range, so sheets without rules return immediately.
 */
export function permuteDataVerificationByRowMap(
  source: DataVerificationMap | undefined | null,
  absoluteRowMap: Record<number, number>,
  stc: number,
  edc: number,
): {
  next: DataVerificationMap;
  changes: DataVerificationChange[];
} {
  const current = source ?? {};
  const keys = Object.keys(current);
  if (keys.length === 0) return { next: current, changes: [] };

  // Existing rules inside the sorted range, with their destination key.
  const inRange: { oldKey: string; newKey: string }[] = [];
  keys.forEach((oldKey) => {
    const pos = parseKey(oldKey);
    if (!pos) return;
    const [r, c] = pos;
    if (c < stc || c > edc) return;
    const newRow = absoluteRowMap[r];
    if (newRow == null) return;
    inRange.push({ oldKey, newKey: `${newRow}_${c}` });
  });
  if (inRange.length === 0) return { next: current, changes: [] };

  const next: DataVerificationMap = _.clone(current);
  const touched = new Set<string>();
  inRange.forEach(({ oldKey }) => {
    touched.add(oldKey);
    delete next[oldKey];
  });
  inRange.forEach(({ oldKey, newKey }) => {
    touched.add(newKey);
    next[newKey] = _.cloneDeep(current[oldKey]);
  });

  const changes: DataVerificationChange[] = [];
  touched.forEach((key) => {
    if (!_.isEqual(current[key], next[key])) {
      changes.push(
        next[key] == null
          ? { key, type: 'delete' }
          : { key, type: 'update', value: _.cloneDeep(next[key]) },
      );
    }
  });

  return { next, changes };
}

/**
 * Column span of data verification rules whose row lies in `str..edr`.
 * Used to widen a whole-sheet sort so a column holding only empty cells with
 * rules still moves with its rows.
 */
export function getDataVerificationColumnSpan(
  dv: DataVerificationMap | undefined | null,
  str: number,
  edr: number,
): { minC: number; maxC: number } | null {
  if (!dv) return null;
  let minC: number | null = null;
  let maxC: number | null = null;
  Object.keys(dv).forEach((key) => {
    const pos = parseKey(key);
    if (!pos) return;
    const [r, c] = pos;
    if (r < str || r > edr) return;
    if (minC == null || c < minC) minC = c;
    if (maxC == null || c > maxC) maxC = c;
  });
  return minC == null || maxC == null ? null : { minC, maxC };
}
