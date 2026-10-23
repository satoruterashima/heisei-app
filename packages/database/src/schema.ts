import { sql } from 'drizzle-orm';
import { pgTable, uuid, varchar, text, timestamp, boolean, integer, uniqueIndex, index, check } from 'drizzle-orm/pg-core';

// ユーザープロファイル
export const profiles = pgTable('profiles', {
  id: uuid('id').primaryKey(),
  username: varchar('username', { length: 50 }).notNull().unique(),
  displayName: varchar('display_name', { length: 50 }).notNull(),
  bio: text('bio'),
  favoriteGenres: text('favorite_genres'),
  avatarUrl: text('avatar_url'),
  // Provider subject, not a client-controlled user id. Nullable for expand/contract rollout.
  authSubject: varchar('auth_subject', { length: 255 }),
  authLevel: integer('auth_level').default(0).notNull(),
  membership: varchar('membership', { length: 20 }).default('free').notNull(),
  rolesJson: text('roles_json').default('["member"]').notNull(),
  accountStatus: varchar('account_status', { length: 20 }).default('active').notNull(),
  isAgeVerified: boolean('is_age_verified').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  authSubjectUnique: uniqueIndex('profiles_auth_subject_unique').on(table.authSubject),
  authLevelCheck: check('profiles_auth_level_check', sql`${table.authLevel} between 0 and 4`),
  membershipCheck: check('profiles_membership_check', sql`${table.membership} in ('free', 'paid', 'official')`),
  accountStatusCheck: check('profiles_account_status_check', sql`${table.accountStatus} in ('active', 'ai_suspended', 'suspended', 'banned')`),
}));

// Authentication evidence. Provider identifiers are stored only as masked/hash references.
export const userVerifications = pgTable('user_verifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => profiles.id).notNull(),
  kind: varchar('kind', { length: 40 }).notNull(),
  status: varchar('status', { length: 20 }).notNull(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  providerRefHash: varchar('provider_ref_hash', { length: 128 }),
  verificationVersion: varchar('verification_version', { length: 40 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  verifiedVerificationUnique: uniqueIndex('user_verifications_verified_unique')
    .on(table.userId, table.kind)
    .where(sql`${table.status} = 'verified'`),
  userIndex: index('user_verifications_user_id_idx').on(table.userId),
  statusCheck: check('user_verifications_status_check', sql`${table.status} in ('pending', 'verified', 'rejected', 'revoked')`),
}));

export const userSettings = pgTable('user_settings', {
  userId: uuid('user_id').primaryKey().references(() => profiles.id),
  allowFriendRequests: boolean('allow_friend_requests').default(true).notNull(),
  allowDirectMessages: boolean('allow_direct_messages').default(true).notNull(),
  timezone: varchar('timezone', { length: 64 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const blocks = pgTable('blocks', {
  id: uuid('id').primaryKey().defaultRandom(),
  blockerId: uuid('blocker_id').references(() => profiles.id).notNull(),
  blockedId: uuid('blocked_id').references(() => profiles.id).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  pairUnique: uniqueIndex('blocks_blocker_blocked_unique').on(table.blockerId, table.blockedId),
  blockerIndex: index('blocks_blocker_id_idx').on(table.blockerId),
  blockedIndex: index('blocks_blocked_id_idx').on(table.blockedId),
  selfBlockCheck: check('blocks_no_self_block_check', sql`${table.blockerId} <> ${table.blockedId}`),
}));

export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  actorUserId: uuid('actor_user_id').references(() => profiles.id),
  targetUserId: uuid('target_user_id').references(() => profiles.id),
  action: varchar('action', { length: 80 }).notNull(),
  reason: varchar('reason', { length: 240 }),
  requestId: varchar('request_id', { length: 128 }),
  ruleVersion: varchar('rule_version', { length: 40 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  actorIndex: index('audit_logs_actor_user_id_idx').on(table.actorUserId),
  targetIndex: index('audit_logs_target_user_id_idx').on(table.targetUserId),
  createdAtIndex: index('audit_logs_created_at_idx').on(table.createdAt),
}));

// 141文字投稿
export const posts = pgTable('posts', {
  id: uuid('id').primaryKey().defaultRandom(),
  authorId: uuid('author_id').references(() => profiles.id).notNull(),
  content: varchar('content', { length: 141 }).notNull(),
  likesCount: integer('likes_count').default(0).notNull(),
  commentsCount: integer('comments_count').default(0).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// スレッド
export const threads = pgTable('threads', {
  id: uuid('id').primaryKey().defaultRandom(),
  creatorId: uuid('creator_id').references(() => profiles.id).notNull(),
  title: varchar('title', { length: 100 }).notNull(),
  status: varchar('status', { length: 20 }).default('active').notNull(),
  replyCount: integer('reply_count').default(0).notNull(),
  kskCount: integer('ksk_count').default(0).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// コミュニティ
export const communities = pgTable('communities', {
  id: uuid('id').primaryKey().defaultRandom(),
  creatorId: uuid('creator_id').references(() => profiles.id).notNull(),
  name: varchar('name', { length: 50 }).notNull(),
  description: text('description'),
  category: varchar('category', { length: 30 }).notNull(),
  level: integer('level').default(1).notNull(),
  memberCount: integer('member_count').default(1).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// 本日のトレンディ
export const trendyTopics = pgTable('trendy_topics', {
  id: uuid('id').primaryKey().defaultRandom(),
  targetYear: integer('target_year').notNull(),
  targetDate: varchar('target_date', { length: 5 }).notNull(), // MM-DD
  topicsJson: text('topics_json').notNull(),
  generatedAt: timestamp('generated_at', { withTimezone: true }).defaultNow().notNull(),
});
