import { z } from 'zod';

export const MAX_POST_LENGTH = 141;

export const createPostSchema = z.object({
  content: z
    .string()
    .min(1, '投稿内容を入力してください')
    .max(MAX_POST_LENGTH, `投稿は${MAX_POST_LENGTH}文字以内で入力してください`),
});

export type CreatePostInput = z.infer<typeof createPostSchema>;
