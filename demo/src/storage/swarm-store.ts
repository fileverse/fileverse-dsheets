import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { generatePrivateKey } from 'viem/accounts';
import {
  StampHealth,
  checkStampHealth,
  listStamps,
} from '../../../src/swarm/swarm-stamps';
import {
  SwarmDocumentStorage,
  createSwarmDocumentStorage,
  generateDocumentKey,
} from '../../../src/swarm/swarm-document-storage';
import { SwarmProgress, swarmFetch } from '../../../src/swarm/swarm-common';
import { SwarmFeedConfig } from '../../../src/swarm/swarm-feeds';
import {
  SwarmTransport,
  SwarmTransportStatus,
  detectSwarmTransport,
} from '../../../src/swarm/swarm-transport';

/**
 * Demo wiring for Ethereum Swarm storage (sheet snapshots).
 *
 * Opt-in via env: set `VITE_BEE_API_URL` (e.g. http://localhost:1633) to
 * store sheet snapshots encrypted on Swarm.
 * `VITE_SWARM_POSTAGE_BATCH_ID` pins a postage batch; without it the first
 * usable batch on the node is auto-discovered.
 *
 * Reading Swarm costs nothing — only uploads are stamped — so a node with
 * no usable batch still opens documents, in read-only mode.
 *
 * Demo-grade key handling: the feed owner key and per-document encryption
 * keys resolve from the URL fragment (shareable link), else localStorage.
 */

const beeUrl: string | undefined = import.meta.env.VITE_BEE_API_URL;
/**
 * A Swarm-aware browser injects `window.swarm` and blocks raw access to a
 * node's API, so the provider is what makes the demo work there — and it
 * needs no configuration, unlike a node URL.
 */
const hasProvider = () =>
  typeof window !== 'undefined' &&
  Boolean((window as { swarm?: unknown }).swarm);
const pinnedBatch: string | undefined = import.meta.env
  .VITE_SWARM_POSTAGE_BATCH_ID;

/** Whether Swarm storage is configured (sync, before any probing). */
export const swarmEnabled = Boolean(beeUrl) || hasProvider();

/** Node reachability / write capability, surfaced to the UI. */
export type SwarmNodeState =
  | { kind: 'connecting' }
  | { kind: 'ready'; batchId: string }
  | { kind: 'read-only'; reason: string }
  | { kind: 'unreachable'; reason: string };

/** Node + progress config shared by every storage object the demo builds. */
type SwarmStoreConfig = SwarmFeedConfig & { transport?: SwarmTransport };

const readHashKeys =  (): { owner: string; doc: string } | null => {
  const match = window.location.hash.match(/skey=([^:]+):([^&]+)/);
  return match
    ? {
        owner: decodeURIComponent(match[1]),
        doc: decodeURIComponent(match[2]),
      }
    : null;
};

/** Document key alone, for a document whose feed the provider owns. */
const readHashDocKey = (): string | null => {
  const match = window.location.hash.match(/dkey=([^&]+)/);
  return match ? decodeURIComponent(match[1]) : null;
};

const writeHash = (fragment: string) => {
  if (!window.location.hash.includes(fragment)) {
    window.history.replaceState(null, '', `#${fragment}`);
  }
};

/**
 * Which keys this document uses, and what goes in the address bar.
 *
 * Two shapes, deliberately distinct. `skey=owner:doc` carries a feed
 * signing key: whoever holds the link owns the document. `dkey=doc`
 * carries only the decryption key, for a document whose feed belongs to
 * the browser's own provider identity.
 *
 * Keeping them apart is what lets the app tell "opened from someone
 * else's link" from "created here" — writing one shape and reading the
 * other back made every reloaded document look shared, and a document
 * that looks shared is treated as read-only.
 */
/**
 * The owner key a sheet was OPENED with, remembered per sheet. The address
 * bar is not a reliable carrier: Freedom's cold-start "Content not ready
 * yet" page re-navigates without the URL fragment (field test, 2026-08-18),
 * and a sheet whose keys arrived by link then silently degraded into a
 * provider-owned empty one. A revisit reconstructs the keys from here and
 * writes them back into the URL.
 */
export const sheetOwnerKeyStorageKey = (docId: string) =>
  `dsheet-swarm-owner-key-${docId}`;

