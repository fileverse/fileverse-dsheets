import { describe, expect, it } from 'vitest';
import { commentKeyMovesById, remapCommentAnchors } from './remap-comment-anchors';
import { applyCommentAnchorMap } from './comment-anchors-ydoc';
import { buildBlockMoveIndexMap } from '../../sheet-engine/core/utils/comment-anchor-move';

const thread = (key: string, id = key) => ({ id, key, content: key });

describe('buildBlockMoveIndexMap', () => {
  it('moves a single column right and shifts the gap left', () => {
    // 4 cols, move col 0 to insert-at 2 after removal → [1,2,0,3]
    expect(buildBlockMoveIndexMap(4, 0, 1, 2)).toEqual({
      0: 2,
      1: 0,
      2: 1,
      3: 3,
    });
  });

  it('moves a block of columns left', () => {
    // cols 2-3 moved to 0 → [2,3,0,1]
    expect(buildBlockMoveIndexMap(4, 2, 2, 0)).toEqual({
      0: 2,
      1: 3,
      2: 0,
      3: 1,
    });
  });
});

describe('remapCommentAnchors', () => {
  const sheetId = 'sheet-uuid';

  it('remaps column keys after a column drag', () => {
    const data = {
      [`${sheetId}_0_0`]: thread(`${sheetId}_0_0`),
      [`${sheetId}_0_2`]: thread(`${sheetId}_0_2`),
      WITHOUT_CELL_1: thread('WITHOUT_CELL_1'),
      'other_0_0': thread('other_0_0'),
    };
    const next = remapCommentAnchors(data, {
      type: 'column',
      sheetId,
      sheetKeys: [sheetId],
      indexMap: { 0: 2, 1: 0, 2: 1, 3: 3 },
    });
    expect(next[`${sheetId}_0_2`]?.content).toBe(`${sheetId}_0_0`);
    expect(next[`${sheetId}_0_1`]?.content).toBe(`${sheetId}_0_2`);
    expect(next.WITHOUT_CELL_1).toBe(data.WITHOUT_CELL_1);
    expect(next.other_0_0).toBe(data.other_0_0);
    expect(next[`${sheetId}_0_0`]).toBeUndefined();
  });

  it('remaps row keys after a row drag', () => {
    const data = {
      [`${sheetId}_1_3`]: thread(`${sheetId}_1_3`),
    };
    const next = remapCommentAnchors(data, {
      type: 'row',
      sheetId,
      sheetKeys: [sheetId, '0'],
      indexMap: { 0: 0, 1: 4, 2: 1, 3: 2, 4: 3 },
    });
    expect(next[`${sheetId}_4_3`]?.key).toBe(`${sheetId}_4_3`);
    expect(next[`${sheetId}_1_3`]).toBeUndefined();
  });

  it('moves cell-range comments by the source→target offset', () => {
    const data = {
      [`${sheetId}_0_0`]: thread(`${sheetId}_0_0`, 'a'),
      [`${sheetId}_5_5`]: thread(`${sheetId}_5_5`, 'keep'),
    };
    const next = remapCommentAnchors(data, {
      type: 'cells',
      sheetId,
      sheetKeys: [sheetId],
      source: { row: [0, 0], column: [0, 0] },
      target: { row: [2, 2], column: [3, 3] },
    });
    expect(next[`${sheetId}_2_3`]?.id).toBe('a');
    expect(next[`${sheetId}_0_0`]).toBeUndefined();
    expect(next[`${sheetId}_5_5`]?.id).toBe('keep');
  });

  it('detaches destination-only comments so they do not collide', () => {
    const data = {
      [`${sheetId}_0_0`]: thread(`${sheetId}_0_0`, 'moving'),
      [`${sheetId}_2_3`]: thread(`${sheetId}_2_3`, 'in-the-way'),
    };
    const next = remapCommentAnchors(data, {
      type: 'cells',
      sheetId,
      sheetKeys: [sheetId],
      source: { row: [0, 0], column: [0, 0] },
      target: { row: [2, 2], column: [3, 3] },
    });
    expect(next[`${sheetId}_2_3`]?.id).toBe('moving');
    expect(next['WITHOUT_CELL_in-the-way']?.id).toBe('in-the-way');
  });

  it('returns the same object when nothing moves', () => {
    const data = { [`${sheetId}_0_0`]: thread(`${sheetId}_0_0`) };
    const next = remapCommentAnchors(data, {
      type: 'cells',
      sheetId,
      source: { row: [0, 0], column: [0, 0] },
      target: { row: [0, 0], column: [0, 0] },
    });
    expect(next).toBe(data);
  });

  it('shifts comments at and after an insert-lefttop index', () => {
    const data = {
      [`${sheetId}_0_1`]: thread(`${sheetId}_0_1`, 'before'),
      [`${sheetId}_0_2`]: thread(`${sheetId}_0_2`, 'at'),
      [`${sheetId}_0_3`]: thread(`${sheetId}_0_3`, 'after'),
      WITHOUT_CELL_1: thread('WITHOUT_CELL_1'),
    };
    const next = remapCommentAnchors(data, {
      type: 'insert',
      axis: 'column',
      sheetId,
      sheetKeys: [sheetId],
      index: 2,
      count: 1,
      direction: 'lefttop',
    });
    expect(next[`${sheetId}_0_1`]?.id).toBe('before');
    expect(next[`${sheetId}_0_3`]?.id).toBe('at');
    expect(next[`${sheetId}_0_4`]?.id).toBe('after');
    expect(next[`${sheetId}_0_2`]).toBeUndefined();
    expect(next.WITHOUT_CELL_1).toBe(data.WITHOUT_CELL_1);
  });

  it('shifts only comments after an insert-rightbottom index', () => {
    const data = {
      [`${sheetId}_2_0`]: thread(`${sheetId}_2_0`, 'at'),
      [`${sheetId}_3_0`]: thread(`${sheetId}_3_0`, 'after'),
    };
    const next = remapCommentAnchors(data, {
      type: 'insert',
      axis: 'row',
      sheetId,
      sheetKeys: [sheetId],
      index: 2,
      count: 2,
      direction: 'rightbottom',
    });
    expect(next[`${sheetId}_2_0`]?.id).toBe('at');
    expect(next[`${sheetId}_5_0`]?.id).toBe('after');
    expect(next[`${sheetId}_3_0`]).toBeUndefined();
  });

  it('detaches comments on deleted rows and shifts later ones up', () => {
    const data = {
      [`${sheetId}_1_0`]: thread(`${sheetId}_1_0`, 'keep'),
      [`${sheetId}_2_0`]: thread(`${sheetId}_2_0`, 'gone'),
      [`${sheetId}_3_0`]: thread(`${sheetId}_3_0`, 'gone-too'),
      [`${sheetId}_5_0`]: thread(`${sheetId}_5_0`, 'shift'),
    };
    const next = remapCommentAnchors(data, {
      type: 'delete',
      axis: 'row',
      sheetId,
      sheetKeys: [sheetId],
      start: 2,
      end: 3,
    });
    expect(next[`${sheetId}_1_0`]?.id).toBe('keep');
    expect(next[`${sheetId}_3_0`]?.id).toBe('shift');
    expect(next[`${sheetId}_2_0`]).toBeUndefined();
    expect(next[`${sheetId}_5_0`]).toBeUndefined();
    expect(next.WITHOUT_CELL_gone?.id).toBe('gone');
    expect(next['WITHOUT_CELL_gone-too']?.id).toBe('gone-too');
  });

  it('detaches comments on deleted columns and shifts later ones left', () => {
    const data = {
      [`${sheetId}_0_0`]: thread(`${sheetId}_0_0`, 'keep'),
      [`${sheetId}_0_1`]: thread(`${sheetId}_0_1`, 'gone'),
      [`${sheetId}_0_4`]: thread(`${sheetId}_0_4`, 'shift'),
    };
    const next = remapCommentAnchors(data, {
      type: 'delete',
      axis: 'column',
      sheetId,
      sheetKeys: [sheetId],
      start: 1,
      end: 2,
    });
    expect(next[`${sheetId}_0_0`]?.id).toBe('keep');
    expect(next[`${sheetId}_0_2`]?.id).toBe('shift');
    expect(next[`${sheetId}_0_1`]).toBeUndefined();
    expect(next.WITHOUT_CELL_gone?.id).toBe('gone');
  });

  it('builds old→new key moves by id in linear time', () => {
    const before = {
      [`${sheetId}_0_0`]: thread(`${sheetId}_0_0`, 'a'),
      [`${sheetId}_0_1`]: thread(`${sheetId}_0_1`, 'b'),
    };
    const after = remapCommentAnchors(before, {
      type: 'insert',
      axis: 'column',
      sheetId,
      sheetKeys: [sheetId],
      index: 0,
      count: 1,
      direction: 'lefttop',
    });
    expect(commentKeyMovesById(before, after)).toEqual({
      [`${sheetId}_0_0`]: `${sheetId}_0_1`,
      [`${sheetId}_0_1`]: `${sheetId}_0_2`,
    });
  });
});

