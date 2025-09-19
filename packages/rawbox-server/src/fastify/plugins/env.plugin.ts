import fp from "fastify-plugin";
import env, { FastifyEnvOptions } from "@fastify/env";
import { Static, Type } from "@sinclair/typebox";

// Define the schema for your environment variables using TypeBox.
// This provides validation and type inference.
const ConfigSchema = Type.Object({
  DATABASE_URI: Type.String(),
  // Add other environment variables here, e.g.:
  // NODE_ENV: Type.String({ default: 'development' })
});

// Define a type for your config object
export type ConfigSchema = Static<typeof ConfigSchema>;

// Augment the FastifyInstance interface to add the 'config' property
declare module "fastify" {
  interface FastifyInstance {
    config: ConfigSchema;
  }
}

export default fp(
  async (fastify) => {
    const options: FastifyEnvOptions = {
      dotenv: true, // This will load the .env file
      schema: ConfigSchema,
    };

    await fastify.register(env, options);
  },
  { name: "rawbox-backend-env-plugin" }
);
