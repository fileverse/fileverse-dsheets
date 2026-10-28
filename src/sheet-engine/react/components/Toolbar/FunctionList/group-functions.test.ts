import { describe, expect, it } from 'vitest';
import { groupFunctions } from './group-functions';

const list = [
  { n: 'SUM', t: 0 },
  { n: 'ABS', t: 0 },
  { n: 'AVERAGE', t: 1 },
  { n: 'TODAY', t: 6 },
  { n: 'TO_TEXT', t: 12 },
  { n: 'PLUS', t: 11 },
  { n: 'MYSTERY', t: 99 },
  { n: '  ', t: 0 },
  { t: 0 },
];

describe('groupFunctions', () => {
  it('puts each function in its category and sorts names', () => {
    const g = groupFunctions(list);
    expect(g.getFunctions('Math')).toEqual(['ABS', 'SUM']);
    expect(g.getFunctions('Statistical')).toEqual(['AVERAGE']);
    expect(g.getFunctions('Date')).toEqual(['TODAY']);
  });

  it('puts parser functions in Parser regardless of type, and type 11 in Operator', () => {
    const g = groupFunctions(list);
    expect(g.getFunctions('Parser')).toEqual(['TO_TEXT']);
    expect(g.getFunctions('Text')).toEqual([]);
    expect(g.getFunctions('Operator')).toEqual(['PLUS']);
  });

  it('puts unknown types in Other and skips unnamed entries', () => {
    const g = groupFunctions(list);
    expect(g.getFunctions('Other')).toEqual(['MYSTERY']);
    expect(g.getFunctions('All')).toHaveLength(7);
  });

  it('lists All first and only the categories that have functions', () => {
    const g = groupFunctions(list);
    expect(g.categories[0]).toBe('All');
    expect(g.categories).toEqual([
      'All',
      'Date',
      'Math',
      'Operator',
      'Parser',
      'Statistical',
      'Other',
    ]);
  });

  it('handles an empty list', () => {
    const g = groupFunctions([]);
    expect(g.categories).toEqual(['All']);
    expect(g.getFunctions('All')).toEqual([]);
  });
});
