import { pgTable, uuid, varchar, text, timestamp, boolean, integer } from 'drizzle-orm/pg-core';

// ユーザープロファイル
export const profiles = pgTable('profiles', {
  id: uuid('id').primaryKey(),
  username: varchar('username', { length: 50 }).notNull().unique(),
  displayName: varchar('display_name', { length: 50 }).notNull(),
  bio: text('bio'),
  favoriteGenres: text('favorite_genres'),
  avatarUrl: text('avatar_url'),
  isAgeVerified: boolean('is_age_verified').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

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
