export type FunctionLocaleItem = {
  n?: string;
  t?: number | string;
};

const PARSER_FUNCTIONS = new Set([
  'CONVERT',
  'TO_DATE',
  'TO_DOLLARS',
  'TO_PERCENT',
  'TO_PURE_NUMBER',
  'TO_TEXT',
]);

const TYPE_TO_CATEGORY_KEY: Record<number, string> = {
  0: 'Math',
  1: 'Statistical',
  2: 'Lookup',
  6: 'Date',
  8: 'Financial',
  9: 'Engineering',
  10: 'Logical',
  11: 'Operator',
  12: 'Text',
  13: 'Engineering',
  14: 'Array',
  15: 'Info',
  16: 'Operator',
  17: 'Database',
  20: 'Datablock',
};

const CATEGORY_ORDER = [
  'All',
  'Datablock',
  'Array',
  'Database',
  'Date',
  'Engineering',
  'Financial',
  'Info',
  'Logical',
  'Lookup',
  'Math',
  'Operator',
  'Parser',
  'Statistical',
  'Text',
  'Other',
] as const;


/** Groups the locale's function list by category for the function picker. */
export function groupFunctions(functionlist: FunctionLocaleItem[]) {
  const byCategory = new Map<string, Set<string>>();

  for (const item of functionlist) {
    const name = (item?.n ? String(item.n) : '').trim();
    if (!name) continue;

    const typeId = Number(item?.t);
    const categoryKey = PARSER_FUNCTIONS.has(name)
      ? 'Parser'
      : typeId === 11
        ? 'Operator'
        : TYPE_TO_CATEGORY_KEY[typeId] || 'Other';

    if (!byCategory.has(categoryKey)) byCategory.set(categoryKey, new Set());
    byCategory.get(categoryKey)!.add(name);
  }

  // Synthetic "All" category.
  const all = new Set<string>();
  for (const set of byCategory.values()) {
    for (const fn of set) all.add(fn);
  }
  byCategory.set('All', all);

  const toSortedArray = (set: Set<string> | undefined) =>
    set ? Array.from(set).sort((a, b) => a.localeCompare(b)) : [];

  return {
    categories: CATEGORY_ORDER.filter(
      (k) => k === 'All' || (byCategory.get(k)?.size ?? 0) > 0,
    ),
    getFunctions: (categoryKey: string) =>
      toSortedArray(byCategory.get(categoryKey)),
  };
}
