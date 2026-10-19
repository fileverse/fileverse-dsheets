import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { DSheetEditor, WorkbookInstance, CommentAction, remapCommentAnchors } from '../../src/index';
import type {
  CollaborationProps,
  CollabState,
  CommentThread,
  CommentActionParams,
  CommentAnchorMove,
} from '../../src/index';
import {
  Button,
  Tag,
  IconButton,
  LucideIcon,
  DynamicDropdown,
  Toaster,
  toast,
  ThemeToggle,
  useTheme,
} from '@fileverse/ui';
import { useMediaQuery } from 'usehooks-ts';
import { crypto as cryptoUtils } from './crypto';
import { collabStore } from './storage/collab-store';
import { swarmEnabled, useSwarmStorage } from './storage/swarm-store';
import { MAX_RESTORE_ATTEMPTS, useSwarmSheet } from './storage/swarm-sheet';
import { SwarmNotice } from './components/SwarmNotice';
import { SwarmRestoreProgress } from './components/SwarmRestoreProgress';
import { SwarmVersionMenu } from './components/SwarmVersionMenu';
import { primarySwarmCondition } from '../../src/swarm/swarm-diagnostics';
import type { DocumentVersion } from '../../src/swarm/swarm-document-storage';
import {
  deleteDsheetContent,
  mergeDsheetContent,
  type DSheetContentSnapshot,
} from '../../src/persistence';
import {
  getKeyFromURLParams,
  getSheetIdFromURL,
  setURLParams,
} from './utils';

/** Keep ?swarmVersion=N in the address bar (shareable) without reloading. */
const syncVersionParam = (n: number | null) => {
  const url = new URL(window.location.href);
  if (n === null) url.searchParams.delete('swarmVersion');
  else url.searchParams.set('swarmVersion', String(n));
  window.history.replaceState(null, '', url.toString());
};

type VersionPreview = {
  index: number;
  /** The version's encoded sheet state, as saved. */
  state: string;
};

