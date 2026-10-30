import { useEffect, Dispatch, SetStateAction } from 'react';
import { Sheet } from '@sheet-engine/react';
import { WorkbookInstance } from '@sheet-engine/react';
import * as Y from 'yjs';
import { migrateSheetFactoryForImport } from '../utils/migrate-new-yjs';
import { ySheetArrayToPlain } from '../utils/update-ydoc';

/**
 * Extracts the slug from a template token that may contain a uniqueness suffix.
 * Tokens are formatted as "slug::counter" to allow re-applying the same template.
 */
const parseTemplateSlug = (token: string): string => {
  const idx = token.indexOf('::');
  return idx === -1 ? token : token.slice(0, idx);
};

export const useApplyTemplatesBtn = ({
  selectedTemplate,
  setSelectedTemplate,
  ydocRef,
  dsheetId,
  currentDataRef,
  setForceSheetRender,
  sheetEditorRef,
  setDataBlockCalcFunction,
  initialiseLiveQueryData,
}: {
  selectedTemplate: string | undefined;
  setSelectedTemplate?: React.Dispatch<React.SetStateAction<string>> | ((slug: string | null) => void);
  ydocRef: React.RefObject<Y.Doc | null>;
  dsheetId: string;
  currentDataRef: React.MutableRefObject<object | null>;
  setForceSheetRender: Dispatch<SetStateAction<number>>;
  sheetEditorRef: React.RefObject<WorkbookInstance | null>;
  setDataBlockCalcFunction: React.Dispatch<
    React.SetStateAction<{ [key: string]: { [key: string]: any } }>
  >;
  initialiseLiveQueryData: (sheets: Sheet[]) => void;
}) => {
  useEffect(() => {
    if (!selectedTemplate) return;
    if (!ydocRef.current) return;

    const slug = parseTemplateSlug(selectedTemplate);
    let cancelled = false;

    void (async () => {
      // Dynamically import only the requested template's data.
      // The module reference is not retained so the GC can reclaim it.
      const mod = await import(
        '@fileverse-dev/dsheets-templates/template-data-list'
      );
      if (cancelled || !ydocRef.current) return;

      // getTemplateData returns a fresh copy with new sheet ids, so applying
      // the same template twice never duplicates ids. Older template package
      // versions lack it; fall back to the shared (hardcoded-id) data.
      const templateData = (mod.getTemplateData?.(slug) ??
        mod.TEMPLATES_DATA[slug]) as Sheet[] | undefined;
      if (templateData) {
        const newSheetId = sheetEditorRef.current
          ?.getSettings()
          .generateSheetId();
        const sheetArray = ydocRef.current.getArray(dsheetId);
        const data = Array.from(sheetArray) as Sheet[];
        templateData[0].order = data.length;
        if (!templateData[0].id) {
          templateData[0].id = newSheetId;
        }
        const finalData = [...data, ...templateData];
        ydocRef.current.transact(() => {
          finalData.forEach((sheet) => {
            if (sheet instanceof Y.Map) return;

            const factory = migrateSheetFactoryForImport(sheet);
            sheetArray.push([factory()]);
          });
        });
        const plainData = ySheetArrayToPlain(sheetArray);
        currentDataRef.current = plainData;
        initialiseLiveQueryData(plainData);
        setForceSheetRender?.((prev: number) => prev + 1);
        setTimeout(() => {
          sheetEditorRef.current?.activateSheet({
            index: plainData.length - 1,
          });
        }, 100);
        setDataBlockCalcFunction((prev) => {
          if (templateData[0]?.dataBlockCalcFunction) {
            const targetSheetId = templateData[0]?.id ?? newSheetId;
            if (!targetSheetId) return prev;
            return {
              ...prev,
              [targetSheetId]: {
                ...(prev?.[targetSheetId] || {}),
                ...templateData[0]?.dataBlockCalcFunction,
              },
            };
          }
          return prev;
        });
      }

      // Reset selection so clicking the same template re-triggers the effect,
      // and release the template token from state.
      setSelectedTemplate?.(null as any);
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedTemplate]);
};
