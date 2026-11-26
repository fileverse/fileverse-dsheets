// Paste into the demo page console (http://localhost:5000/?perfRender=1) to build the
// E1-E6 reference sheet: 100 rows x 10 cols, fills, dropdown column D, 2 CF rules,
// border config. Needs the demo dev build (window.__dsheetRef, window.__perfRender).
(async () => {
  const w = window.__dsheetRef.current;
  const rows = 100, cols = 10;
  w.insertRowOrColumn('row', 83, 20, 'rightbottom');
  await new Promise((r) => setTimeout(r, 1000));
  const vals = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) row.push(c === 3 ? ['Open', 'Done', 'Blocked'][r % 3] : c === 0 ? 'item ' + r : (r * 7 + c * 3) % 500);
    vals.push(row);
  }
  w.setCellValuesByRange(vals, { row: [0, rows - 1], column: [0, cols - 1] });
  await new Promise((r) => setTimeout(r, 800));
  w.setCellFormatByRange('bg', '#ffeeaa', { row: [0, rows - 1], column: [1, 2] });
  w.setCellFormatByRange('bg', '#cceeff', { row: [0, 0], column: [0, cols - 1] });
  w.setCellFormatByRange('bl', 1, { row: [0, rows - 1], column: [0, 0] });
  const dv = {};
  for (let r = 0; r < rows; r++) dv[r + '_3'] = { type: 'dropdown', type2: null, value1: 'Open,Done,Blocked', value2: '', checked: false, remote: false, prohibitInput: false, hintShow: false, hintValue: '', item: null };
  w.setSheetDataVerification(dv);
  w.getWorkbookSetContext()((ctx) => {
    const s = ctx.luckysheetfile.find((x) => x.id === ctx.currentSheetId);
    s.config = s.config || {};
    s.config.borderInfo = [{ rangeType: 'range', borderType: 'border-all', color: '#000000', style: '1', range: [{ row: [0, rows - 1], column: [0, cols - 1] }] }];
  }, { noHistory: true });
  w.setSheetConditionFormatRules([
    { type: 'default', cellrange: [{ row: [0, rows - 1], column: [1, 2] }], format: { textColor: '#900', cellColor: '#fdd' }, conditionName: 'greaterThan', conditionRange: [], conditionValue: ['300'] },
    { type: 'default', cellrange: [{ row: [0, rows - 1], column: [3, 3] }], format: { textColor: '#060', cellColor: '#dfd' }, conditionName: 'textContains', conditionRange: [], conditionValue: ['Done'] },
  ]);
  await new Promise((r) => setTimeout(r, 3000));
  const F = ['Workbook', 'Sheet', 'SheetOverlay', 'Toolbar', 'SheetTab', 'SheetItem', 'ContextMenu', 'FilterMenu', 'SheetTabContextMenu', 'FunctionListButton', 'SVGDefines', 'NotationBoxes', 'FxEditor', 'InputBox', 'ScrollBar'];
  window.__snap = () => {
    const s = window.__perfRender.snapshot();
    const o = { commits: s.commits, renders: s.renders };
    F.forEach((n) => { if (s.byName[n]) o[n] = s.byName[n]; });
    return JSON.stringify(o);
  };
  console.log('baseline sheet ready');
})();
