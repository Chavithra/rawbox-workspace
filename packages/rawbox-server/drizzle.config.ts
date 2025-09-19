import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./drizzle-migration",
  schema: ["./dist/src/drizzle/tables/index.js"],
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.DATABASE_URI!,
  },
});
