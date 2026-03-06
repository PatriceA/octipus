import type { Config } from 'drizzle-kit';

export default {
  schema: './src/db/schema/*',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: (() => {
      const url = process.env.DATABASE_URL;
      if (!url) throw new Error('DATABASE_URL environment variable is required');
      return url;
    })(),
  },
} satisfies Config;
