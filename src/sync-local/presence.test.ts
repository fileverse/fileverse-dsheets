import { describe, expect, it } from 'vitest';

import {
  PLACEHOLDER_COLOR,
  COLLAB_PRESENCE_COLORS,
  assignSessionColors,
  buildIdentityMap,
  identitySignature,
  mergePresence,
} from './presence';

describe('dSheet collaboration presence', () => {
  it('keeps cell cursor movement out of the authoritative roster signature', () => {
    const before = new Map<number, Record<string, unknown>>([
      [
        1,
        {
          socketId: 'socket-a',
          user: { name: 'Ada', color: '#123456', isEns: true },
          cell: { r: 1, c: 2, sheetId: 'sheet-1' },
        },
      ],
    ]);
    const after = new Map<number, Record<string, unknown>>([
      [
        1,
        {
          socketId: 'socket-a',
          user: { name: 'Ada', color: '#abcdef', isEns: true },
          cell: { r: 99, c: 42, sheetId: 'sheet-2' },
        },
      ],
    ]);

    expect(identitySignature(['socket-a'], buildIdentityMap(before))).toBe(
      identitySignature(['socket-a'], buildIdentityMap(after)),
    );
  });

  it('uses the server socket roster as the authoritative collaborator set', () => {
    const identities = buildIdentityMap(
      new Map<number, Record<string, unknown>>([
        [
          1,
          {
            socketId: 'socket-a',
            user: { name: 'Ada', color: '#123456', isEns: false },
          },
        ],
      ]),
    );

    expect(mergePresence(['socket-a', 'socket-b'], identities)).toEqual([
      {
        clientId: 'socket-a',
        name: 'Ada',
        color: '#123456',
        isEns: false,
        isPlaceholder: false,
      },
      {
        clientId: 'socket-b',
        name: '',
        color: PLACEHOLDER_COLOR,
        isEns: '',
        isPlaceholder: true,
      },
    ]);
  });

  it('exhausts the palette and keeps colors stable for the session', () => {
    const colors = new Map<string, string>();
    const collaborators = Array.from({ length: 9 }, (_, index) => ({
      clientId: String(index),
      name: `Person ${index}`,
      color: '#random',
      isEns: '',
    }));

    assignSessionColors(collaborators, colors);
    expect(new Set(collaborators.slice(0, 8).map(({ color }) => color)).size).toBe(
      COLLAB_PRESENCE_COLORS.length,
    );
    expect(collaborators[8].color).toBe(collaborators[0].color);

    assignSessionColors(collaborators.reverse(), colors);
    expect(collaborators.find(({ name }) => name === 'Person 0')?.color).toBe(
      COLLAB_PRESENCE_COLORS[0],
    );
  });

  it('releases departed colors before assigning duplicates', () => {
    const colors = new Map<string, string>();
    const history = Array.from({ length: 12 }, (_, index) => ({
      clientId: String(index),
      name: `Person ${index}`,
      color: '#random',
      isEns: '',
    }));
    assignSessionColors(history, colors);

    const active = [...history.slice(0, 5), ...history.slice(8)].map((user) => ({
      ...user,
    }));
    assignSessionColors(active, colors);

    expect(colors.size).toBe(9);
    expect(new Set(active.map(({ color }) => color)).size).toBe(8);
  });
});
