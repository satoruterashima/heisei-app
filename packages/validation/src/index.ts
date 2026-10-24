import { z } from 'zod';

export const MAX_POST_LENGTH = 141;

export const createPostSchema = z.object({
  content: z
    .string()
    .min(1, '投稿内容を入力してください')
    .max(MAX_POST_LENGTH, `投稿は${MAX_POST_LENGTH}文字以内で入力してください`),
});

export type CreatePostInput = z.infer<typeof createPostSchema>;

export const updateProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(50).optional(),
  bio: z.string().max(1000).nullable().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, '更新項目が必要です');

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

export * from './report-security.js';
