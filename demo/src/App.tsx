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
import {
  getKeyFromURLParams,
  getSheetIdFromURL,
  setURLParams,
} from './utils';

function App() {
  const isMediaMax1280px = useMediaQuery('(max-width: 1280px)');
  const sheetEditorRef = useRef<WorkbookInstance>(null);
  const { theme } = useTheme();

  // --- Sheet identity ---
  const [dsheetId] = useState<string>(() => {
    const urlSheetId = getSheetIdFromURL();
    if (urlSheetId) return urlSheetId;
    const id = `dsheet-${crypto.randomUUID()}`;
    setURLParams({ sheet: id });
    return id;
  });

  // --- Persistence — use ref so saves don't trigger App re-render ---
  const [title, setTitle] = useState('Untitled');
  const isSavedRef = useRef(false);

  const handleSheetChange = useCallback(
    (_updateData: unknown, encodedUpdate?: string) => {
      if (encodedUpdate) {
        localStorage.setItem(`dsheet-content-${dsheetId}`, encodedUpdate);
        isSavedRef.current = true;
      }
    },
    [dsheetId],
  );

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
          <Tag
            icon="BadgeCheck"
            className="h-6 rounded !border !color-border-default color-text-secondary text-[12px] font-normal hidden xl:flex"
          >
            Saved locally
          </Tag>

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

          <Button toggleLeftIcon={true} leftIcon="Share2" variant={'ghost'} className="!min-w-[90px] !px-0 hidden xl:flex">
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
  }, [title, collabEnabled, collabStatus, collabIsOwner, collaborationId, collabRoomKey, username, isMediaMax1280px, isOwnerEdSecretSet]);

  const [isNewSheet, setIsNewSheet] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setIsNewSheet(true), 5000);
    return () => clearTimeout(timer);
  }, []);

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
              <DSheetEditor
                isReadOnly={false}
                theme={theme}
                renderNavbar={renderNavbar}
                dsheetId={dsheetId}
                onChange={handleSheetChange}
                sheetEditorRef={sheetEditorRef}
                enableIndexeddbSync={true}
                isAuthorized={false}
                isNewSheet={isNewSheet}
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
            </div>
          }
        />
      </Routes>
    </Router>
  );
}

export default App;