describe('applyCommentAnchorMap', () => {
  it('rekeys indexer comments by id so viewers follow published positions', () => {
    const data = {
      'sheet_0_0': thread('sheet_0_0', 'uuid-1'),
      'sheet_1_1': thread('sheet_1_1', 'uuid-2'),
    };
    const next = applyCommentAnchorMap(data, {
      'uuid-1': 'sheet_0_4',
    });
    expect(next.sheet_0_4?.id).toBe('uuid-1');
    expect(next.sheet_0_4?.key).toBe('sheet_0_4');
    expect(next.sheet_0_0).toBeUndefined();
    expect(next.sheet_1_1?.id).toBe('uuid-2');
  });

  it('rekeys indexer comments by contentHash when local id and uuid differ', () => {
    const data = {
      sheet_0_0: {
        ...thread('sheet_0_0', '0xviewer-uuid'),
        contentHash: 'ipfs-hash-1',
      },
    };
    const next = applyCommentAnchorMap(data, {
      'comment-local-id': 'sheet_0_4',
      'ipfs-hash-1': 'sheet_0_4',
    });
    expect(next.sheet_0_4?.id).toBe('0xviewer-uuid');
    expect(next.sheet_0_0).toBeUndefined();
  });

  it('rekeys indexer comments by original cell key alias', () => {
    const data = {
      sheet_0_0: thread('sheet_0_0', '0xviewer-uuid'),
    };
    const next = applyCommentAnchorMap(data, {
      'comment-local-id': 'sheet_0_4',
      sheet_0_0: 'sheet_0_4',
    });
    expect(next.sheet_0_4?.id).toBe('0xviewer-uuid');
    expect(next.sheet_0_0).toBeUndefined();
  });

  it('does not steal a thread when a stale cell-key alias matches its current cell', () => {
    const data = {
      sheet_3_4: { id: 'comment-iy', key: 'sheet_3_4', contentHash: 'hash-iy' },
      sheet_3_6: { id: 'comment-v7', key: 'sheet_3_6', contentHash: 'hash-v7' },
    };
    const next = applyCommentAnchorMap(data, {
      'comment-iy': 'sheet_3_4',
      'hash-iy': 'sheet_3_4',
      'comment-v7': 'sheet_3_6',
      'hash-v7': 'sheet_3_6',
      sheet_3_2: 'sheet_3_6',
      sheet_3_5: 'sheet_3_4',
      sheet_3_4: 'sheet_3_6',
    });
    expect(Object.keys(next)).toHaveLength(2);
    expect(next.sheet_3_4?.id).toBe('comment-iy');
    expect(next.sheet_3_6?.id).toBe('comment-v7');
  });

  it('keeps both threads when two comments would land on the same cell', () => {
    const data = {
      sheet_0_0: thread('sheet_0_0', 'a'),
      sheet_0_1: thread('sheet_0_1', 'b'),
    };
    const next = applyCommentAnchorMap(data, {
      a: 'sheet_0_9',
      b: 'sheet_0_9',
    });
    expect(Object.keys(next)).toHaveLength(2);
    expect(next.sheet_0_9?.id).toBe('a');
    expect(next.WITHOUT_CELL_b?.id).toBe('b');
  });
});

