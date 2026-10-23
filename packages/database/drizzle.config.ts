import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  // Credentials are intentionally supplied only by an explicit local command.
  dbCredentials: {
    url: process.env.LOCAL_DATABASE_URL ?? 'postgresql://localhost/heisei_local',
  },
});
