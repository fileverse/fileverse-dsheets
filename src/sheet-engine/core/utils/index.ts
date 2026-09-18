import _ from 'lodash';
import { Context } from '../context';
import { locale } from '../locale';
import { Sheet } from '../types';
import { checkCellIsLocked } from '../modules';

export {
  filterPatch,
  patchToOp,
  opToPatch,
  inverseRowColOptions,
  extractFormulaCellOps,
} from './patch';
export type { PatchOptions, ChangedSheet } from './patch';
export { getFreezeState, getFrozenPixelBounds, toggleFreeze } from './freeze';
export type { FreezeType } from './freeze';

export function generateRandomSheetName(
  file: Sheet[],
  isPivotTable: boolean,
  ctx: Context,
) {
  let index = file.length;

  const locale_pivotTable = locale(ctx).pivotTable;
  const { title } = locale_pivotTable;

  for (let i = 0; i < file.length; i += 1) {
    if (
      file[i].name.indexOf('Sheet') > -1 ||
      file[i].name.indexOf(title) > -1
    ) {
      const suffix = parseFloat(
        file[i].name.replace('Sheet', '').replace(title, ''),
      );

      if (!Number.isNaN(suffix) && Math.ceil(suffix) > index) {
        index = Math.ceil(suffix);
      }
    }
  }

  if (isPivotTable) {
    return title + (index + 1);
  }
  return `Sheet${index + 1}`;
}

