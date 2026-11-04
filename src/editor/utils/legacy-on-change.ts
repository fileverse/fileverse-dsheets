import throttle from 'lodash/throttle';

/** The legacy `onChange` argument pair: plain sheet data and the encoded doc. */
export type LegacyOnChangeArgs = { data: unknown; update: string };

export const LEGACY_ON_CHANGE_WAIT_MS = 1000;

/**
 * Trailing-only throttle for the host's legacy `onChange`.
 *
 * The host's handler is read when the throttle fires, not when it is created.
 * A host that passes a new inline `onChange` on every render must not rebuild
 * this throttle: rebuilding cancels the pending call, so an edit followed
 * within the wait by a re-render never reached the host's save.
 * `buildArgs` runs only when there is a handler, because it encodes the whole
 * document.
 */
export function createLegacyOnChangeThrottle<TData>(
  getOnChange: () => ((data: TData, update: string) => void) | undefined,
  buildArgs: () => { data: TData; update: string } | null,
  waitMs = LEGACY_ON_CHANGE_WAIT_MS,
) {
  return throttle(
    () => {
      const onChange = getOnChange();
      if (!onChange) return;
      const args = buildArgs();
      if (args) onChange(args.data, args.update);
    },
    waitMs,
    { leading: false, trailing: true },
  );
}
