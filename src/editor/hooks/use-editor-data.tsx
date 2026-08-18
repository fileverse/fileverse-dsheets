/* eslint-disable @typescript-eslint/ban-ts-comment */
import { useState, useRef, useCallback, useEffect } from 'react';
import { Sheet } from '@sheet-engine/react';
import { WorkbookInstance } from '@sheet-engine/react';
import { toUint8Array } from 'js-base64';
import isEqual from 'lodash/isEqual';
import * as Y from 'yjs';
import { useLiveQuery } from './live-query/use-live-query';
import type { ApiKeyStorage } from '../utils/api-key-storage';
import type { OpenApiKeyModalFn } from '../utils/data-block-error-handler';
import type { DataBlockEvent } from '../types';
import { ySheetArrayToPlain } from '../utils/update-ydoc';
import { migrateSheetArrayIfNeeded } from '../utils/migrate-new-yjs';
import { applyCommentMarkers } from '../utils/apply-comment-markers';
import { applyYdocCommentAnchors, getCommentAnchorsYMap } from '../utils/comment-anchors-ydoc';
import {
  beginRemoteApply,
  endRemoteApplyAfterPaint,
  runUnderRemoteApply,
} from '../utils/remote-apply-guard';
import { resolveSheetArrayShareKey } from '../utils/defined-names-ydoc';

/**
 * Hook for managing sheet data
 * Handles initialization, updates, and persistence of sheet data
 */