const resolveKeys = (
  docId: string,
  generateOwner: () => string,
  generateDoc: () => string,
  providerOwnsFeed: boolean,
): { owner?: string; doc: string } => {
  const ownerStorageKey = 'dsheet-swarm-owner-key';
  const docStorageKey = `dsheet-swarm-doc-key-${docId}`;
  const fromHash = readHashKeys();
  const doc =
    fromHash?.doc ??
    readHashDocKey() ??
    localStorage.getItem(docStorageKey) ??
    generateDoc();
  localStorage.setItem(docStorageKey, doc);

  const rememberedOwner = localStorage.getItem(sheetOwnerKeyStorageKey(docId));

  if (providerOwnsFeed && !fromHash?.owner && !rememberedOwner) {
    writeHash(`dkey=${encodeURIComponent(doc)}`);
    return { doc };
  }

  const owner =
    fromHash?.owner ??
    rememberedOwner ??
    localStorage.getItem(ownerStorageKey) ??
    generateOwner();
  // Per-sheet first — a link's key belongs to that sheet alone. The global
  // key stays what it was: this browser's own signing identity for sheets
  // it creates, never overwritten by someone else's link.
  localStorage.setItem(sheetOwnerKeyStorageKey(docId), owner);
  if (!fromHash?.owner && !rememberedOwner) {
    localStorage.setItem(ownerStorageKey, owner);
  }
  writeHash(`skey=${encodeURIComponent(owner)}:${encodeURIComponent(doc)}`);
  return { owner, doc };
};