function App() {
  const isMediaMax1280px = useMediaQuery('(max-width: 1280px)');
  const sheetEditorRef = useRef<WorkbookInstance>(null);
  const { theme } = useTheme();

  // --- Sheet identity ---
  // A URL that names no sheet reopens the browser's last one rather than
  // starting blank: opening "the app" and finding an empty grid where your
  // sheet was reads as data loss, though the sheet still lives under its
  // own ?sheet= URL. A genuinely new sheet is one URL edit away (drop the
  // ?sheet= parameter in a private window, or pass ?sheet=<new-id>).
  const [dsheetId] = useState<string>(() => {
    const urlSheetId = getSheetIdFromURL();
    if (urlSheetId) {
      localStorage.setItem('dsheet-last-sheet-id', urlSheetId);
      setURLParams({ sheet: urlSheetId });
      return urlSheetId;
    }
    const id =
      localStorage.getItem('dsheet-last-sheet-id') ??
      `dsheet-${crypto.randomUUID()}`;
    localStorage.setItem('dsheet-last-sheet-id', id);
    setURLParams({ sheet: id });
    return id;
  });

  // --- Persistence — use ref so saves don't trigger App re-render ---
  const [title, setTitle] = useState('Untitled');
  const isSavedRef = useRef(false);

  // --- Swarm persistence (opt-in via VITE_BEE_API_URL or a browser provider) ---
  const swarm = useSwarmStorage(dsheetId);
  // Set once a save is refused because another identity owns the feed —
  // the document came from someone else's link and is read-only here.
  const [sharedReadOnly, setSharedReadOnly] = useState(false);
  const { markDocumentReadOnly } = swarm;
  const onReadOnlySave = useCallback(() => {
    markDocumentReadOnly();
    setSharedReadOnly(true);
  }, [markDocumentReadOnly]);
  // A provider reveals this app's feed identity only once the user grants
  // access, so a sheet created here (no own key in the URL) cannot even be
  // looked up before consent. Defer the restore — the Swarm notice offers
  // the grant, and when it arrives the storage flows in and restore runs.
  // A sheet opened from a link carries its own key and reads freely.
  const restoreDeferred =
    swarmEnabled &&
    swarm.diagnosticsInput.provider?.reason === 'not-connected' &&
    !swarm.documentHasOwnKey;
  const swarmSheet = useSwarmSheet({
    documentId: dsheetId,
    docStorage: restoreDeferred ? null : swarm.docStorage,
    canWrite: swarm.canWrite,
    // A sheet whose keys came in the URL exists on Swarm by definition —
    // an empty lookup for it is a retrieval failure, not a new sheet.
    expectContent: swarm.documentHasOwnKey,
    onReadOnlySave,
  });
  const { queueSave } = swarmSheet;
  // Once the user has typed, a (deferred or retried) restore must not put
  // the loading screen back over their sheet — it merges silently instead.
  const [hasEdited, setHasEdited] = useState(false);

  // Guards a link-opened sheet's feed against its own reader: the editor
  // fires onChange the moment it mounts, and saving before the restore has
  // merged would append a version MISSING the remote content (a snapshot
  // holds only what the local doc has). Saves for such a sheet wait until
  // the merge happened — or the feed proved genuinely empty. Kept in a ref
  // so handleSheetChange's identity stays stable.
  const swarmMergedRef = useRef(false);
  const swarmSafeToSaveRef = useRef(false);
  swarmSafeToSaveRef.current =
    !swarmEnabled ||
    !swarm.documentHasOwnKey ||
    (swarmSheet.restore.phase === 'done' &&
      (swarmSheet.restore.snapshot === null || swarmMergedRef.current));

  const handleSheetChange = useCallback(
    (_updateData: unknown, encodedUpdate?: string) => {
      if (encodedUpdate) {
        localStorage.setItem(`dsheet-content-${dsheetId}`, encodedUpdate);
        isSavedRef.current = true;
        setHasEdited(true);
        if (swarmEnabled && swarmSafeToSaveRef.current)
          queueSave(encodedUpdate);
      }
    },
    [dsheetId, queueSave],
  );

  // --- Swarm restore: merge the loaded snapshot into the live Y.Doc once
  // both the snapshot and the editor (local IndexedDB sync) are ready. A
  // merge is a CRDT union, so local edits made meanwhile survive it. ---
  const editorStateRef = useRef<{
    refreshIndexedDB: () => Promise<void>;
    getContentSnapshot: () => DSheetContentSnapshot;
    mergeContent: (encodedState: string) => DSheetContentSnapshot;
  } | null>(null);
  const [contentSynced, setContentSynced] = useState(false);
  const onContentSyncStatusChange = useCallback(
    (status: 'initializing' | 'syncing' | 'synced' | 'error') =>
      setContentSynced(status === 'synced'),
    [],
  );
  useEffect(() => {
    if (swarmMergedRef.current || !contentSynced || !editorStateRef.current)
      return;
    if (swarmSheet.restore.phase !== 'done' || !swarmSheet.restore.snapshot)
      return;
    editorStateRef.current.mergeContent(swarmSheet.restore.snapshot);
    swarmMergedRef.current = true;
  }, [swarmSheet.restore, contentSynced]);

  // Boot overlay while a Swarm-backed sheet is being restored. Loading in
  // this state (rather than behind the sheet) prevents editing a stale
  // sheet that the restore is about to catch up.
  const swarmBooting =
    swarmEnabled &&
    !swarmMergedRef.current &&
    !hasEdited &&
    !restoreDeferred &&
    (swarm.nodeState.kind === 'connecting' ||
      swarmSheet.restore.phase === 'loading' ||
      swarmSheet.restore.phase === 'failed');

  // A sheet whose feed key came in the link can never be published from a
  // provider browser (it signs only as itself), so publishing obstacles —
  // the Grant access prompt included — are noise for it: reading needs no
  // permission. Same suppression ddoc applies.
  const providerReadOnlySheet = swarm.managesPostage && swarm.documentHasOwnKey;
  const swarmCondition = swarmEnabled
    ? primarySwarmCondition({
        ...swarm.diagnosticsInput,
        lastError: swarmSheet.lastError,
        documentReadOnly: sharedReadOnly || providerReadOnlySheet,
      })
    : null;

  // A restore that exhausted its budget against a cold node retries by
  // itself when the provider's state changes (it warmed up, or access was
  // granted) — a visitor should not have to know to press Try again.
  const providerReason = swarm.diagnosticsInput.provider?.reason;
  const prevProviderReasonRef = useRef(providerReason);
  const retrySwarmRestore = swarmSheet.retryRestore;
  useEffect(() => {
    const changed = prevProviderReasonRef.current !== providerReason;
    prevProviderReasonRef.current = providerReason;
    if (changed && swarmSheet.restore.phase === 'failed') {
      retrySwarmRestore();
    }
  }, [providerReason, swarmSheet.restore.phase, retrySwarmRestore]);

  // --- Swarm version history: the status tag lists the sheet's versions.
  // A version opens read-only through the editor's published-content path
  // (portalContent, no IndexedDB), so looking never touches this browser's
  // copy; it can then be restored as the newest version. History is never
  // rewritten. ?swarmVersion=N links to a version. ---
  const { docStorage } = swarm;
  const { queueRestoreSave } = swarmSheet;
  const canRestoreVersion =
    swarm.canWrite && !sharedReadOnly && !providerReadOnlySheet;
  const [versionPreview, setVersionPreview] = useState<VersionPreview | null>(
    null,
  );
  const [versionList, setVersionList] = useState<DocumentVersion[] | null>(
    null,
  );
  const [versionListError, setVersionListError] = useState<string | null>(
    null,
  );
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [versionMenuPos, setVersionMenuPos] = useState({ top: 0, left: 0 });
  const swarmTagRef = useRef<HTMLButtonElement | null>(null);
  const pendingVersionParamRef = useRef<number | null>(
    (() => {
      const v = new URLSearchParams(window.location.search).get('swarmVersion');
      return v === null || !/^\d+$/.test(v) ? null : Number(v);
    })(),
  );
  const closeVersionMenu = useCallback(() => setVersionsOpen(false), []);
  const openVersionHistory = useCallback(async () => {
    if (!docStorage) return;
    const rect = swarmTagRef.current?.getBoundingClientRect();
    setVersionMenuPos(
      rect
        ? { top: rect.bottom + 4, left: rect.left }
        : { top: 56, left: window.innerWidth / 2 - 120 },
    );
    setVersionsOpen((open) => !open);
    setVersionListError(null);
    try {
      setVersionList(await docStorage.listDocumentVersions(dsheetId));
    } catch (error) {
      console.warn('Swarm version list failed', error);
      setVersionList([]);
      setVersionListError((error as Error).message);
    }
  }, [docStorage, dsheetId]);
  const previewVersion = useCallback(
    async (index: number) => {
      if (!docStorage) return;
      try {
        const snapshot = await docStorage.loadDocumentVersion(dsheetId, index);
        if (!snapshot) return;
        setVersionPreview({ index, state: snapshot.text });
        syncVersionParam(index);
      } catch (error) {
        console.warn('Swarm version load failed', error);
        toast({
          title: `Could not load v${index} from Swarm`,
          description: (error as Error).message,
          variant: 'error',
          iconType: 'icon',
        });
      }
    },
    [docStorage, dsheetId],
  );
  // The live editor was unmounted while a version was open, so leaving the
  // preview mounts it afresh from this browser's copy.
  const exitVersionPreview = useCallback(() => {
    setVersionPreview(null);
    setVersionsOpen(false);
    syncVersionParam(null);
  }, []);
  // Restore as latest: the version is saved again as the newest one and
  // replaces this browser's copy. A merge cannot undo newer edits, so the
  // copy is deleted and refilled; nothing holds it open meanwhile, since
  // the live editor is not mounted while restoring.
  const [restoringVersion, setRestoringVersion] =
    useState<VersionPreview | null>(null);
  useEffect(() => {
    if (!restoringVersion) return;
    let cancelled = false;
    void (async () => {
      try {
        await deleteDsheetContent(dsheetId);
        const merged = await mergeDsheetContent(
          dsheetId,
          restoringVersion.state,
        );
        if (merged.status !== 'available') {
          throw new Error(
            `Could not write the version into this browser's copy (${merged.status})`,
          );
        }
        localStorage.setItem(
          `dsheet-content-${dsheetId}`,
          restoringVersion.state,
        );
        queueRestoreSave(restoringVersion.state);
      } catch (error) {
        console.error('Swarm restore failed', error);
        toast({
          title: `Could not restore v${restoringVersion.index}`,
          description: (error as Error).message,
          variant: 'error',
          iconType: 'icon',
        });
      }
      if (cancelled) return;
      setVersionList(null);
      setRestoringVersion(null);
      exitVersionPreview();
    })();
    return () => {
      cancelled = true;
    };
  }, [restoringVersion, dsheetId, queueRestoreSave, exitVersionPreview]);
  // ?swarmVersion=N: open that version once the sheet itself is open.
  useEffect(() => {
    const pending = pendingVersionParamRef.current;
    if (pending === null || !docStorage || swarmBooting) return;
    if (swarmSheet.restore.phase !== 'done') return;
    pendingVersionParamRef.current = null;
    void previewVersion(pending);
  }, [docStorage, swarmBooting, swarmSheet.restore.phase, previewVersion]);

  // --- In-memory comment store (plays the role of the consumer's useComments) ---
  const [commentsData, setCommentsData] = useState<
    Record<string, CommentThread>
  >({});

  const readTextarea = (id: string) =>
    (document.getElementById(id) as HTMLTextAreaElement | null)?.value?.trim() ??
    '';

  const onSendComment = useCallback(
    (key: string, textareaId: string) => {
      const content = readTextarea(textareaId);
      if (!content) return;
      setCommentsData((prev) => {
        const existing = prev[key];
        if (existing) {
          // reply
          return {
            ...prev,
            [key]: {
              ...existing,
              replies: [
                ...existing.replies,
                {
                  id: `r-${Date.now()}`,
                  username: 'demo-user',
                  content,
                  createdAt: new Date().toISOString(),
                  commentIndex: existing.replies.length,
                },
              ],
            },
          };
        }
        return {
          ...prev,
          [key]: {
            id: `c-${Date.now()}`,
            key,
            dsheetId,
            username: 'demo-user',
            content,
            createdAt: new Date().toISOString(),
            commentIndex: 0,
            replies: [],
          },
        };
      });
      const el = document.getElementById(
        textareaId,
      ) as HTMLTextAreaElement | null;
      if (el) el.value = '';
    },
    [dsheetId],
  );

  const onCellPositionsChanged = useCallback((move: CommentAnchorMove) => {
    setCommentsData((prev) => remapCommentAnchors(prev, move));
  }, []);

  const onCommentAction = useCallback((a: CommentActionParams) => {
    setCommentsData((prev) => {
      const c = prev[a.commentKey];
      if (!c) return prev;
      if (a.action === CommentAction.DELETE && !a.isReply) {
        const next = { ...prev };
        delete next[a.commentKey];
        return next;
      }
      if (a.action === CommentAction.DELETE && a.isReply) {
        return {
          ...prev,
          [a.commentKey]: {
            ...c,
            replies: c.replies.filter((r) => r.id !== a.commentId),
          },
        };
      }
      if (a.action === CommentAction.RESOLVE)
        return { ...prev, [a.commentKey]: { ...c, isResolved: true } };
      if (a.action === CommentAction.UNRESOLVE)
        return { ...prev, [a.commentKey]: { ...c, isResolved: false } };
      return prev;
    });
  }, []);

  // --- Collab state ---
  const [collabEnabled, setCollabEnabled] = useState(false);
  const [collabStatus, setCollabStatus] = useState<string>('off');
  const [username, setUsernameState] = useState('Anonymous');
  const [collaborationId, setCollaborationId] = useState('');
  const [collabRoomKey, setCollabRoomKey] = useState('');
  const [collabIsOwner, setCollabIsOwner] = useState(false);
  const [collabExtras, setCollabExtras] = useState<{
    ownerEdSecret?: string;
    contractAddress?: string;
    ownerAddress?: string;
  }>({});

  const isOwnerEdSecretSet = Boolean(import.meta.env.VITE_OWNER_ED_SECRET);

  // Restore saved collab config on mount
  useEffect(() => {
    const stored = collabStore.getCollabConf();
    if (stored) {
      setCollabRoomKey(stored.roomKey);
      setCollaborationId(stored.roomId);
      setUsernameState(stored.username);
      setCollabIsOwner(stored.isOwner);
      setCollabExtras({
        ownerEdSecret: stored.ownerEdSecret,
        contractAddress: stored.contractAddress,
        ownerAddress: stored.ownerAddress,
      });
      setCollabEnabled(true);
    }
  }, []);

  // Auto-join from URL params (invite link)
  useEffect(() => {
    const searchParams = new URLSearchParams(window.location.search);
    const paramCollaborationId = searchParams.get('collaborationId');
    const paramKey = getKeyFromURLParams(searchParams);

    if (paramCollaborationId && paramKey) {
      const name = prompt("What's your username?");
      if (!name) return;
      setCollabRoomKey(paramKey);
      setCollaborationId(paramCollaborationId);
      setUsernameState(name);
      setCollabIsOwner(false);
      setCollabEnabled(true);
    }
  }, []);

  const onStartCollaboration = async () => {
    const name = prompt("What's your username?");
    if (!name) return;

    const { privateKeyBase64 } = cryptoUtils.generateKeyPair();
    const newCollabId = globalThis.crypto.randomUUID();

    const extras = {
      ownerEdSecret: import.meta.env.VITE_OWNER_ED_SECRET,
      contractAddress: import.meta.env.VITE_COLLAB_CONTRACT_ADDRESS,
      ownerAddress: import.meta.env.VITE_COLLAB_OWNER_ADDRESS,
    };

    collabStore.setCollabConf({
      roomKey: privateKeyBase64,
      roomId: newCollabId,
      wsUrl: import.meta.env.VITE_COLLAB_WS_URL,
      isOwner: true,
      username: name,
      ...extras,
    });

    setCollabRoomKey(privateKeyBase64);
    setCollaborationId(newCollabId);
    setUsernameState(name);
    setCollabIsOwner(true);
    setCollabExtras(extras);
    setCollabEnabled(true);

    const inviteUrl = `${window.location.origin}${window.location.pathname}?collaborationId=${newCollabId}&sheet=${dsheetId}#key=${privateKeyBase64}`;
    await navigator.clipboard.writeText(inviteUrl).catch(() => { });

    toast({
      title: 'Collaboration started',
      description: 'Invite link copied to clipboard',
      variant: 'success',
      toastType: 'mini',
      iconType: 'icon',
    });
  };

  const onStopCollaboration = () => {
    collabStore.clearCollabConf();
    setCollabEnabled(false);
    setCollaborationId('');
    setCollabRoomKey('');
    setUsernameState('Anonymous');
    setCollabIsOwner(false);
    setCollabExtras({});
    setCollabStatus('off');
  };

  const collaboration = useMemo((): CollaborationProps => {
    if (!collabEnabled || !collaborationId || !collabRoomKey) {
      return { enabled: false };
    }
    return {
      enabled: true,
      connection: {
        roomKey: collabRoomKey,
        roomId: collaborationId,
        wsUrl: import.meta.env.VITE_COLLAB_WS_URL,
        isOwner: collabIsOwner,
        ownerEdSecret: collabExtras.ownerEdSecret,
        contractAddress: collabExtras.contractAddress,
        ownerAddress: collabExtras.ownerAddress,
      },
      session: { username },
      services: {
        commitToStorage: undefined,
        fetchFromStorage: undefined,
      },
      on: {
        onStateChange: (state: CollabState) => {
          if (state.status === 'syncing') {
            setCollabStatus(state.hasUnmergedPeerUpdates ? 'merging' : 'syncing');
          } else {
            setCollabStatus(state.status);
          }
          if (state.status === 'syncing' && state.hasUnmergedPeerUpdates) {
            toast({ title: 'Syncing new changes from peers', variant: 'info', toastType: 'mini', iconType: 'icon' });
          } else if (state.status === 'reconnecting') {
            toast({ title: `Reconnecting (${state.attempt}/${state.maxAttempts})...`, variant: 'warning', toastType: 'mini', iconType: 'icon' });
          } else if (state.status === 'error') {
            toast({ title: 'Collaboration error', description: state.error.message, variant: 'error', iconType: 'icon' });
          }
        },
        onError: (error) => {
          console.error('[DSheet] collab error:', error);
          toast({ title: 'Collaboration error', description: error.message, variant: 'error', iconType: 'icon' });
        },
      },
    };
  }, [collabEnabled, collaborationId, collabRoomKey, collabIsOwner, collabExtras, username]);



  // --- Navbar (memoized — stable reference, no re-renders from collab/save state) ---
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const renderNavbar = useCallback((editorValues?: any): JSX.Element => {
    return (
      <>
        <div className="flex items-center gap-[12px]">
          <IconButton variant={'ghost'} icon="Menu" size="md" />
          <div className="relative truncate inline-block xl:!max-w-[300px] !max-w-[108px] color-bg-default text-[14px] font-medium leading-[20px]">
            <span className="invisible whitespace-pre">{title || 'Untitled'}</span>
            <input
              className="focus:outline-none truncate color-bg-default absolute top-0 left-0 right-0 bottom-0 select-text"
              type="text"
              placeholder="Untitled"
              value={title || 'Untitled'}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          {/* With Swarm on, the tag is the live save state and the way into
              version history, so it stays visible on laptop widths (from
              sm), where upstream's static label hides (below xl). */}
          {swarmEnabled ? (
            <button
              type="button"
              ref={swarmTagRef}
              onClick={openVersionHistory}
              title="Version history on Swarm"
              aria-haspopup="menu"
              aria-expanded={versionsOpen}
              className="h-6 rounded border color-border-default color-text-secondary text-[12px] font-normal hidden sm:flex items-center gap-1 px-2 whitespace-nowrap cursor-pointer"
              style={{ backgroundColor: 'hsl(var(--color-bg-secondary))' }}
            >
              <LucideIcon name="History" size="sm" />
              {versionPreview
                ? `Viewing v${versionPreview.index}`
                : // A sheet this browser cannot write (another identity's
                  // feed, or a link-keyed sheet under a provider) never
                  // saves here, so "held" would promise what cannot happen.
                  sharedReadOnly || providerReadOnlySheet
                  ? swarmSheet.version === null
                    ? 'Read-only here'
                    : `On Swarm · v${swarmSheet.version} · read-only`
                  : {
                    // A sheet restored from Swarm, or saved before, is on
                    // Swarm even before this visit edits it.
                    idle:
                      swarmSheet.version === null
                        ? 'Saved locally'
                        : `On Swarm · v${swarmSheet.version}`,
                    saving: 'Saving to Swarm…',
                    saved: `Saved to Swarm · v${swarmSheet.version}`,
                    held: 'Edits held for Swarm',
                    error: 'Swarm save failed',
                  }[swarmSheet.saveState]}
              <LucideIcon name="ChevronDown" size="sm" />
            </button>
          ) : (
            <Tag
              icon="BadgeCheck"
              className="h-6 rounded !border !color-border-default color-text-secondary text-[12px] font-normal hidden xl:flex"
            >
              Saved locally
            </Tag>
          )}

          {collabEnabled && (
            <Tag
              className={`h-6 rounded hidden xl:flex text-[12px] font-normal ${collabStatus === 'ready' ? 'bg-green-100 text-green-700' : 'bg-yellow-100 text-yellow-700'
                }`}
            >
              {collabStatus === 'ready' ? '● Live' : `● ${collabStatus}`}
            </Tag>
          )}
        </div>

        <div className="flex gap-2">
          <ThemeToggle />

          <button
            type="button"
            onClick={() => editorValues?.openPanel('comments')}
            style={{
              border: '1px solid #ccc',
              borderRadius: 6,
              padding: '2px 8px',
            }}
          >
            Comments
          </button>
          {isMediaMax1280px ? (
            <DynamicDropdown
              key="navbar-more-actions"
              align="center"
              sideOffset={10}
              anchorTrigger={<IconButton icon={'EllipsisVertical'} variant="ghost" size="md" />}
              content={
                <div className="flex flex-col gap-1 p-2 w-fit shadow-elevation-3">
                  <Button variant={'ghost'} onClick={() => { }} className="flex justify-start gap-2">
                    <LucideIcon name="Share2" size="sm" />
                    Share
                  </Button>
                </div>
              }
            />
          ) : (
            <IconButton variant={'ghost'} icon="Share2" className="flex xl:hidden" size="md" />
          )}

          {!collabEnabled ? (
            <IconButton
              variant={'ghost'}
              disabled={!isOwnerEdSecretSet}
              icon="Users"
              size="md"
              title={isOwnerEdSecretSet ? 'Start collaboration' : 'Set VITE_OWNER_ED_SECRET in demo/.env to enable'}
              onClick={onStartCollaboration}
            />
          ) : (
            <DynamicDropdown
              key="collab-actions"
              align="center"
              sideOffset={10}
              anchorTrigger={<IconButton icon={'Users'} variant="ghost" size="md" title={`Collab: ${collabStatus}`} />}
              content={
                <div className="flex flex-col gap-1 p-2 w-fit shadow-elevation-3 min-w-[180px]">
                  <p className="text-xs text-gray-500 px-2 py-1">
                    {username} · {collabIsOwner ? 'Owner' : 'Collaborator'}
                  </p>
                  <p className="text-xs text-gray-500 px-2 pb-1">
                    Status: <strong>{collabStatus}</strong>
                  </p>
                  {collabIsOwner && (
                    <Button
                      variant={'ghost'}
                      onClick={async () => {
                        const inviteUrl = `${window.location.origin}${window.location.pathname}?collaborationId=${collaborationId}&sheet=${dsheetId}#key=${collabRoomKey}`;
                        await navigator.clipboard.writeText(inviteUrl).catch(() => { });
                        toast({ title: 'Invite link copied', variant: 'success', toastType: 'mini', iconType: 'icon' });
                      }}
                      className="flex justify-start gap-2"
                    >
                      <LucideIcon name="Copy" size="sm" />
                      Copy invite link
                    </Button>
                  )}
                  <Button
                    variant={'ghost'}
                    onClick={onStopCollaboration}
                    className="flex justify-start gap-2 text-red-500"
                  >
                    <LucideIcon name="UserX" size="sm" />
                    {collabIsOwner ? 'Stop collaboration' : 'Leave session'}
                  </Button>
                </div>
              }
            />
          )}

          <Button
            toggleLeftIcon={true}
            leftIcon="Share2"
            variant={'ghost'}
            className="!min-w-[90px] !px-0 hidden xl:flex"
            onClick={async () => {
              if (!swarmEnabled) return;
              // The URL fragment already carries the feed + decryption keys
              // (see resolveKeys in swarm-store), so the address bar IS the
              // share link: whoever opens it can read this sheet from Swarm.
              await navigator.clipboard
                .writeText(window.location.href)
                .catch(() => {});
              toast({
                title: 'Swarm link copied',
                description: 'Anyone with this link can read the sheet',
                variant: 'success',
                toastType: 'mini',
                iconType: 'icon',
              });
            }}
          >
            Share
          </Button>
          <div className="flex gap-2 px-2 justify-center items-center">
            <LucideIcon name="Farcaster" />
            <div className="flex-col hidden xl:flex">
              <p className="text-heading-xsm">@[username]</p>
              <p className="text-helper-text-sm">Farcaster</p>
            </div>
          </div>
        </div>
      </>
    );
  }, [title, collabEnabled, collabStatus, collabIsOwner, collaborationId, collabRoomKey, username, isMediaMax1280px, isOwnerEdSecretSet, swarmSheet.saveState, swarmSheet.version, versionPreview, versionsOpen, openVersionHistory, sharedReadOnly, providerReadOnlySheet]);

  const [isNewSheet, setIsNewSheet] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setIsNewSheet(true), 5000);
    return () => clearTimeout(timer);
  }, []);
  // A link-opened sheet is never "new": letting the editor seed a default
  // empty sheet while a slow restore is still running would CRDT-merge a
  // second Sheet1 into the real content (and, before the save guard, save
  // that over the feed).
  const isNewSheetSafe =
    isNewSheet && (!swarmEnabled || !swarm.documentHasOwnKey);

  // @ts-expect-error demo proxy
  window.NEXT_PUBLIC_PROXY_BASE_URL = 'https://staging-api-proxy-ca4268d7d581.herokuapp.com';

  useEffect(() => {
    // Demo-only: allows automated shortcut verification via window.__dsheetRef
    (window as unknown as { __dsheetRef?: typeof sheetEditorRef }).__dsheetRef =
      sheetEditorRef;
  });

  return (
    <Router>
      <Routes>
        <Route
          path="*"
          element={
            <div>
              <Toaster position="bottom-right" duration={3000} />
              {versionsOpen && (
                <SwarmVersionMenu
                  position={versionMenuPos}
                  versions={versionList}
                  error={versionListError}
                  viewing={versionPreview?.index ?? null}
                  canRestore={canRestoreVersion}
                  anchorRef={swarmTagRef}
                  onPreview={(index) => void previewVersion(index)}
                  onBack={exitVersionPreview}
                  onRestore={() => {
                    if (!versionPreview) return;
                    setVersionsOpen(false);
                    setRestoringVersion(versionPreview);
                  }}
                  onClose={closeVersionMenu}
                />
              )}
              {swarmCondition && !swarmBooting && (
                <SwarmNotice
                  condition={swarmCondition}
                  beeUrl={swarm.beeUrl ?? ''}
                  batchId={swarm.batchId}
                  onRetry={swarm.recheck}
                  onBatchReady={swarm.adoptBatch}
                  onGrantAccess={swarm.grantAccess}
                />
              )}
              {swarmBooting ? (
                // Shown INSTEAD of the editor (as in the ddoc demo): editing
                // a sheet the restore is about to catch up would mislead.
                <SwarmRestoreProgress
                  nodeState={swarm.nodeState}
                  progress={swarm.progress}
                  managesPostage={swarm.managesPostage}
                  attempt={
                    swarmSheet.restore.phase === 'loading'
                      ? swarmSheet.restore.attempt
                      : undefined
                  }
                  maxAttempts={MAX_RESTORE_ATTEMPTS}
                  error={
                    swarmSheet.restore.phase === 'failed'
                      ? swarmSheet.restore.error
                      : null
                  }
                  onSkip={swarmSheet.skipRestore}
                  onRetry={swarmSheet.retryRestore}
                />
              ) : restoringVersion ? (
                <div className="flex h-[60vh] items-center justify-center color-text-secondary text-[14px]">
                  Restoring version {restoringVersion.index} from Swarm…
                </div>
              ) : versionPreview ? (
                // A version, read-only: published-content path, no store.
                <DSheetEditor
                  key={`swarm-v${versionPreview.index}`}
                  isReadOnly={true}
                  portalContent={versionPreview.state}
                  enableIndexeddbSync={false}
                  theme={theme}
                  renderNavbar={renderNavbar}
                  dsheetId={dsheetId}
                  isAuthorized={false}
                  isNewSheet={false}
                />
              ) : (
              <DSheetEditor
                key="live"
                editorStateRef={editorStateRef}
                onContentSyncStatusChange={onContentSyncStatusChange}
                isReadOnly={false}
                theme={theme}
                renderNavbar={renderNavbar}
                dsheetId={dsheetId}
                onChange={handleSheetChange}
                sheetEditorRef={sheetEditorRef}
                enableIndexeddbSync={true}
                isAuthorized={false}
                isNewSheet={isNewSheetSafe}
                collaboration={collaboration}
                commentsConfig={{
                  commentsData,
                  onSendComment,
                  onCommentAction,
                  onCellPositionsChanged,
                  userName: 'demo-user',
                  currentUserAddress: 'demo-user',
                  isOwner: true,
                  isAuthenticated: true,
                  // ENS test: set a real mainnet RPC URL via Vite env to exercise resolution.
                  ensResolutionUrl: import.meta.env.VITE_ENS_RPC_URL,
                }}
              />
              )}
            </div>
          }
        />
      </Routes>
    </Router>
  );
}

export default App;
