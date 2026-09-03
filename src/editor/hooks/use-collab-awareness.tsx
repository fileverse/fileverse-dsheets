import { useEffect, useRef } from 'react';
import { removeAwarenessStates } from 'y-protocols/awareness.js';
import type { Awareness } from 'y-protocols/awareness';
import { WorkbookInstance } from '@sheet-engine/react';
import { COLLAB_PRESENCE_COLORS, presenceColor } from '../../constants';

/**
 * Reads remote cursor positions from Yjs awareness and keeps Fortune sheet's
 * native presence list in sync. Fortune renders colored cell borders + username
 * labels automatically via context.presences[].
 *
 * The host collaborator roster is emitted by SocketClient from the
 * authoritative server room-members list. This hook owns only cell cursors.
 */
export const useCollabAwareness = (
  awareness: Awareness | null | undefined,
  sheetEditorRef: React.MutableRefObject<WorkbookInstance | null>,
) => {
  const colorRef = useRef(
    COLLAB_PRESENCE_COLORS[
    Math.floor(Math.random() * COLLAB_PRESENCE_COLORS.length)
    ],
  );

  // Tracks the last presence set actually written to Fortune. The awareness
  // heartbeat (and every remote cursor move) fires a 'change' on a fixed
  // cadence; without this guard we'd removePresences + addPresences on each
  // one — even when nothing changed — forcing a full Workbook re-render that
  // visibly repaints filter overlays. Skip the churn when the set is identical.
  const lastPresenceSigRef = useRef<string>('');

  // Sync remote awareness states → Fortune addPresences / removePresences
  useEffect(() => {
    if (!awareness) return;

    const handleChange = ({
      removed,
    }: {
      added: number[];
      updated: number[];
      removed: number[];
    }) => {
      const workbook = sheetEditorRef.current;
      if (!workbook) return;

      // Explicitly remove departed clients from Fortune before re-reading states.
      if (removed.length > 0) {
        workbook.removePresences(
          removed.map((id) => ({ userId: String(id), username: '' })),
        );
      }

      const states = awareness.getStates();
      const localClientId = awareness.clientID;
      const presences: {
        sheetId: string;
        username: string;
        userId: string;
        color: string;
        isEns: boolean;
        selection: { r: number; c: number };
      }[] = [];

      states.forEach((state, clientId) => {
        if (clientId === localClientId) return;
        if (!state.user || !state.cell) return;

        const isEns = !!state.user.isEns;
        presences.push({
          sheetId: state.cell.sheetId,
          username: state.user.name ?? 'Anonymous',
          userId: String(clientId),
          color: presenceColor(isEns, state.user.color, clientId),
          isEns,
          selection: { r: state.cell.r, c: state.cell.c },
        });
      });

      // Diff guard: if no peer departed and the computed presence set is
      // identical to what we last wrote, skip the remove/add churn. This stops
      // idle heartbeats (and no-op awareness updates) from triggering a full
      // Workbook re-render — the root cause of the 5s filter flicker.
      const presenceSig = presences
        .map(
          (p) =>
            `${p.userId}:${p.sheetId}:${p.selection.r}:${p.selection.c}:${p.color}:${p.username}`,
        )
        .sort()
        .join('|');
      if (removed.length === 0 && presenceSig === lastPresenceSigRef.current) {
        return;
      }
      lastPresenceSigRef.current = presenceSig;

      // Replace all remote presences atomically:
      // removePresences clears stale entries, addPresences writes current ones
      const allRemoteIds = Array.from(states.keys())
        .filter((id) => id !== localClientId)
        .map((id) => ({ userId: String(id), username: '' }));

      if (allRemoteIds.length > 0) {
        workbook.removePresences(allRemoteIds);
      }
      if (presences.length > 0) {
        workbook.addPresences(presences);
      }
    };

    awareness.on('change', handleChange);

    // Heartbeat: re-broadcast our own awareness state on a fixed cadence so
    // that connected-but-idle peers keep each other "fresh". Without this, a
    // peer who isn't moving their cursor stops sending awareness updates and
    // would be wrongly pruned by the stale-timeout below — their cursor would
    // vanish until they next touch a cell. setLocalState always bumps the
    // awareness clock, forcing an 'update' → socket broadcast.
    const HEARTBEAT_MS = 5000;
    const heartbeatInterval = setInterval(() => {
      const local = awareness.getLocalState();
      if (local) {
        // Spread to a new object so the clock advances and a broadcast fires.
        awareness.setLocalState({ ...local });
      }
    }, HEARTBEAT_MS);

    // Only prune a peer once they've missed several heartbeats (i.e. they are
    // genuinely gone, not merely idle). With a 5s heartbeat, a 30s window means
    // ~6 consecutive misses before removal — robust against transient hiccups.
    const STALE_TIMEOUT_MS = 30000;
    const staleCleanupInterval = setInterval(() => {
      const now = Date.now();
      const stale: number[] = [];
      awareness.meta.forEach(
        (meta: { clock: number; lastUpdated: number }, clientId: number) => {
          if (
            clientId !== awareness.clientID &&
            now - meta.lastUpdated > STALE_TIMEOUT_MS
          ) {
            stale.push(clientId);
          }
        },
      );
      if (stale.length > 0) {
        removeAwarenessStates(awareness, stale, 'timeout');
      }
    }, 5000);

    return () => {
      clearInterval(heartbeatInterval);
      clearInterval(staleCleanupInterval);
      awareness.off('change', handleChange);

      // Clear all presences from Fortune on teardown
      sheetEditorRef.current?.removePresences(
        Array.from(awareness.getStates().keys())
          .filter((id) => id !== awareness.clientID)
          .map((id) => ({ userId: String(id), username: '' })),
      );
    };
  }, [awareness, sheetEditorRef]);

  return { localColor: colorRef.current };
};