export const useSwarmStorage = (docId: string) => {
  const [nodeState, setNodeState] = useState<SwarmNodeState>(() =>
    swarmEnabled ? { kind: 'connecting' } : { kind: 'unreachable', reason: '' },
  );
  /** Adopt a batch bought during the session, without a reload. */
  const adoptBatch = useCallback((batchId: string) => {
    setNodeState({ kind: 'ready', batchId });
  }, []);
  const [stampHealth, setStampHealth] = useState<StampHealth | null>(null);
  const [progress, setProgress] = useState<SwarmProgress | null>(null);
  // Progress handler identity must stay stable — it is baked into the
  // storage config, and a new identity would rebuild the storage object.
  const onProgress = useCallback((p: SwarmProgress) => setProgress(p), []);
  const progressRef = useRef(onProgress);
  progressRef.current = onProgress;

  // Bumped to re-run the probe — the "check again" remedy, and after a
  // postage change settles.
  const [probe, setProbe] = useState(0);
  const recheck = useCallback(() => setProbe((n) => n + 1), []);

  // A provider, when the browser injects one, replaces the node-URL path
  // entirely: it owns postage and node lifecycle, and reports both through
  // one capability call.
  const providerTransport = useMemo(
    () => (hasProvider() ? detectSwarmTransport({ beeUrl: beeUrl ?? '' }) : null),
    [],
  );
  const [providerStatus, setProviderStatus] =
    useState<SwarmTransportStatus | null>(null);

  useEffect(() => {
    if (!providerTransport) return;
    let cancelled = false;
    const poll = async () => {
      const status = await providerTransport.status();
      if (cancelled) return;
      setProviderStatus(status);
      setNodeState(
        status.canWrite
          ? { kind: 'ready', batchId: 'provider-managed' }
          : {
              kind: 'read-only',
              reason: status.reason ?? 'provider cannot publish',
            },
      );
    };
    poll();
    const id = setInterval(poll, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [providerTransport, probe]);

  /** Ask the browser for publishing consent (the `grant-access` remedy). */
  const grantAccess = useCallback(async () => {
    if (!providerTransport) return;
    await providerTransport.connect();
    setProbe((n) => n + 1);
  }, [providerTransport]);

  useEffect(() => {
    if (!beeUrl || providerTransport) return;
    let cancelled = false;
    (async () => {
      // 1. Is the node reachable at all? (cheap, local to the node)
      try {
        await swarmFetch({ beeUrl }, '/health', { timeoutMs: 10_000 });
      } catch (error) {
        if (cancelled) return;
        const reason = (error as Error).message;
        console.warn(`Swarm: Bee node not reachable at ${beeUrl}`, error);
        setNodeState({ kind: 'unreachable', reason });
        return;
      }
      if (cancelled) return;

      // 2. A postage batch is needed only for writing. Without one the
      //    document still opens — read-only.
      try {
        const batchId =
          pinnedBatch ??
          (await listStamps({ beeUrl })).find((s) => s.usable)?.batchID;
        if (cancelled) return;
        if (!batchId) {
          console.info(
            `Swarm: no usable postage batch on ${beeUrl} — read-only ` +
              `(buy a batch to save; reading never needs one)`,
          );
          setNodeState({
            kind: 'read-only',
            reason: 'This Bee node has no usable postage batch',
          });
          return;
        }
        console.info(
          `Swarm: storing sheets via ${beeUrl} (batch ${batchId.slice(0, 8)}…)`,
        );
        setNodeState({ kind: 'ready', batchId });
      } catch (error) {
        if (cancelled) return;
        console.warn('Swarm: postage batch lookup failed', error);
        setNodeState({
          kind: 'read-only',
          reason: (error as Error).message,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [probe, providerTransport]);

  // Declared before the health ping that maintains it (hoisted state).
  const [nodeReachable, setNodeReachable] = useState(true);
  // Writing needs both a batch and a node that is actually answering: a
  // node that stops mid-session must hold content back, not fail saves.
  // Through a provider, a document opened from someone else's link cannot
  // be written: the browser signs only as itself. Declared before canWrite,
  // which reads it during render.
  const [documentWritable, setDocumentWritable] = useState(true);
  const canWrite =
    (providerTransport
      ? Boolean(providerStatus?.canWrite)
      : nodeState.kind === 'ready' && nodeReachable) && documentWritable;
  const batchId = nodeState.kind === 'ready' ? nodeState.batchId : undefined;
  /** Usable for reads as soon as the node answers, batch or not. */
  const nodeUsable = nodeState.kind === 'ready' || nodeState.kind === 'read-only';

  const storageConfig: SwarmStoreConfig | null = useMemo(() => {
    if (providerTransport) {
      return nodeUsable
        ? { beeUrl: beeUrl ?? '', onProgress, transport: providerTransport }
        : null;
    }
    return beeUrl && nodeUsable
      ? // Synchronous uploads: a snapshot (and its feed pointer) must reach
        // the network before the save counts, or a viewer's own node — a
        // Swarm-aware browser reads through one — cannot find the sheet
        // that this node happily serves locally. Found in the field: the
        // sample sheet opened in Brave (same node) and blank in Freedom
        // (own node) because its chunks had never been pushed.
        { beeUrl, postageBatchId: batchId, onProgress, deferredUpload: false }
      : null;
  }, [nodeUsable, batchId, onProgress, providerTransport]);

  // Read once, at mount, before resolveKeys writes anything: afterwards the
  // address bar carries a key either way, and the two are indistinguishable.
  // A key remembered from an earlier visit counts too — the fragment may
  // have been dropped on the way here (Freedom's cold-start error page).
  const [documentHasOwnKey] = useState(
    () =>
      Boolean(readHashKeys()?.owner) ||
      Boolean(localStorage.getItem(sheetOwnerKeyStorageKey(docId))),
  );

  const docStorage: SwarmDocumentStorage | null = useMemo(() => {
    if (!storageConfig) return null;
    // A link that carries an owner key names the document's feed, and that
    // is what must be read from — including through a provider, which signs
    // as itself and would otherwise look the document up under the browser's
    // own identity and find nothing. Without such a link, let the provider
    // own the documents this browser creates, so they stay writable.
    const keys = resolveKeys(
      docId,
      generatePrivateKey,
      generateDocumentKey,
      Boolean(providerTransport) && !documentHasOwnKey,
    );
    const ownerPrivateKey = keys.owner as `0x${string}` | undefined;
    return createSwarmDocumentStorage({
      ...storageConfig,
      // Fixed: sheets already saved on Swarm live under `dsheet/v1/<id>`.
      namespace: 'dsheet',
      ownerPrivateKey,
      documentKey: keys.doc,
      transport: storageConfig.transport,
    });
  }, [storageConfig, docId, providerTransport, documentHasOwnKey]);

  /**
   * Called when a save is refused because the document belongs to another
   * identity. Deliberately not checked up front: asking a provider who it
   * signs as requires the feed-permission grant, and prompting for write
   * access merely to *read* a shared document is the wrong trade.
   */
  const markDocumentReadOnly = useCallback(
    () => setDocumentWritable(false),
    [],
  );

  // Conditions are only as fresh as their inputs: the browser can go
  // offline and the node can stop after the initial probe, so both are
  // watched for as long as the document is open.
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  useEffect(() => {
    if (!beeUrl || providerTransport || nodeState.kind === 'connecting') return;
    let cancelled = false;
    const ping = async () => {
      try {
        await swarmFetch({ beeUrl }, '/health', { timeoutMs: 5_000 });
        if (!cancelled) setNodeReachable(true);
      } catch {
        if (!cancelled) setNodeReachable(false);
      }
    };
    ping();
    const id = setInterval(ping, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [nodeState.kind, probe, providerTransport]);

  // Stamp health follows whichever batch is in use, including one bought
  // mid-session.
  useEffect(() => {
    if (!beeUrl || !batchId || providerTransport) return;
    let cancelled = false;
    checkStampHealth({ beeUrl }, batchId)
      .then((health) => !cancelled && setStampHealth(health))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [batchId, providerTransport]);

  return {
    docStorage,
    stampHealth,
    nodeState,
    canWrite,
    progress,
    adoptBatch,
    beeUrl,
    batchId,
    /** Inputs for `diagnoseSwarm`, kept current while the document is open. */
    diagnosticsInput: {
      online,
      nodeReachable: providerTransport
        ? true
        : nodeReachable && nodeState.kind !== 'unreachable',
      stamp: stampHealth,
      hasBatch: Boolean(batchId),
      localFallback: 'browser' as const,
      provider: providerStatus
        ? { canWrite: providerStatus.canWrite, reason: providerStatus.reason }
        : undefined,
    },
    recheck,
    grantAccess,
    markDocumentReadOnly,
    documentHasOwnKey,
    /** True when the browser, not this app, manages postage. */
    managesPostage: Boolean(providerTransport),
  };
};
