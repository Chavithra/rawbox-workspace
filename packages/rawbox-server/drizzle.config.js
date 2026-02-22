import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  casing: 'snake_case',
  dbCredentials: {
    url: process.env.DATABASE_URI,
  },
  dialect: 'sqlite',
  out: './drizzle-migration',
  schema: ['./dist/drizzle/tables/index.js'],
});
