import { describe, expect, it } from 'vitest';
import {
  getDataVerificationColumnSpan,
  permuteDataVerificationByRowMap,
} from './sort-data-verification';

const cb = (checked: boolean) => ({
  type: 'checkbox',
  value1: 'TRUE',
  value2: 'FALSE',
  checked,
});

describe('permuteDataVerificationByRowMap', () => {
  it('moves checkbox state with its row', () => {
    // rows 1..3 sorted: old 1->3, 2->1, 3->2
    const dv = { '1_0': cb(true), '2_0': cb(false), '3_0': cb(false) };
    const { next, changes } = permuteDataVerificationByRowMap(
      dv,
      { 1: 3, 2: 1, 3: 2 },
      0,
      0,
    );
    expect(next['3_0'].checked).toBe(true);
    expect(next['1_0'].checked).toBe(false);
    expect(next['2_0'].checked).toBe(false);
    expect(changes.map((c) => c.key).sort()).toEqual(['1_0', '3_0']);
  });

  it('does not mutate the source', () => {
    const dv = { '1_0': cb(true), '2_0': cb(false) };
    permuteDataVerificationByRowMap(dv, { 1: 2, 2: 1 }, 0, 0);
    expect(dv['1_0'].checked).toBe(true);
  });

  it('deletes DV left behind when destination row had none', () => {
    const dv = { '1_0': cb(true) };
    const { next, changes } = permuteDataVerificationByRowMap(
      dv,
      { 1: 2, 2: 1 },
      0,
      0,
    );
    expect(next['1_0']).toBeUndefined();
    expect(next['2_0'].checked).toBe(true);
    expect(changes).toContainEqual({ key: '1_0', type: 'delete' });
  });

  it('leaves columns outside the sorted range and unmoved rows alone', () => {
    const dv = { '1_5': cb(true), '4_0': cb(true) };
    const { next, changes } = permuteDataVerificationByRowMap(
      dv,
      { 1: 2, 2: 1 },
      0,
      2,
    );
    expect(next['1_5'].checked).toBe(true);
    expect(next['4_0'].checked).toBe(true);
    expect(changes).toEqual([]);
  });

  it('handles missing source', () => {
    const { next, changes } = permuteDataVerificationByRowMap(
      undefined,
      { 1: 2, 2: 1 },
      0,
      0,
    );
    expect(next).toEqual({});
    expect(changes).toEqual([]);
  });
});

describe('permuteDataVerificationByRowMap cost', () => {
  it('returns the same map untouched when there are no rules in range', () => {
    const empty = {};
    const rowMap: Record<number, number> = {};
    for (let i = 0; i < 100000; i += 1) rowMap[i] = 99999 - i;
    const res = permuteDataVerificationByRowMap(empty, rowMap, 0, 9);
    expect(res.next).toBe(empty);
    expect(res.changes).toEqual([]);
  });

  it('ignores rules outside the sorted rows and columns', () => {
    const dv = { '50_0': cb(true), '1_9': cb(true) };
    const res = permuteDataVerificationByRowMap(dv, { 1: 2, 2: 1 }, 0, 3);
    expect(res.next).toBe(dv);
    expect(res.changes).toEqual([]);
  });

  it('ignores malformed keys', () => {
    const dv = { foo: cb(true), '_1': cb(true), '1_': cb(true) } as any;
    const res = permuteDataVerificationByRowMap(dv, { 1: 2, 2: 1 }, 0, 3);
    expect(res.changes).toEqual([]);
  });
});

describe('getDataVerificationColumnSpan', () => {
  it('returns the column span of rules within the row range', () => {
    const dv = { '2_4': cb(false), '3_6': cb(false), '99_20': cb(false) };
    expect(getDataVerificationColumnSpan(dv, 1, 10)).toEqual({
      minC: 4,
      maxC: 6,
    });
  });

  it('returns null when nothing matches', () => {
    expect(getDataVerificationColumnSpan(undefined, 0, 5)).toBeNull();
    expect(getDataVerificationColumnSpan({}, 0, 5)).toBeNull();
    expect(getDataVerificationColumnSpan({ '9_1': cb(true) }, 0, 5)).toBeNull();
  });
});
