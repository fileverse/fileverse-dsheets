import _ from 'lodash';

export type DataVerificationMap = Record<string, any>;

export type DataVerificationChange = {
  key: string;
  type: 'update' | 'delete';
  value?: any;
};

/**
 * Sorting permutes whole rows. Data verification (incl. checkbox `checked`
 * state) is keyed by "r_c", so it has to follow its cell to the new row.
 *
 * `absoluteRowMap` maps old absolute row -> new absolute row for the sorted
 * range. Only columns `stc..edc` are touched.
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
  const next: DataVerificationMap = _.clone(current);
  const moved: DataVerificationMap = {};
  const touched = new Set<string>();

  Object.keys(absoluteRowMap).forEach((oldRowKey) => {
    const oldRow = Number(oldRowKey);
    const newRow = absoluteRowMap[oldRow];
    for (let c = stc; c <= edc; c += 1) {
      const oldKey = `${oldRow}_${c}`;
      const newKey = `${newRow}_${c}`;
      touched.add(oldKey);
      touched.add(newKey);
      if (current[oldKey] != null) {
        moved[newKey] = _.cloneDeep(current[oldKey]);
      }
    }
  });

  touched.forEach((key) => {
    delete next[key];
  });
  Object.keys(moved).forEach((key) => {
    next[key] = moved[key];
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
