import { useEffect, useRef, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { LucideIcon } from '@fileverse/ui';
import type { DocumentVersion } from '../../../src/swarm/swarm-document-storage';

/**
 * The sheet's versions on Swarm, newest first, below the status tag. A
 * version opens read-only; while one is open the menu also offers to go
 * back to the latest or to restore it as the newest version. Rendered in a
 * portal at a fixed position, so no toolbar or sheet layer covers it.
 */
export const SwarmVersionMenu = ({
  position,
  versions,
  error,
  viewing,
  canRestore,
  anchorRef,
  onPreview,
  onBack,
  onRestore,
  onClose,
}: {
  position: { top: number; left: number };
  /** Oldest first, as the storage lists them; null while loading. */
  versions: DocumentVersion[] | null;
  /** Why the list could not be read, if it could not. */
  error: string | null;
  /** The version open read-only, if any. */
  viewing: number | null;
  /** False where this browser cannot write the sheet's feed. */
  canRestore: boolean;
  /**
   * The tag that opens the menu: clicks on it toggle rather than close.
   * A ref, read at click time: opening a version mounts another editor,
   * whose navbar renders a new tag.
   */
  anchorRef: RefObject<HTMLElement | null>;
  onPreview: (index: number) => void;
  onBack: () => void;
  onRestore: () => void;
  onClose: () => void;
}) => {
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        menuRef.current?.contains(target) ||
        anchorRef.current?.contains(target)
      ) {
        return;
      }
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [anchorRef, onClose]);

  const latest = versions?.[versions.length - 1]?.index;
  const item =
    'w-full text-left px-3 py-2 hover:color-bg-secondary flex items-center gap-2';

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      className="fixed min-w-56 max-h-72 overflow-y-auto rounded border color-border-default shadow-elevation-3 text-[12px]"
      style={{
        backgroundColor: 'hsl(var(--color-bg-default))',
        top: position.top,
        left: position.left,
        zIndex: 99999,
      }}
    >
      {viewing !== null && (
        <>
          {canRestore ? (
            <button
              type="button"
              role="menuitem"
              className={`${item} font-medium`}
              onClick={onRestore}
            >
              <LucideIcon name="RotateCcw" size="sm" />
              Restore v{viewing} as latest
            </button>
          ) : (
            <div className="px-3 py-2 color-text-secondary">
              Read-only here: versions can be viewed, not restored
            </div>
          )}
          <button
            type="button"
            role="menuitem"
            className={item}
            onClick={onBack}
          >
            <LucideIcon name="ArrowLeft" size="sm" />
            Back to latest
          </button>
          <div className="border-t color-border-default" />
        </>
      )}
      {versions === null && (
        <div className="px-3 py-2 color-text-secondary">Loading versions…</div>
      )}
      {error ? (
        <div className="px-3 py-2 color-text-secondary max-w-80 whitespace-normal">
          Could not list the versions from here: {error}
        </div>
      ) : (
        versions?.length === 0 && (
          <div className="px-3 py-2 color-text-secondary">No versions yet</div>
        )
      )}
      {versions
        ?.slice()
        .reverse()
        .map((v) => (
          <button
            key={v.index}
            type="button"
            role="menuitem"
            className={`${item} justify-between gap-3`}
            onClick={() => onPreview(v.index)}
          >
            <span>
              v{v.index}
              {v.index === latest ? ' (latest)' : ''}
              {v.index === viewing ? ' (viewing)' : ''}
            </span>
            <span className="color-text-secondary">
              {new Date(v.timestamp * 1000).toLocaleString()}
            </span>
          </button>
        ))}
    </div>,
    document.body,
  );
};
