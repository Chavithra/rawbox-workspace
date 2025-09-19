import fp from "fastify-plugin";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { FastifyInstance } from "fastify";

export default fp(
  async (fastify: FastifyInstance) => {
    await fastify.register(swagger, {
      openapi: {
        openapi: "3.1.0",
        info: {
          title: "Rawbox API",
          description: "API documentation for Rawbox",
          version: "1.0.0",
        },
      },
    });

    await fastify.register(swaggerUi, {
      routePrefix: "/api/v1/swagger",
      uiConfig: {
        docExpansion: "none",
        deepLinking: false,
      },
    });
  },
  {
    fastify: "5.x",
    name: "rawbox-backend-swagger-plugin",
  }
);
