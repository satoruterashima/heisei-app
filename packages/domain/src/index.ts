import { MAX_POST_LENGTH } from '@heisei/validation';

export { MAX_POST_LENGTH };

export const THREAD_LIMITS = {
  MAX_THREADS: 1000,
  MAX_RESPONSES: 10000,
  KSK_EXTENSION_MINUTES: 15,
  MAX_CONTINUOUS_POSTS: 3,
} as const;

export function calculateRemainingChars(text: string): number {
  return MAX_POST_LENGTH - text.length;
}

export function isValidPostLength(text: string): boolean {
  return text.length > 0 && text.length <= MAX_POST_LENGTH;
}

export * from './quota.js';
export * from './durable-quota-store.js';
