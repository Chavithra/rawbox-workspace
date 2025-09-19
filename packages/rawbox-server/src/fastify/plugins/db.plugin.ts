import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import { drizzle, BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { drizzleConfig } from "../../drizzle/drizzle-config.js";

declare module "fastify" {
  interface FastifyInstance {
    db: BetterSQLite3Database<typeof drizzleConfig.schema>;
  }
}

export default fp(
  async (fastify: FastifyInstance) => {
    const config = fastify.config;

    const sqlite = new Database(config.DATABASE_URI);
    const db = drizzle(sqlite, drizzleConfig);

    fastify.decorate("db", db);

    fastify.addHook("onClose", async () => {
      sqlite.close();
    });
  },
  {
    fastify: "5.x",
    name: "rawbox-backend-db-plugin",
    dependencies: ["rawbox-backend-env-plugin"],
  }
);
