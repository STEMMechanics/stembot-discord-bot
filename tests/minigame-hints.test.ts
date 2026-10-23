import { describe, expect, it } from 'vitest';

import { isMinigameHintRequest } from '../src/services/minigame-hints.js';

describe('minigame hint requests', () => {
  it.each(['hint', 'Can I have another clue?', 'I am stuck, any ideas?', '<@123456> hint'])(
    'recognises %j',
    (content) => {
      expect(isMinigameHintRequest(content)).toBe(true);
    },
  );

  it.each(['magnet', 'the answer is gravity', 'helpful', 'what is a circuit?'])(
    'does not treat %j as a hint request',
    (content) => {
      expect(isMinigameHintRequest(content)).toBe(false);
    },
  );
});