// 颜色 rgb转16进制
export function rgbToHex(color: string): string {
  let rgb;

  if (color.indexOf('rgba') > -1) {
    rgb = color.replace('rgba(', '').replace(')', '').split(',');
  } else {
    rgb = color.replace('rgb(', '').replace(')', '').split(',');
  }

  const r = Number(rgb[0]);
  const g = Number(rgb[1]);
  const b = Number(rgb[2]);

  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

// 列下标  数字转字母
export function indexToColumnChar(n: number) {
  const orda = 'a'.charCodeAt(0);
  const ordz = 'z'.charCodeAt(0);
  const len = ordz - orda + 1;
  let s = '';
  while (n >= 0) {
    s = String.fromCharCode((n % len) + orda) + s;
    n = Math.floor(n / len) - 1;
  }
  return s.toUpperCase();
}

// 列下标  字母转数字
export function columnCharToIndex(a: string) {
  if (a == null || a.length === 0) {
    return NaN;
  }
  const str = a.toLowerCase().split('');
  const al = str.length;
  const getCharNumber = (charx: string) => {
    return charx.charCodeAt(0) - 96;
  };
  let numout = 0;
  let charnum = 0;
  for (let i = 0; i < al; i += 1) {
    charnum = getCharNumber(str[i]);
    numout += charnum * 26 ** (al - i - 1);
  }
  // console.log(a, numout-1);
  if (numout === 0) {
    return NaN;
  }
  return numout - 1;
}

export function escapeScriptTag(str: string) {
  if (typeof str !== 'string') return str;
  return str
    .replace(/<script>/g, '&lt;script&gt;')
    .replace(/<\/script>/, '&lt;/script&gt;');
}

export function escapeHTMLTag(str: string) {
  if (typeof str !== 'string') return str;
  if (str.substr(0, 5) === '<span' || _.startsWith(str, '=')) {
    return str;
  }
  return str.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function getSheetIndex(ctx: Context, id: string) {
  for (let i = 0; i < ctx.luckysheetfile.length; i += 1) {
    if (ctx.luckysheetfile[i]?.id === id) {
      return i;
    }
  }
  return null;
}

export function getSheetIdByName(ctx: Context, name: string) {
  for (let i = 0; i < ctx.luckysheetfile.length; i += 1) {
    if (ctx.luckysheetfile[i].name === name) {
      return ctx.luckysheetfile[i].id;
    }
  }
  return null;
}

export function getSheetByIndex(ctx: Context, id: string) {
  if (_.isNil(id)) {
    id = ctx.currentSheetId;
  }
  const i = getSheetIndex(ctx, id);
  if (_.isNil(i)) {
    return null;
  }
  return ctx.luckysheetfile[i];
}

// 获取当前日期时间
export function getNowDateTime(format: number) {
  const now = new Date();
  const year = now.getFullYear(); // 得到年份
  let month: string | number = now.getMonth(); // 得到月份
  let date: string | number = now.getDate(); // 得到日期
  let hour: string | number = now.getHours(); // 得到小时
  let minu: string | number = now.getMinutes(); // 得到分钟
  let sec: string | number = now.getSeconds(); // 得到秒

  month += 1;
  if (month < 10) month = `0${month}`;
  if (date < 10) date = `0${date}`;
  if (hour < 10) hour = `0${hour}`;
  if (minu < 10) minu = `0${minu}`;
  if (sec < 10) sec = `0${sec}`;

  let time = '';

  // 日期
  if (format === 1) {
    time = `${year}-${month}-${date}`;
  }
  // 日期时间
  else if (format === 2) {
    time = `${year}-${month}-${date} ${hour}:${minu}:${sec}`;
  }

  return time;
}

// 替换temp中的${xxx}为指定内容 ,temp:字符串，这里指html代码，dataarry：一个对象{"xxx":"替换的内容"}
// 例：luckysheet.replaceHtml("${image}",{"image":"abc","jskdjslf":"abc"})   ==>  abc
export function replaceHtml(temp: string, dataarry: any) {
  return temp.replace(/\$\{([\w]+)\}/g, (s1, s2) => {
    const s = dataarry[s2];
    if (typeof s !== 'undefined') {
      return s;
    }
    return s1;
  });
}

// 获取正则字符串（处理 . * ? ~* ~?）
export function getRegExpStr(str: string) {
  return str
    .replace('~*', '\\*')
    .replace('~?', '\\?')
    .replace('.', '\\.')
    .replace('*', '.*')
    .replace('?', '.');
}

// 列下标  数字转字母
export function chatatABC(n: number) {
  // let wordlen = columeHeader_word.length;

  // if (index < wordlen) {
  //     return columeHeader_word[index];
  // }
  // else {
  //     let last = 0, pre = 0, ret = "";
  //     let i = 1, n = 0;

  //     while (index >= (wordlen / (wordlen - 1)) * (Math.pow(wordlen, i++) - 1)) {
  //         n = i;
  //     }

  //     let index_ab = index - (wordlen / (wordlen - 1)) * (Math.pow(wordlen, n - 1) - 1);//970
  //     last = index_ab + 1;

  //     for (let x = n; x > 0; x--) {
  //         let last1 = last, x1 = x;//-702=268, 3

  //         if (x == 1) {
  //             last1 = last1 % wordlen;

  //             if (last1 == 0) {
  //                 last1 = 26;
  //             }

  //             return ret + columeHeader_word[last1 - 1];
  //         }

  //         last1 = Math.ceil(last1 / Math.pow(wordlen, x - 1));
  //         //last1 = last1 % wordlen;
  //         ret += columeHeader_word[last1 - 1];

  //         if (x > 1) {
  //             last = last - (last1 - 1) * wordlen;
  //         }
  //     }
  // }

  const orda = 'a'.charCodeAt(0);

  const ordz = 'z'.charCodeAt(0);

  const len = ordz - orda + 1;

  let s = '';

  while (n >= 0) {
    s = String.fromCharCode((n % len) + orda) + s;

    n = Math.floor(n / len) - 1;
  }

  return s.toUpperCase();
}

export function isAllowEdit(
  ctx: Context,
  range?: Sheet['luckysheet_select_save'],
) {
  const cfg = ctx.config;
  const judgeRange = _.isUndefined(range) ? ctx.luckysheet_select_save : range;
  return (
    _.every(judgeRange, (selection) => {
      for (let r = selection.row[0]; r <= selection.row[1]; r += 1) {
        if (cfg.rowReadOnly?.[r]) {
          return false;
        }
      }
      for (let c = selection.column[0]; c <= selection.column[1]; c += 1) {
        if (cfg.colReadOnly?.[c]) {
          return false;
        }
      }

      for (let r = selection.row[0]; r <= selection.row[1]; r += 1) {
        for (let c = selection.column[0]; c <= selection.column[1]; c += 1) {
          if (checkCellIsLocked(ctx, r, c, ctx.currentSheetId)) {
            return false;
          }
        }
      }

      return true;
    }) &&
    (_.isUndefined(ctx.allowEdit) ? true : ctx.allowEdit) &&
    !ctx.isFlvReadOnly
  );
}

export function isAllowEditReadOnly(
  ctx: Context,
  range?: Sheet['luckysheet_select_save'],
) {
  const cfg = ctx.config;
  const judgeRange = _.isUndefined(range) ? ctx.luckysheet_select_save : range;
  return (
    _.every(judgeRange, (selection) => {
      for (let r = selection.row[0]; r <= selection.row[1]; r += 1) {
        if (cfg.rowReadOnly?.[r]) {
          return false;
        }
      }
      for (let c = selection.column[0]; c <= selection.column[1]; c += 1) {
        if (cfg.colReadOnly?.[c]) {
          return false;
        }
      }

      for (let r = selection.row[0]; r <= selection.row[1]; r += 1) {
        for (let c = selection.column[0]; c <= selection.column[1]; c += 1) {
          if (checkCellIsLocked(ctx, r, c, ctx.currentSheetId)) {
            return false;
          }
        }
      }

      return true;
    }) && (_.isUndefined(ctx.isFlvReadOnly) ? true : ctx.isFlvReadOnly)
  );
}

export function isLetterNumberPattern(str: string): boolean {
  const regex = /^[a-zA-Z]\d+$/;
  return regex.test(str);
}

export function removeLastSpan(htmlString: string) {
  // Create a temporary container
  const container = document.createElement('div');
  container.innerHTML = htmlString;

  // Get all span elements
  const spans = container.querySelectorAll('span');

  if (spans.length > 0) {
    const lastSpan = spans[spans.length - 1];
    lastSpan.remove();
  }

  // Return the updated HTML string
  return container.innerHTML;
}

export function getContentInParentheses(str: string | null): string | null {
  if (!str) return null;

  // Case 1: Handle content inside parentheses (existing behavior)
  const parenMatch = str.match(/\(([^)]+)\)/);
  if (parenMatch) return parenMatch[1];

  // Case 2: Handle formulas like "=B1+B2" or "=A1:B1+B2"
  // Match cell references (like A1, B2, A1:B2) after '='
  const formulaMatch = str.match(/^=([\w\d:+\-*/]+)$/);
  if (formulaMatch) {
    // Replace operators with commas and remove duplicates
    const refs = formulaMatch[1]
      /* eslint-disable no-useless-escape */
      .split(/[\+\-\*\/]/)
      .map((part) => part.trim())
      .filter(Boolean);
    return refs.join(',');
  }

  return null;
}

export function processArray(cellReferences: any, d: any, flowData: any) {
  // Helper function to validate cell reference format
  function isValidCellReference(cell: string) {
    // Valid format: one or more letters followed by one or more digits
    const cellPattern = /^[A-Za-z]+\d+$/;
    return cellPattern.test(cell);
  }

  // Helper function to parse cell reference into components
  function parseCellReference(cell: string) {
    const match = cell.match(/^([A-Za-z]+)(\d+)$/);
    if (!match) return null;

    const letters = match[1].toLowerCase();
    const number = parseInt(match[2], 10);

    // Convert letters to column index (A=0, B=1, ..., Z=25, AA=26, AB=27, etc.)
    let col = 0;
    for (let i = 0; i < letters.length; i += 1) {
      col = col * 26 + (letters.charCodeAt(i) - 'a'.charCodeAt(0) + 1);
    }
    col -= 1; // Convert to 0-based index

    const row = number - 1; // Convert to 0-based index

    return { letters, number, col, row };
  }

  // Filter out invalid cell references first
  const validCellReferences = cellReferences?.filter((cellRef: string) => {
    if (cellRef.includes(':')) {
      // For ranges, check both parts
      const [startCell, endCell] = cellRef.split(':');
      return (
        isValidCellReference(startCell.trim()) &&
        isValidCellReference(endCell.trim())
      );
    }
    return isValidCellReference(cellRef.trim());
  });

  // First, expand ranges like "a1:b2" into individual cell references
  const expandedCellReferences: any = [];

  validCellReferences?.forEach((cellRef: string) => {
    if (cellRef.includes(':')) {
      // Handle range notation like "a1:b2"
      const [startCell, endCell] = cellRef.split(':');

      // Parse start and end cells
      const startParsed = parseCellReference(startCell.trim());
      const endParsed = parseCellReference(endCell.trim());

      if (!startParsed || !endParsed) return; // Skip invalid ranges

      // Generate all cells in the range
      for (let row = startParsed.number; row <= endParsed.number; row += 1) {
        for (let { col } = startParsed; col <= endParsed.col; col += 1) {
          // Convert column index back to letters
          let letters = '';
          let tempCol = col + 1; // Convert back to 1-based for letter calculation
          while (tempCol > 0) {
            tempCol -= 1;
            letters =
              String.fromCharCode('A'.charCodeAt(0) + (tempCol % 26)) + letters;
            tempCol = Math.floor(tempCol / 26);
          }
          const cellName = letters + row;
          expandedCellReferences.push(cellName);
        }
      }
    } else {
      // Single cell reference, add as is
      expandedCellReferences.push(cellRef.toUpperCase());
    }
  });
  // Array to store converted coordinates
  const coordinates: any = [];

  // Convert each expanded cell reference to coordinates
  expandedCellReferences.forEach((cell: string) => {
    const parsed = parseCellReference(cell);
    if (parsed) {
      // Store as [row, col] coordinate
      coordinates.push([parsed.row, parsed.col]);
    }
  });

  let formated;
  let dateFormatted;
  coordinates.forEach((coord: any) => {
    const [row, col] = coord;

    // Check if coordinates are within bounds
    if (row >= 0 && row < d.length && col >= 0 && col < d[row].length) {
      const cellType = flowData?.[row][col]?.ct?.t;
      const fa = flowData?.[row][col]?.ct?.fa;
      if (cellType === 'd' && fa) {
        dateFormatted = fa;
      }
      if (
        fa &&
        (fa?.includes('#,##0') || fa?.includes('#,##0.') || fa?.includes('%'))
      ) {
        formated = flowData?.[row][col]?.ct?.fa;
      }
    }
  });

  return dateFormatted || formated;
}

export function getNumberFormat(strValue: any, commaPresent: boolean) {
  let format = '';
  const hasDecimal = strValue.includes('.');
  const hasComma = commaPresent;

  if (hasDecimal) {
    const decimalCount = strValue.split('.')[1]?.length || 0;
    format = hasComma
      ? `#,##0.${'0'.repeat(decimalCount)}`
      : `0.${'0'.repeat(decimalCount)}`;
  } else if (hasComma) {
    format = '#,##0';
  } else {
    format = 'General';
  }
  return format;
}

export function checkIsCol(str: string) {
  // take substring after first comma
  const afterComma = str.split(',')[1]?.trim();
  if (!afterComma) return null;

  // first range is before the next comma or closing paren
  const firstRange = afterComma.split(/[),]/)[0].trim();

  // match pattern like A1:B10
  const match = firstRange.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i);
  if (!match) return null;

  const [, col1, row1, col2, row2] = match;

  // same column, different rows → false
  if (col1 === col2 && row1 !== row2) return false;

  // same row, different columns → true
  if (row1 === row2 && col1 !== col2) return true;

  // otherwise not a straight row/col selection
  return null;
}

export function getLineCount(
  sentence: string,
  maxWidthPx: number,
  font = '12px Arial',
) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (context) {
    context.font = font;
  }

  const words = sentence.split(' ');
  let currentLine = '';
  let lineCount = 0;

  words.forEach((word) => {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    const testWidth = context?.measureText(testLine).width;

    if (testWidth && testWidth > maxWidthPx && currentLine) {
      lineCount += 1;
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  });

  if (currentLine) lineCount += 1;

  return lineCount;
}
