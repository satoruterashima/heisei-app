import { describe, expect, it } from 'vitest';
import { calculateRemainingChars, isValidPostLength } from '../packages/domain/src/index';

describe('post length domain rules', () => {
  it.each([
    ['', 141, false],
    ['あ', 140, true],
    ['あ'.repeat(141), 0, true],
    ['あ'.repeat(142), -1, false],
  ])('handles the length boundary for %j', (text, remaining, valid) => {
    expect(calculateRemainingChars(text)).toBe(remaining);
    expect(isValidPostLength(text)).toBe(valid);
  });
});
