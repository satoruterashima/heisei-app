import { describe, expect, it } from 'vitest';
import { createPostSchema } from '../packages/validation/src/index';

describe('createPostSchema', () => {
  it.each(['あ', 'あ'.repeat(141)])('accepts valid content', (content) => {
    expect(createPostSchema.parse({ content })).toEqual({ content });
  });

  it.each([{}, { content: '' }, { content: 'あ'.repeat(142) }, { content: 141 }, null])(
    'rejects invalid payload %j',
    (payload) => {
      expect(createPostSchema.safeParse(payload).success).toBe(false);
    },
  );
});
