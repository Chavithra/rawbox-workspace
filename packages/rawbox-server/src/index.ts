import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import cors from "@fastify/cors";
import Fastify from "fastify";

import constantRoutes from "./fastify/routes/constant.routes.js";
import contractsRegistryRoutes from "./fastify/routes/contracts-registry.routes.js";
import dbPlugin from "./fastify/plugins/db.plugin.js";
import envPlugin from "./fastify/plugins/env.plugin.js";
import swaggerPlugin from "./fastify/plugins/swagger.plugin.js";
import workflowRoutes from "./fastify/routes/workflow.routes.js";
import workspaceRoutes from "./fastify/routes/workspace.routes.js";

async function main() {
  const fastify = Fastify({
    logger: true,
  }).withTypeProvider<TypeBoxTypeProvider>();

  // Register plugins
  await fastify.register(envPlugin);
  await fastify.register(dbPlugin);
  await fastify.register(swaggerPlugin);
  await fastify.register(cors, {
    origin: "http://localhost:5173",
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
  });

  // Register routes
  await fastify.register(contractsRegistryRoutes, {
    prefix: "/contracts-registry",
  });
  await fastify.register(constantRoutes, { prefix: "/constants" });
  await fastify.register(workflowRoutes, { prefix: "/workflows" });
  await fastify.register(workspaceRoutes, { prefix: "/workspaces" });

  // Start the server
  try {
    await fastify.listen({ port: 3000 });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

main();
