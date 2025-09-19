import { Static, Type } from "@sinclair/typebox";

const ConfigSchema = Type.Object({
  DATABASE_URI: Type.String({ default: "sqlite.db" }),
  PORT: Type.Number({ default: 3000 }),
  HOST: Type.String({ default: "127.0.0.1" }),
});

export type ConfigSchema = Static<typeof ConfigSchema>;

export default ConfigSchema;
