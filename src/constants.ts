import { COLLAB_PRESENCE_COLORS } from './sync-local/presence';

export {
  ERROR_MESSAGES_FLAG,
  SERVICES_API_KEY,
} from './editor/constants/shared-constants';
export { COLLAB_PRESENCE_COLORS } from './sync-local/presence';

export const ENS_PRESENCE_COLOR = '#5298FF';

function colorForClient(clientId: number): string {
  return COLLAB_PRESENCE_COLORS[clientId % COLLAB_PRESENCE_COLORS.length];
}

function randomPresenceColor(): string {
  return (
    '#' +
    Math.floor(Math.random() * 0xffffff)
      .toString(16)
      .padStart(6, '0')
  );
}

/** Explicit awareness color, else ENS brand color, palette, or random fallback. */
export function presenceColor(
  isEns: boolean | undefined,
  color?: string,
  clientId?: number,
): string {
  if (color) return color;
  if (isEns) return ENS_PRESENCE_COLOR;
  return clientId != null
    ? colorForClient(clientId)
    : randomPresenceColor();
}
