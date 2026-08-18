import * as Y from 'yjs';

/** Sibling share key on the same Y.Doc as the sheet array. */
export function getCommentAnchorsMapKey(dsheetId: string): string {
  return `${dsheetId}:commentAnchors`;
}

export function getCommentAnchorsYMap(
  ydoc: Y.Doc,
  dsheetId: string,
): Y.Map<string> {
  return ydoc.getMap(getCommentAnchorsMapKey(dsheetId)) as Y.Map<string>;
}

export function readCommentAnchorsFromYdoc(
  ydoc: Y.Doc | null | undefined,
  dsheetId: string,
): Record<string, string> {
  if (!ydoc || !dsheetId) return {};
  const map = getCommentAnchorsYMap(ydoc, dsheetId);
  const anchors: Record<string, string> = {};
  map.forEach((value, id) => {
    if (typeof id === 'string' && typeof value === 'string' && value.length > 0) {
      anchors[id] = value;
    }
  });
  return anchors;
}

type CommentAnchorRecord = {
  id?: string;
  key?: string;
  contentHash?: string;
};

function commentAliases(comment: CommentAnchorRecord | null | undefined): string[] {
  const aliases: string[] = [];
  if (typeof comment?.id === 'string' && comment.id.length > 0) {
    aliases.push(comment.id);
  }
  if (typeof comment?.contentHash === 'string' && comment.contentHash.length > 0) {
    aliases.push(comment.contentHash);
  }
  return aliases;
}

/**
 * Re-key comments by identity first (id, then contentHash), then the comment's
 * own current cell-key. Stale cell-key aliases that now belong to another
 * thread must not steal or duplicate it.
 */
export function applyCommentAnchorMap<T extends CommentAnchorRecord>(
  commentsData: Record<string, T> | null | undefined,
  anchors: Record<string, string>,
): Record<string, T> {
  if (!commentsData) return {};
  const anchorIds = Object.keys(anchors);
  if (anchorIds.length === 0) return commentsData;

  const next: Record<string, T> = {};
  const seenIdentity = new Set<string>();
  let changed = false;

  for (const [key, comment] of Object.entries(commentsData)) {
    const identity =
      (typeof comment?.id === 'string' && comment.id) ||
      (typeof comment?.contentHash === 'string' && comment.contentHash) ||
      key;
    if (seenIdentity.has(identity)) {
      changed = true;
      continue;
    }
    seenIdentity.add(identity);

    const idKey =
      typeof comment?.id === 'string' && comment.id.length > 0
        ? anchors[comment.id]
        : undefined;
    const hashKey =
      typeof comment?.contentHash === 'string' && comment.contentHash.length > 0
        ? anchors[comment.contentHash]
        : undefined;
    const cellKeyAlias = anchors[key];
    const newKey = idKey || hashKey || cellKeyAlias || key;

    if (newKey !== key || comment.key !== newKey) changed = true;

    if (next[newKey] && next[newKey]?.id !== comment?.id) {
      const withoutKey = `WITHOUT_CELL_${comment?.id || identity}`;
      next[withoutKey] = { ...comment, key: withoutKey };
      continue;
    }

    next[newKey] = newKey === comment.key ? comment : { ...comment, key: newKey };
  }

  return changed ? next : commentsData;
}

export function applyYdocCommentAnchors<T extends CommentAnchorRecord>(
  commentsData: Record<string, T> | object | null | undefined,
  ydoc: Y.Doc | null | undefined,
  dsheetId: string,
): Record<string, T> {
  const data = (commentsData ?? {}) as Record<string, T>;
  if (!ydoc || !dsheetId) return data;
  const anchors = readCommentAnchorsFromYdoc(ydoc, dsheetId);
  return applyCommentAnchorMap(data, anchors);
}

/**
 * Persist current commentId/contentHash → cell-key into ydoc so viewers/publish
 * see the remapped positions. No-ops when the map already matches.
 */
export function writeCommentAnchorsToYdoc({
  ydoc,
  dsheetId,
  commentsData,
  handleContentPortal,
  skipUnmapped = false,
  keyMoves,
}: {
  ydoc: Y.Doc | null | undefined;
  dsheetId: string;
  commentsData: Record<string, CommentAnchorRecord> | null | undefined;
  handleContentPortal?: () => void;
  /** When the map already has entries, skip comments that are not in it yet. */
  skipUnmapped?: boolean;
  /** old cell-key → new cell-key so indexer keys still resolve after remap. */
  keyMoves?: Record<string, string>;
}): void {
  if (!ydoc || !dsheetId || !commentsData) {
    return;
  }
  const map = getCommentAnchorsYMap(ydoc, dsheetId);
  let changed = false;
  const existingSize = map.size;
  ydoc.transact(() => {
    if (keyMoves && Object.keys(keyMoves).length > 0) {
      const occupied = new Set(
        Object.values(commentsData)
          .map((comment) => comment?.key)
          .filter((key): key is string => typeof key === 'string' && key.length > 0),
      );
      const toUpdate: Array<[string, string]> = [];
      map.forEach((cellKey, alias) => {
        const moved = keyMoves[cellKey];
        if (moved && moved !== cellKey) toUpdate.push([alias, moved]);
      });
      toUpdate.forEach(([alias, moved]) => {
        map.set(alias, moved);
        changed = true;
      });
      Object.entries(keyMoves).forEach(([oldKey, newKey]) => {
        if (!oldKey || !newKey) return;
        // A cell-key alias that is another thread's current key would steal it.
        if (occupied.has(oldKey)) return;
        if (map.get(oldKey) !== newKey) {
          map.set(oldKey, newKey);
          changed = true;
        }
      });
    }
    Object.values(commentsData).forEach((comment) => {
      if (typeof comment?.key !== 'string' || !comment.key) {
        return;
      }
      const aliases = commentAliases(comment);
      if (aliases.length === 0) {
        return;
      }
      if (skipUnmapped && existingSize > 0 && aliases.every((alias) => !map.has(alias))) {
        return;
      }
      if (skipUnmapped) {
        const existingKey = aliases
          .map((alias) => map.get(alias))
          .find((value): value is string => typeof value === 'string' && value.length > 0);
        if (existingKey) {
          aliases.forEach((alias) => {
            if (!map.has(alias)) {
              map.set(alias, existingKey);
              changed = true;
            }
          });
          return;
        }
      }
      const commentKey = comment.key;
      aliases.forEach((alias) => {
        if (map.get(alias) !== commentKey) {
          map.set(alias, commentKey);
          changed = true;
        }
      });
    });
  });
  if (changed) handleContentPortal?.();
}