export const useEditorData = (
  ydocRef: React.MutableRefObject<Y.Doc | null>,
  dsheetId: string,
  sheetEditorRef: React.MutableRefObject<WorkbookInstance | null>,
  setForceSheetRender?: React.Dispatch<React.SetStateAction<number>>,
  portalContent?: string,
  isReadOnly = false,
  onChange?: (data: Sheet[]) => void,
  syncStatus?: 'initializing' | 'syncing' | 'synced' | 'error',
  commentData?: object,
  // @ts-ignore
  dataBlockCalcFunction?: { [key: string]: { [key: string]: any } },
  setDataBlockCalcFunction?: React.Dispatch<
    React.SetStateAction<{ [key: string]: { [key: string]: any } }>
  >,
  enableLiveQuery = false,
  liveQueryRefreshRate?: number,
  apiKeyStorage?: ApiKeyStorage,
  openApiKeyModal?: OpenApiKeyModalFn,
  onDataBlockEvent?: (event: DataBlockEvent) => void,
  allowComments?: boolean,
  hasCollabContentInitialised?: boolean,
  collabEnabled = false,
) => {
  const [sheetData, setSheetData] = useState<Sheet[]>([]);
  const [isDataLoaded, setIsDataLoaded] = useState<boolean>(false);
  const currentDataRef = useRef<Sheet[]>([]);
  const remoteUpdateRef = useRef<boolean>(false);
  const remoteApplyDepthRef = useRef<number>(0);
  const remoteApplyGuardRefs = useRef({
    remoteApplyDepthRef,
    remoteUpdateRef,
  }).current;
  const dataInitialized = useRef<boolean>(false);
  const isUpdatingRef = useRef<boolean>(false);
  const debounceTimerRef = useRef<number | null>(null);
  /** While true, skip surgical applies — workbook is stale vs incoming Yjs sheet ids. */
  const structuralRemountPendingRef = useRef<boolean>(false);
  /** True once portalContent has been applied; reset when `dsheetId` changes. */
  const portalContentAppliedRef = useRef<boolean>(false);

  useEffect(() => {
    portalContentAppliedRef.current = false;
  }, [dsheetId]);

  const commentDataRef = useRef<object | undefined>(commentData);
  const allowCommentsRef = useRef<boolean | undefined>(allowComments);
  useEffect(() => {
    commentDataRef.current = commentData;
  }, [commentData]);
  useEffect(() => {
    allowCommentsRef.current = allowComments;
  }, [allowComments]);

  const commentsForMarkers = useCallback(
    (data?: object | null) =>
      applyYdocCommentAnchors(
        data ?? commentDataRef.current,
        ydocRef.current,
        dsheetId,
      ),
    [dsheetId, ydocRef],
  );

  const restampCommentMarkers = useCallback((): boolean => {
    const anchored = commentsForMarkers();
    const allow = allowCommentsRef.current;
    const skipEmpty = !anchored || Object.keys(anchored).length === 0;
    const setContext = sheetEditorRef?.current?.getWorkbookSetContext?.();
    const appliedLive = typeof setContext === 'function';
    if (skipEmpty) return appliedLive;
    if (!appliedLive) return false;
    // Overlay only: mutate `ps` on the live Immer draft. Never replace
    // luckysheetfile / currentDataRef or remount — that rewrites cell data
    // after row/column drag and duplicates or drops values.
    setContext((ctx: any) => {
      if (ctx?.luckysheetfile) {
        applyCommentMarkers(ctx.luckysheetfile, anchored, allow);
      }
    });
    return true;
  }, [commentsForMarkers, sheetEditorRef]);

  const { handleLiveQuery, initialiseLiveQueryData } = useLiveQuery(
    sheetEditorRef,
    apiKeyStorage,
    openApiKeyModal,
    onDataBlockEvent,
    enableLiveQuery,
    liveQueryRefreshRate,
  );

  const syncDataBlockCalcFromPlain = useCallback(
    (plain: Sheet[]) => {
      if (!setDataBlockCalcFunction) return;
      const dataBlockList: { [key: string]: any } = {};
      plain.forEach((sheet: Sheet) => {
        if (sheet?.id && sheet?.dataBlockCalcFunction) {
          dataBlockList[sheet.id] = { ...sheet.dataBlockCalcFunction };
        }
      });
      setDataBlockCalcFunction(dataBlockList);
    },
    [setDataBlockCalcFunction],
  );

  // Apply portal content once on first load. Skipped entirely when RTC collaboration
  // is active — SyncManager.syncLatestCommit is the sole source of truth in that case,
  // matching the behaviour of initialContent in fileverse-ddoc.
  useEffect(() => {
    if (collabEnabled) return;
    if (!portalContent?.length || !ydocRef.current) return;
    if (portalContentAppliedRef.current) return;

    try {
      const incoming = toUint8Array(portalContent);
      const ydoc = ydocRef.current;

      // Bring `ydoc` toward the target state without re-applying shared history twice.
      // Parent may send a merged update blob; diffing vs current SV is correct for IDB-hydrated ydocs too.
      const sv = Y.encodeStateVector(ydoc);
      const targetDoc = new Y.Doc();
      Y.applyUpdate(targetDoc, incoming);
      const delta = Y.encodeStateAsUpdate(targetDoc, sv);
      targetDoc.destroy();

      if (delta.byteLength > 0) {
        Y.applyUpdate(ydoc, delta);
      }

      const tempDoc = new Y.Doc();
      Y.applyUpdate(tempDoc, incoming);

      const internalDsheetId =
        resolveSheetArrayShareKey(tempDoc, dsheetId) ??
        resolveSheetArrayShareKey(ydoc) ??
        dsheetId;
      // Use main ydoc's sheet array so migration persists; migrating tempDoc's
      // array left the main doc unmigrated and caused "t.forEach is not a function"
      // when the library read plain-object sheet items.
      const sheetArray = ydocRef.current.getArray(internalDsheetId);

      // Migrate legacy sheet array to Y.Map-based structure if needed
      migrateSheetArrayIfNeeded(ydocRef.current, sheetArray);

      // Convert Yjs sheet array to plain snapshot for Fortune spreadsheet
      const newSheetData = ySheetArrayToPlain(
        // @ts-ignore
        sheetArray as Y.Array<Y.Map>,
      );

      const portalAnchored = commentsForMarkers();
      applyCommentMarkers(
        newSheetData,
        portalAnchored,
        allowCommentsRef.current,
      );
      currentDataRef.current = newSheetData;
      initialiseLiveQueryData(newSheetData);

      portalContentAppliedRef.current = true;

      if (setForceSheetRender) {
        setForceSheetRender((prev) => prev + 1);
      }

      const dataBlockList: { [key: string]: any } = {};
      newSheetData.forEach((sheet: Sheet) => {
        if (sheet?.id && sheet?.dataBlockCalcFunction) {
          dataBlockList[sheet.id] = {
            ...sheet.dataBlockCalcFunction,
          };
        }
      });
      //@ts-ignore
      setDataBlockCalcFunction?.(dataBlockList);

      tempDoc.destroy();
    } catch (error) {
      console.error('[DSheet] Error processing portal content:', error);
    }
  }, [portalContent, collabEnabled, dsheetId, ydocRef, setForceSheetRender, initialiseLiveQueryData, setDataBlockCalcFunction]);

  // Stamp markers onto the live workbook. Comments often arrive before the
  // sheet engine has mounted, so retry until getWorkbookSetContext exists.
  useEffect(() => {
    if (!dsheetId) return undefined;
    try {
      if (restampCommentMarkers()) return undefined;
      const hasComments =
        !!commentData && Object.keys(commentData as object).length > 0;
      if (!hasComments || !currentDataRef.current?.length) return undefined;
      setForceSheetRender?.((prev) => prev + 1);
      let tries = 0;
      const id = window.setInterval(() => {
        tries += 1;
        if (restampCommentMarkers() || tries > 40) {
          window.clearInterval(id);
        }
      }, 100);
      return () => window.clearInterval(id);
    } catch (error) {
      console.error('[DSheet] Error processing comment data:', error);
      return undefined;
    }
  }, [
    restampCommentMarkers,
    commentData,
    dsheetId,
    isDataLoaded,
    portalContent,
    allowComments,
    syncStatus,
    setForceSheetRender,
  ]);

  // Re-stamp markers when published comment anchors land in ydoc (viewer load).
  useEffect(() => {
    const ydoc = ydocRef.current;
    if (!ydoc || !dsheetId) return undefined;
    const map = getCommentAnchorsYMap(ydoc, dsheetId);
    const restamp = () => {
      restampCommentMarkers();
    };
    map.observe(restamp);
    restamp();
    return () => {
      map.unobserve(restamp);
    };
  }, [restampCommentMarkers, dsheetId, ydocRef, syncStatus, portalContent]);

  // Initialize sheet data once Socket.IO collab sync reaches 'ready' for the first time.
  // The ydoc already contains the merged server state at this point.
  useEffect(() => {
    if (!hasCollabContentInitialised || !ydocRef.current || !dsheetId) {
      return;
    }
    if (dataInitialized.current) return;

    try {
      console.log('[RTC] use-editor-data: reading ydoc.getArray(dsheetId)', {
        dsheetId,
        allShareKeys: Array.from(ydocRef.current.share.keys()),
      });
      const sheetArray = ydocRef.current.getArray(dsheetId);
      console.log('[RTC] use-editor-data: sheetArray length BEFORE migrate', {
        length: sheetArray.length,
      });
      migrateSheetArrayIfNeeded(ydocRef.current, sheetArray);
      console.log('[RTC] use-editor-data: sheetArray length AFTER migrate', {
        length: sheetArray.length,
      });

      // @ts-ignore
      const plain = ySheetArrayToPlain(sheetArray as Y.Array<Y.Map>);
      applyCommentMarkers(
        plain,
        commentsForMarkers(),
        allowCommentsRef.current,
      );
      currentDataRef.current = plain;
      initialiseLiveQueryData(plain);

      const dataBlockList: { [key: string]: any } = {};
      plain.forEach((sheet: Sheet) => {
        if (sheet?.id && sheet?.dataBlockCalcFunction) {
          dataBlockList[sheet.id] = { ...sheet.dataBlockCalcFunction };
        }
      });
      // @ts-ignore
      setDataBlockCalcFunction?.(dataBlockList);

      dataInitialized.current = true;
      setIsDataLoaded(true);
      console.log(
        '[RTC] use-editor-data: collab sheet data initialised, setIsDataLoaded(true)',
        {
          sheetCount: plain.length,
        },
      );

      if (setForceSheetRender) {
        setForceSheetRender((prev) => prev + 1);
      }
    } catch (error) {
      console.error('[DSheet] Error initialising collab sheet data:', error);
    }
  }, [hasCollabContentInitialised]);

  // Initialize sheet data AFTER sync is complete - BUT ONLY IF NOT IN READ-ONLY MODE or if we have no data yet
  useEffect(() => {
    if (!ydocRef.current || !dsheetId) {
      return;
    }

    // Only proceed with initialization if we've synced
    if (syncStatus === 'synced') {
      const initializeWithDefaultData = () => {
        // If we've already initialized (either here or via portal content), don't do it again
        if (dataInitialized.current) {
          return;
        }

        // RTC session: collabInit hydrates currentDataRef after sync — don't claim init here.
        if (collabEnabled) {
          return;
        }

        const sheetArray = ydocRef.current?.getArray(dsheetId);
        const currentData = Array.from(sheetArray || []) as Sheet[];
        initialiseLiveQueryData(currentData);

        dataInitialized.current = true;
        setIsDataLoaded(true);
      };

      initializeWithDefaultData();
    }
  }, [dsheetId, isReadOnly, syncStatus, collabEnabled]);

  // Attach listener for YJS data changes
  useEffect(() => {
    if (!ydocRef.current || !dsheetId) return;
    const sheetArray = ydocRef.current.getArray(dsheetId);

    // How many cell changes to handle surgically before falling back to a full remount.
    // Large batches (paste, import, formula recalc) are cheaper as a single remount
    // than N individual setContext calls.
    const SURGICAL_CELL_LIMIT = 50;

    /** Top-level sheet Y.Map fields that can be applied without a Workbook remount. */
    const SURGICAL_SHEET_META_KEYS = new Set([
      'name',
      'order',
      'status',
      'color',
      'hide',
      'showGridLines',
    ]);

    /**
     * Overlay sheet fields (DOM overlays, not canvas) that can be applied
     * imperatively without a remount via setSheetImages / setSheetIframes.
     * A remote move/resize of an image or iframe only touches these.
     */
    const SURGICAL_OVERLAY_KEYS = new Set(['images', 'iframes']);

    /**
     * Map-backed sheet fields applied imperatively via WorkbookInstance helpers.
     */
    const SURGICAL_MAP_FIELD_KEYS = new Set([
      'dataVerification',
      'filter_select',
      'hyperlink',
      'conditionRules',
    ]);

    /** Whole-object sheet fields with imperative remote apply. */
    const SURGICAL_OBJECT_FIELD_KEYS = new Set(['filter']);

    /**
     * Object sheet fields that drive layout and require a remount when they
     * genuinely change, but are rebuilt as fresh references on every remount.
     * A remote change to one of these is only "real" if its value differs from
     * the live workbook value — otherwise it is a redundant echo (see the
     * cross-peer config remount ping-pong) and must NOT trigger another remount.
     */
    const LAYOUT_OBJECT_KEYS = new Set(['frozen']);

    /** True only when a sheet tab is inserted/removed on the top-level Y.Array. */
    const isSheetTabArrayChange = (event: Y.YEvent<any>): boolean => {
      const path = event.path;
      if (path.length !== 1 || typeof path[0] !== 'number') return false;
      if (!(event.target instanceof Y.Array)) return false;
      try {
        return event.delta.some(
          (op) => op.insert !== undefined || op.delete !== undefined,
        );
      } catch {
        return false;
      }
    };

    // Update local state when YJS data changes.
    // observeDeep (not observe) is required so that nested Y.Map mutations —
    // e.g. celldata.set('0_0', value) inside a sheet Y.Map — also trigger a
    // re-render. observe only fires for top-level array insertions/deletions
    // (tab add/remove) and would silently miss all remote cell edits.
    const observerCallback = (
      events: Y.YEvent<any>[],
      transaction: Y.Transaction,
    ) => {
      // Only react to remote Yjs updates. Local edits are already reflected in Workbook state,
      // and rebuilding a full plain snapshot on every local transaction is expensive.
      if (transaction.local || isUpdatingRef.current) return;

      // --- Classify events: cell-only vs structural ---
      type CellBatch = {
        sheetId: string;
        celldataMap: Y.Map<any>;
        changedKeys: Map<string, { action: string }>;
      };
      type DataVerificationBatch = {
        sheetId: string;
        dvMap: Y.Map<any>;
      };
      type FilterBatch = {
        sheetId: string;
        sheetMap: Y.Map<any>;
      };
      type MapFieldBatch = {
        sheetId: string;
        field: string;
        map: Y.Map<any>;
        changedKeys: Map<string, { action: string }>;
      };
      type ConfigSubKeyBatch = {
        sheetId: string;
        configMap: Y.Map<any>;
        changedKeys: Map<string, { action: string }>;
      };
      type ConditionFormatBatch = {
        sheetId: string;
        rules: any[];
      };
      const cellBatches: CellBatch[] = [];
      const dataVerificationUpdates = new Map<string, DataVerificationBatch>();
      const filterUpdates = new Map<string, FilterBatch>();
      const mapFieldUpdates = new Map<string, MapFieldBatch>();
      const configUpdates = new Map<string, ConfigSubKeyBatch>();
      const conditionFormatUpdates = new Map<string, ConditionFormatBatch>();
      const sheetMetaUpdates = new Map<
        string,
        { sheetId: string; sheetMap: Y.Map<any>; changedKeys: string[] }
      >();
      const overlayUpdates = new Map<
        string,
        { sheetId: string; sheetMap: Y.Map<any>; changedKeys: Set<string> }
      >();
      const indexOnlyEvents: Y.YEvent<any>[] = [];
      let hasStructural = false;
      const sheetsArr = sheetArray.toArray();

      const mergeYMapChangedKeys = (
        existing: Map<string, { action: string }> | undefined,
        event: Y.YMapEvent<any>,
      ) => {
        const merged = existing ?? new Map<string, { action: string }>();
        event.changes.keys.forEach((change, key) => {
          merged.set(key, change);
        });
        return merged;
      };

      const upsertMapFieldBatch = (
        batchKey: string,
        batch: Omit<MapFieldBatch, 'changedKeys'>,
        event: Y.YMapEvent<any>,
      ) => {
        const existing = mapFieldUpdates.get(batchKey);
        mapFieldUpdates.set(batchKey, {
          ...batch,
          changedKeys: mergeYMapChangedKeys(existing?.changedKeys, event),
        });
      };

      const upsertConfigBatch = (
        sheetId: string,
        configMap: Y.Map<any>,
        event: Y.YMapEvent<any>,
      ) => {
        const existing = configUpdates.get(sheetId);
        configUpdates.set(sheetId, {
          sheetId,
          configMap,
          changedKeys: mergeYMapChangedKeys(existing?.changedKeys, event),
        });
      };

      for (const event of events) {
        const path = event.path;
        // path = [sheetArrayIndex, 'celldata'] for a Y.Map cell change
        if (
          path.length === 2 &&
          path[1] === 'celldata' &&
          typeof path[0] === 'number'
        ) {
          const sheetMap = sheetsArr[path[0] as number];
          if (!(sheetMap instanceof Y.Map)) {
            hasStructural = true;
            continue;
          }
          const sheetId = sheetMap.get('id') as string;
          const celldataMap = sheetMap.get('celldata');
          if (!(celldataMap instanceof Y.Map)) {
            hasStructural = true;
            continue;
          }
          cellBatches.push({
            sheetId,
            celldataMap,
            changedKeys: (event as Y.YMapEvent<any>).changes.keys,
          });
        } else if (
          path.length === 2 &&
          path[1] === 'dataVerification' &&
          typeof path[0] === 'number'
        ) {
          const sheetMap = sheetsArr[path[0] as number];
          if (!(sheetMap instanceof Y.Map)) {
            hasStructural = true;
            continue;
          }
          const sheetId = sheetMap.get('id') as string;
          const dvMap = sheetMap.get('dataVerification');
          if (!sheetId || !(dvMap instanceof Y.Map)) {
            hasStructural = true;
            continue;
          }
          dataVerificationUpdates.set(sheetId, { sheetId, dvMap });
        } else if (
          path.length === 2 &&
          path[1] === 'filter_select' &&
          typeof path[0] === 'number'
        ) {
          const sheetMap = sheetsArr[path[0] as number];
          if (!(sheetMap instanceof Y.Map)) {
            hasStructural = true;
            continue;
          }
          const sheetId = sheetMap.get('id') as string;
          if (!sheetId) {
            hasStructural = true;
            continue;
          }
          filterUpdates.set(sheetId, { sheetId, sheetMap });
        } else if (
          path.length === 2 &&
          path[1] === 'filter' &&
          typeof path[0] === 'number'
        ) {
          const sheetMap = sheetsArr[path[0] as number];
          if (!(sheetMap instanceof Y.Map)) {
            hasStructural = true;
            continue;
          }
          const sheetId = sheetMap.get('id') as string;
          if (!sheetId) {
            hasStructural = true;
            continue;
          }
          filterUpdates.set(sheetId, { sheetId, sheetMap });
        } else if (
          path.length === 2 &&
          path[1] === 'config' &&
          typeof path[0] === 'number'
        ) {
          const sheetMap = sheetsArr[path[0] as number];
          if (!(sheetMap instanceof Y.Map)) {
            hasStructural = true;
            continue;
          }
          const sheetId = sheetMap.get('id') as string;
          const configMap = sheetMap.get('config');
          if (!sheetId || !(configMap instanceof Y.Map)) {
            hasStructural = true;
            continue;
          }
          upsertConfigBatch(sheetId, configMap, event as Y.YMapEvent<any>);
        } else if (
          path.length === 2 &&
          (path[1] === 'hyperlink' || path[1] === 'conditionRules') &&
          typeof path[0] === 'number'
        ) {
          const sheetMap = sheetsArr[path[0] as number];
          if (!(sheetMap instanceof Y.Map)) {
            hasStructural = true;
            continue;
          }
          const sheetId = sheetMap.get('id') as string;
          const field = path[1] as string;
          const fieldMap = sheetMap.get(field);
          if (!sheetId || !(fieldMap instanceof Y.Map)) {
            hasStructural = true;
            continue;
          }
          upsertMapFieldBatch(
            `${sheetId}:${field}`,
            { sheetId, field, map: fieldMap },
            event as Y.YMapEvent<any>,
          );
        } else if (
          path.length === 2 &&
          path[1] === 'luckysheet_conditionformat_save' &&
          typeof path[0] === 'number'
        ) {
          const sheetMap = sheetsArr[path[0] as number];
          if (!(sheetMap instanceof Y.Map)) {
            hasStructural = true;
            continue;
          }
          const sheetId = sheetMap.get('id') as string;
          const rulesArr = sheetMap.get('luckysheet_conditionformat_save');
          if (!sheetId || !(rulesArr instanceof Y.Array)) {
            hasStructural = true;
            continue;
          }
          conditionFormatUpdates.set(sheetId, {
            sheetId,
            rules: rulesArr.toJSON(),
          });
        } else if (
          path.length === 2 &&
          typeof path[0] === 'number' &&
          typeof path[1] === 'string' &&
          SURGICAL_SHEET_META_KEYS.has(path[1])
        ) {
          const sheetMap = sheetsArr[path[0] as number];
          if (!(sheetMap instanceof Y.Map)) {
            hasStructural = true;
            continue;
          }
          const sheetId = sheetMap.get('id') as string;
          if (!sheetId) {
            hasStructural = true;
            continue;
          }
          sheetMetaUpdates.set(sheetId, {
            sheetId,
            sheetMap,
            changedKeys: [path[1] as string],
          });
        } else if (isSheetTabArrayChange(event)) {
          hasStructural = true;
        } else if (path.length === 1 && typeof path[0] === 'number') {
          const sheetMap = sheetsArr[path[0] as number];
          if (sheetMap instanceof Y.Map) {
            const changedKeys = Array.from(
              (event as Y.YMapEvent<any>).keys.keys(),
            );
            if (
              changedKeys.length > 0 &&
              changedKeys.every(
                (k) =>
                  SURGICAL_SHEET_META_KEYS.has(k) ||
                  SURGICAL_OVERLAY_KEYS.has(k) ||
                  SURGICAL_MAP_FIELD_KEYS.has(k) ||
                  SURGICAL_OBJECT_FIELD_KEYS.has(k) ||
                  k === 'luckysheet_conditionformat_save' ||
                  k === 'config',
              )
            ) {
              // color/hide have no imperative WorkbookInstance API — must remount.
              if (changedKeys.some((k) => k === 'color' || k === 'hide')) {
                hasStructural = true;
                continue;
              }
              const sheetId = sheetMap.get('id') as string;
              if (sheetId) {
                const metaKeys = changedKeys.filter((k) =>
                  SURGICAL_SHEET_META_KEYS.has(k),
                );
                const overlayKeys = changedKeys.filter((k) =>
                  SURGICAL_OVERLAY_KEYS.has(k),
                );
                const mapFieldKeys = changedKeys.filter(
                  (k) =>
                    SURGICAL_MAP_FIELD_KEYS.has(k) ||
                    SURGICAL_OBJECT_FIELD_KEYS.has(k),
                );
                if (metaKeys.length > 0) {
                  const existing = sheetMetaUpdates.get(sheetId);
                  sheetMetaUpdates.set(sheetId, {
                    sheetId,
                    sheetMap,
                    changedKeys: existing
                      ? [...existing.changedKeys, ...metaKeys]
                      : metaKeys,
                  });
                }
                if (overlayKeys.length > 0) {
                  const existing = overlayUpdates.get(sheetId);
                  const keys = existing?.changedKeys ?? new Set<string>();
                  overlayKeys.forEach((k) => keys.add(k));
                  overlayUpdates.set(sheetId, {
                    sheetId,
                    sheetMap,
                    changedKeys: keys,
                  });
                }
                if (mapFieldKeys.includes('dataVerification')) {
                  const dvMap = sheetMap.get('dataVerification');
                  if (dvMap instanceof Y.Map) {
                    dataVerificationUpdates.set(sheetId, { sheetId, dvMap });
                  }
                }
                if (
                  mapFieldKeys.some((k) => SURGICAL_OBJECT_FIELD_KEYS.has(k)) ||
                  mapFieldKeys.includes('filter_select')
                ) {
                  filterUpdates.set(sheetId, { sheetId, sheetMap });
                }
                mapFieldKeys
                  .filter((k) => k === 'hyperlink' || k === 'conditionRules')
                  .forEach((field) => {
                    const fieldMap = sheetMap.get(field);
                    if (fieldMap instanceof Y.Map) {
                      upsertMapFieldBatch(
                        `${sheetId}:${field}`,
                        { sheetId, field, map: fieldMap },
                        event as Y.YMapEvent<any>,
                      );
                    }
                  });
                if (changedKeys.includes('config')) {
                  const configMap = sheetMap.get('config');
                  if (configMap instanceof Y.Map) {
                    const merged = new Map<string, { action: string }>();
                    configMap.forEach((_v, k) =>
                      merged.set(k, { action: 'update' }),
                    );
                    configUpdates.set(sheetId, {
                      sheetId,
                      configMap,
                      changedKeys: merged,
                    });
                  } else {
                    hasStructural = true;
                  }
                }
                if (changedKeys.includes('luckysheet_conditionformat_save')) {
                  const rulesArr = sheetMap.get(
                    'luckysheet_conditionformat_save',
                  );
                  if (rulesArr instanceof Y.Array) {
                    conditionFormatUpdates.set(sheetId, {
                      sheetId,
                      rules: rulesArr.toJSON(),
                    });
                  }
                }
                continue;
              }
            }

            // Fix B: frozen-only remote change remounts only when value differs.
            if (
              changedKeys.length > 0 &&
              changedKeys.every((k) => LAYOUT_OBJECT_KEYS.has(k))
            ) {
              const sheetId = sheetMap.get('id') as string;
              const wbSheet = sheetEditorRef.current
                ?.getWorkbookContext?.()
                ?.luckysheetfile?.find((s) => s.id === sheetId) as
                | Record<string, any>
                | undefined;
              if (wbSheet) {
                const allEqual = changedKeys.every((k) =>
                  isEqual(sheetMap.get(k), wbSheet[k]),
                );
                if (allEqual) {
                  // Redundant echo — ignore entirely (no remount).
                  continue;
                }
              }
              // Genuine layout change — fall through to a remount.
              hasStructural = true;
              continue;
            }
          }
          // Bubbling [sheetIndex] alongside nested celldata — resolved after the loop.
          indexOnlyEvents.push(event);
          continue;
        } else {
          hasStructural = true;
        }
      }

      for (const event of indexOnlyEvents) {
        if (
          cellBatches.length > 0 ||
          sheetMetaUpdates.size > 0 ||
          overlayUpdates.size > 0 ||
          dataVerificationUpdates.size > 0 ||
          filterUpdates.size > 0 ||
          mapFieldUpdates.size > 0 ||
          configUpdates.size > 0 ||
          conditionFormatUpdates.size > 0
        )
          continue;
        const changedKeys = Array.from((event as Y.YMapEvent<any>).keys.keys());
        if (changedKeys.length === 0) continue;
        hasStructural = true;
      }

      const totalCells = cellBatches.reduce(
        (n, b) => n + b.changedKeys.size,
        0,
      );

      const workbookSheetIds = new Set(
        sheetEditorRef.current
          ?.getWorkbookContext?.()
          ?.luckysheetfile?.map((s) => s.id)
          .filter(Boolean) ?? [],
      );
      const remoteSheetIds = [
        ...cellBatches.map((b) => b.sheetId),
        ...sheetMetaUpdates.keys(),
        ...overlayUpdates.keys(),
        ...dataVerificationUpdates.keys(),
        ...filterUpdates.keys(),
        ...Array.from(mapFieldUpdates.values()).map((b) => b.sheetId),
        ...configUpdates.keys(),
        ...conditionFormatUpdates.keys(),
      ];
      const hasUnknownSheet = remoteSheetIds.some(
        (id) => id && !workbookSheetIds.has(id),
      );

      const scheduleStructuralRemount = () => {
        structuralRemountPendingRef.current = true;
        beginRemoteApply(remoteApplyGuardRefs);
        if (debounceTimerRef.current !== null) {
          window.clearTimeout(debounceTimerRef.current);
        }
        debounceTimerRef.current = window.setTimeout(() => {
          const isEditingCell =
            (sheetEditorRef.current?.getWorkbookContext?.()
              ?.luckysheetCellUpdate?.length ?? 0) > 0;
          try {
            const plain = ySheetArrayToPlain(sheetArray as any);
            applyCommentMarkers(
              plain,
              commentsForMarkers(),
              allowCommentsRef.current,
            );
            currentDataRef.current = plain;
            syncDataBlockCalcFromPlain(plain);
          } catch (e) {
            console.error(
              '[DSheet] ySheetArrayToPlain after ydoc observe failed',
              e,
            );
          }
          if (!isEditingCell && setForceSheetRender) {
            setForceSheetRender((prev) => prev + 1);
          }
          structuralRemountPendingRef.current = false;
          debounceTimerRef.current = null;
          endRemoteApplyAfterPaint(remoteApplyGuardRefs);
        }, 50);
      };

      const needsStructuralRemount =
        hasStructural ||
        hasUnknownSheet ||
        structuralRemountPendingRef.current ||
        totalCells > SURGICAL_CELL_LIMIT ||
        !sheetEditorRef.current;

      const applyRemoteSheetMeta = () => {
        const orderList: Record<string, number> = {};
        let hasOrderChange = false;

        for (const {
          sheetId,
          sheetMap,
          changedKeys,
        } of sheetMetaUpdates.values()) {
          try {
            if (changedKeys.includes('name')) {
              const name = sheetMap.get('name');
              if (typeof name === 'string') {
                sheetEditorRef.current?.setSheetName?.(name, { id: sheetId });
              }
            }
            if (changedKeys.includes('order')) {
              const order = sheetMap.get('order');
              if (typeof order === 'number') {
                orderList[sheetId] = order;
                hasOrderChange = true;
              }
            }
          } catch (error) {
            console.warn(
              '[DSheet] Skipped remote sheet meta apply — workbook not ready',
              { sheetId, error },
            );
          }
        }

        if (hasOrderChange) {
          try {
            sheetEditorRef.current?.setSheetOrder?.(orderList);
          } catch (error) {
            console.warn(
              '[DSheet] Skipped remote sheet order apply — workbook not ready',
              error,
            );
          }
        }
      };

      // Apply remote image/iframe overlay changes imperatively (no remount).
      const applyRemoteOverlays = () => {
        for (const {
          sheetId,
          sheetMap,
          changedKeys,
        } of overlayUpdates.values()) {
          try {
            if (changedKeys.has('images')) {
              const images = sheetMap.get('images');
              sheetEditorRef.current?.setSheetImages?.(
                Array.isArray(images) ? images : [],
                { id: sheetId },
              );
            }
            if (changedKeys.has('iframes')) {
              const iframes = sheetMap.get('iframes');
              sheetEditorRef.current?.setSheetIframes?.(
                Array.isArray(iframes) ? iframes : [],
                { id: sheetId },
              );
            }
          } catch (error) {
            console.warn(
              '[DSheet] Skipped remote overlay apply — workbook not ready',
              { sheetId, error },
            );
          }
        }
      };

      const applyRemoteDataVerification = () => {
        for (const { sheetId, dvMap } of dataVerificationUpdates.values()) {
          try {
            sheetEditorRef.current?.setSheetDataVerification?.(dvMap.toJSON(), {
              id: sheetId,
            });
          } catch (error) {
            console.warn(
              '[DSheet] Skipped remote dataVerification apply — workbook not ready',
              { sheetId, error },
            );
          }
        }
      };

      const readFilterFromSheetMap = (sheetMap: Y.Map<any>) => {
        const filterVal = sheetMap.get('filter');
        if (filterVal instanceof Y.Map) {
          const json = filterVal.toJSON();
          return Object.keys(json).length > 0 ? json : undefined;
        }
        if (
          filterVal &&
          typeof filterVal === 'object' &&
          Object.keys(filterVal).length > 0
        ) {
          return filterVal as Record<string, any>;
        }
        return undefined;
      };

      const readFilterSelectFromSheetMap = (sheetMap: Y.Map<any>) => {
        const filterSelectVal = sheetMap.get('filter_select');
        if (filterSelectVal instanceof Y.Map) {
          return filterSelectVal.toJSON() as {
            row: number[];
            column: number[];
          };
        }
        return filterSelectVal as
          | { row: number[]; column: number[] }
          | undefined;
      };

      const applyRemoteFilters = () => {
        for (const { sheetId, sheetMap } of filterUpdates.values()) {
          try {
            sheetEditorRef.current?.setSheetFilterState?.(
              {
                filter: readFilterFromSheetMap(sheetMap),
                filter_select: readFilterSelectFromSheetMap(sheetMap),
              },
              { id: sheetId },
            );
          } catch (error) {
            console.warn(
              '[DSheet] Skipped remote filter apply — workbook not ready',
              { sheetId, error },
            );
          }
        }
      };

      const applyRemoteMapFields = () => {
        for (const {
          sheetId,
          field,
          map,
          changedKeys,
        } of mapFieldUpdates.values()) {
          try {
            const updates: Record<string, any> = {};
            const deleteKeys: string[] = [];
            changedKeys.forEach(({ action }, key) => {
              if (action === 'delete') {
                deleteKeys.push(key);
              } else {
                updates[key] = map.get(key);
              }
            });
            sheetEditorRef.current?.patchSheetMapField?.(
              field,
              updates,
              deleteKeys,
              { id: sheetId },
            );
          } catch (error) {
            console.warn(
              '[DSheet] Skipped remote map field apply — workbook not ready',
              { sheetId, field, error },
            );
          }
        }
      };

      const applyRemoteConfig = () => {
        for (const {
          sheetId,
          configMap,
          changedKeys,
        } of configUpdates.values()) {
          try {
            const partial: Record<string, any> = {};
            const deleteKeys: string[] = [];
            changedKeys.forEach(({ action }, key) => {
              if (action === 'delete') {
                deleteKeys.push(key);
              } else {
                partial[key] = configMap.get(key);
              }
            });
            sheetEditorRef.current?.setSheetConfigFields?.(partial, {
              id: sheetId,
              deleteKeys,
            });
          } catch (error) {
            console.warn(
              '[DSheet] Skipped remote config apply — workbook not ready',
              { sheetId, error },
            );
          }
        }
      };

      const applyRemoteConditionFormat = () => {
        for (const { sheetId, rules } of conditionFormatUpdates.values()) {
          try {
            sheetEditorRef.current?.setSheetConditionFormatRules?.(rules, {
              id: sheetId,
            });
          } catch (error) {
            console.warn(
              '[DSheet] Skipped remote condition format apply — workbook not ready',
              { sheetId, error },
            );
          }
        }
      };

      const syncPlainSnapshot = () => {
        try {
          const plain = ySheetArrayToPlain(sheetArray as any);
          applyCommentMarkers(
            plain,
            commentsForMarkers(),
            allowCommentsRef.current,
          );
          currentDataRef.current = plain;
        } catch (e) {
          console.error(
            '[DSheet] ySheetArrayToPlain after remote update failed',
            e,
          );
        }
      };

      const patchPlainCelldata = () => {
        const plain = currentDataRef.current;
        if (!plain?.length) {
          syncPlainSnapshot();
          return;
        }
        for (const { sheetId, celldataMap, changedKeys } of cellBatches) {
          const sheet = plain.find((s) => s.id === sheetId);
          if (!sheet) continue;
          // ySheetArrayToPlain normally yields an array, but currentDataRef can
          // briefly hold object-shaped / missing celldata after remounts.
          // Always bind a real array — `sheet.celldata.findIndex` on undefined
          // throws inside the Yjs observer and SyncManager drops the update.
          if (!Array.isArray(sheet.celldata)) {
            sheet.celldata = sheet.celldata
              ? (Object.values(
                  sheet.celldata as Record<string, unknown>,
                ) as NonNullable<Sheet['celldata']>)
              : [];
          }
          const celldata = sheet.celldata as NonNullable<Sheet['celldata']>;
          changedKeys.forEach(({ action }, key) => {
            const sep = key.lastIndexOf('_');
            const r = parseInt(key.slice(0, sep), 10);
            const c = parseInt(key.slice(sep + 1), 10);
            const idx = celldata.findIndex(
              (cell) => cell.r === r && cell.c === c,
            );
            if (action === 'delete') {
              if (idx >= 0) celldata.splice(idx, 1);
              return;
            }
            const cellObj = celldataMap.get(key);
            const entry = {
              r,
              c,
              v: (cellObj?.v ?? null) as NonNullable<
                Sheet['celldata']
              >[number]['v'],
            };
            if (idx >= 0) celldata[idx] = entry;
            else celldata.push(entry);
          });
        }
      };

      // --- Fall back to remount for structural changes or large cell batches ---
      // Keep throws inside the observer: Y.applyUpdate already committed the
      // update; an uncaught observer error makes SyncManager log "failed to
      // apply remote Yjs update, skipping" even though the doc was updated.
      try {
        if (needsStructuralRemount) {
          scheduleStructuralRemount();
          return;
        }

        runUnderRemoteApply(remoteApplyGuardRefs, () => {
          if (sheetMetaUpdates.size > 0) {
            applyRemoteSheetMeta();
          }
          if (overlayUpdates.size > 0) {
            applyRemoteOverlays();
          }
          if (dataVerificationUpdates.size > 0) {
            applyRemoteDataVerification();
          }
          if (filterUpdates.size > 0) {
            applyRemoteFilters();
          }
          if (mapFieldUpdates.size > 0) {
            applyRemoteMapFields();
          }
          if (conditionFormatUpdates.size > 0) {
            applyRemoteConditionFormat();
          }

          const cellFormatRangesTouched = Array.from(
            configUpdates.values(),
          ).some(({ changedKeys }) => changedKeys.has('cellFormatRanges'));

          if (
            totalCells === 0 &&
            (sheetMetaUpdates.size > 0 ||
              overlayUpdates.size > 0 ||
              dataVerificationUpdates.size > 0 ||
              filterUpdates.size > 0 ||
              mapFieldUpdates.size > 0 ||
              configUpdates.size > 0 ||
              conditionFormatUpdates.size > 0)
          ) {
            // Metadata-only: config rematerialize is fine with no cell deletes.
            if (configUpdates.size > 0) {
              applyRemoteConfig();
            }
            // currentDataRef must pick up new cellFormatRanges for later remounts.
            if (cellFormatRangesTouched) {
              syncPlainSnapshot();
            }
            return;
          }

          // Surgical path: apply cells BEFORE config.
          // A remote "clear styled cell" sends celldata delete + range migrate in
          // one txn. Config-first rematerializes style into dense data, then the
          // null cell wipe leaves an unstyled empty until remount. Cells-first
          // then rematerialize restores format-only empties correctly.
          for (const { sheetId, celldataMap, changedKeys } of cellBatches) {
            changedKeys.forEach(({ action }, key) => {
              const sep = key.lastIndexOf('_');
              const r = parseInt(key.slice(0, sep), 10);
              const c = parseInt(key.slice(sep + 1), 10);

              try {
                if (action === 'delete') {
                  sheetEditorRef.current?.applyRemoteCellValue(r, c, null, {
                    id: sheetId,
                  });
                } else {
                  const cellObj = celldataMap.get(key);
                  const remoteCell = cellObj?.v ?? null;
                  sheetEditorRef.current?.applyRemoteCellValue(
                    r,
                    c,
                    remoteCell,
                    {
                      id: sheetId,
                    },
                  );
                }
              } catch (error) {
                console.warn(
                  '[DSheet] Skipped remote cell apply — workbook not ready',
                  { sheetId, r, c, error },
                );
              }
            });
          }

          if (configUpdates.size > 0) {
            applyRemoteConfig();
          }

          if (totalCells > 0) {
            // Mixed cell+ranges txns: patchPlainCelldata alone leaves stale
            // cellFormatRanges on currentDataRef (resurrected on remount).
            if (cellFormatRangesTouched) {
              syncPlainSnapshot();
            } else {
              patchPlainCelldata();
            }
          }
        });
      } catch (error) {
        console.error(
          '[DSheet] remote ydoc observer apply failed (ydoc already updated)',
          error,
        );
      }
    };

    sheetArray.observeDeep(observerCallback);

    return () => {
      sheetArray.unobserveDeep(observerCallback);
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
      }
    };
  }, [
    ydocRef,
    dsheetId,
    setForceSheetRender,
    sheetEditorRef,
    syncDataBlockCalcFromPlain,
  ]);

  // Rebuild the full plain snapshot from the current Yjs doc and force a Workbook
  // remount. Used after a collab (RTC) sync completes, where surgical applies are
  // unsafe because the local workbook may be stale relative to the merged server
  // state. Returns true when a rebuild was performed.
  const rehydrateWorkbookFromYdoc = useCallback(
    (reason = 'host'): boolean => {
      if (!ydocRef.current || !dsheetId) return false;

      try {
        const sheetArray = ydocRef.current.getArray(dsheetId);
        migrateSheetArrayIfNeeded(ydocRef.current, sheetArray);

        // @ts-ignore
        const plain = ySheetArrayToPlain(sheetArray as Y.Array<Y.Map>);

        beginRemoteApply(remoteApplyGuardRefs);

        applyCommentMarkers(
          plain,
          commentsForMarkers(),
          allowCommentsRef.current,
        );
        currentDataRef.current = plain;
        syncDataBlockCalcFromPlain(plain);
        initialiseLiveQueryData(plain);

        dataInitialized.current = true;
        setIsDataLoaded(true);

        if (setForceSheetRender) {
          setForceSheetRender((prev) => prev + 1);
        }

        endRemoteApplyAfterPaint(remoteApplyGuardRefs);

        return true;
      } catch (error) {
        console.error(
          `[DSheet] rehydrateWorkbookFromYdoc failed (reason: ${reason})`,
          error,
        );
        return false;
      }
    },
    [
      ydocRef,
      dsheetId,
      syncDataBlockCalcFromPlain,
      initialiseLiveQueryData,
      setForceSheetRender,
    ],
  );

  // Handle changes to the sheet
  const handleChange = useCallback(
    (_data: Sheet[]) => {
      if (remoteUpdateRef.current) {
        return;
      }

      // Set the flag to indicate we're in the process of updating YJS
      isUpdatingRef.current = true;

      // Reset the flag after a short delay to allow the update to complete
      setTimeout(() => {
        isUpdatingRef.current = false;
      }, 50);
    },
    [dsheetId, onChange],
  );

  return {
    sheetData,
    setSheetData,
    currentDataRef,
    remoteUpdateRef,
    isDataLoaded,
    setIsDataLoaded,
    handleChange,
    handleLiveQuery,
    initialiseLiveQueryData,
    rehydrateWorkbookFromYdoc,
  };
};