describe('comment anchors ydoc roundtrip', () => {
  it('survives encode/apply so a published snapshot remaps viewer keys', async () => {
    const Y = await import('yjs');
    const {
      writeCommentAnchorsToYdoc,
      applyYdocCommentAnchors,
    } = await import('./comment-anchors-ydoc');

    const dsheetId = 'doc-1';
    const ownerDoc = new Y.Doc();
    writeCommentAnchorsToYdoc({
      ydoc: ownerDoc,
      dsheetId,
      commentsData: {
        'sheet_0_4': { id: 'uuid-1', key: 'sheet_0_4' },
      },
    });

    const published = Y.encodeStateAsUpdate(ownerDoc);
    const viewerDoc = new Y.Doc();
    Y.applyUpdate(viewerDoc, published);

    const indexerComments = {
      'sheet_0_0': thread('sheet_0_0', 'uuid-1'),
    };
    const next = applyYdocCommentAnchors(indexerComments, viewerDoc, dsheetId);
    expect(next.sheet_0_4?.id).toBe('uuid-1');
    expect(next.sheet_0_0).toBeUndefined();
  });

  it('does not write an occupied cell-key as an alias for another thread', async () => {
    const Y = await import('yjs');
    const { writeCommentAnchorsToYdoc, readCommentAnchorsFromYdoc } = await import(
      './comment-anchors-ydoc'
    );

    const dsheetId = 'doc-1';
    const doc = new Y.Doc();
    writeCommentAnchorsToYdoc({
      ydoc: doc,
      dsheetId,
      commentsData: {
        sheet_0_4: { id: 'comment-iy', key: 'sheet_0_4' },
        sheet_0_6: { id: 'comment-v7', key: 'sheet_0_6' },
      },
      keyMoves: {
        sheet_0_5: 'sheet_0_4',
        sheet_0_4: 'sheet_0_6',
      },
    });

    const anchors = readCommentAnchorsFromYdoc(doc, dsheetId);
    expect(anchors['comment-iy']).toBe('sheet_0_4');
    expect(anchors['comment-v7']).toBe('sheet_0_6');
    expect(anchors.sheet_0_5).toBe('sheet_0_4');
    expect(anchors.sheet_0_4).toBeUndefined();
  });

  it('skipUnmapped backfills hashes without moving remapped positions', async () => {
    const Y = await import('yjs');
    const { writeCommentAnchorsToYdoc, readCommentAnchorsFromYdoc } = await import(
      './comment-anchors-ydoc'
    );

    const dsheetId = 'doc-1';
    const doc = new Y.Doc();
    writeCommentAnchorsToYdoc({
      ydoc: doc,
      dsheetId,
      commentsData: {
        sheet_0_4: { id: 'comment-iy', key: 'sheet_0_4', contentHash: 'hash-iy' },
        sheet_0_6: { id: 'comment-v7', key: 'sheet_0_6', contentHash: 'hash-v7' },
      },
    });
    writeCommentAnchorsToYdoc({
      ydoc: doc,
      dsheetId,
      commentsData: {
        sheet_0_7: { id: 'comment-iy', key: 'sheet_0_7', contentHash: 'hash-iy' },
        sheet_0_5: { id: 'comment-v7', key: 'sheet_0_5', contentHash: 'hash-v7' },
      },
      skipUnmapped: true,
    });

    const anchors = readCommentAnchorsFromYdoc(doc, dsheetId);
    expect(anchors['comment-iy']).toBe('sheet_0_4');
    expect(anchors['comment-v7']).toBe('sheet_0_6');
    expect(anchors['hash-iy']).toBe('sheet_0_4');
    expect(anchors['hash-v7']).toBe('sheet_0_6');
  });
});
