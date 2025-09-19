import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { Static, Type } from "@sinclair/typebox";
import { eq } from "drizzle-orm";

import { workspaceTable } from "../../drizzle/tables/index.js";
import {
  WorkspaceInsertSchema,
  WorkspaceSelectSchema,
} from "../../typebox/schemas/workspace.schemas.js";

export default async function workspaceRoutes(
  fastify: FastifyInstance,
  options: FastifyPluginOptions
) {
  // POST ONE
  fastify.post<{ Body: WorkspaceInsertSchema }>(
    "/",
    {
      schema: {
        description: "Create a workspace",
        tags: ["workspace"],
        body: WorkspaceInsertSchema,
        response: {
          201: WorkspaceSelectSchema,
        },
      },
    },
    async (request, reply) => {
      const newWorkspace = request.body;
      const result = await fastify.db
        .insert(workspaceTable)
        .values(newWorkspace)
        .returning();
      return reply.code(201).send(result[0]);
    }
  );

  // GET ALL
  fastify.get(
    "/",
    {
      schema: {
        description: "Select all workspaces",
        tags: ["workspace"],
        response: {
          200: Type.Array(WorkspaceSelectSchema),
        },
      },
    },
    async (request, reply) => {
      const result = await fastify.db.select().from(workspaceTable);
      return reply.send(result);
    }
  );

  // GET ONE
  const GetOneParamsSchema = Type.Object({ id: Type.String() });
  type GetOneParamsSchema = Static<typeof GetOneParamsSchema>;

  fastify.get<{ Params: GetOneParamsSchema }>(
    "/:id",
    {
      schema: {
        description: "Get a single workspace by ID",
        tags: ["workspace"],
        params: GetOneParamsSchema,
        response: {
          200: WorkspaceSelectSchema,
          404: Type.Object({ message: Type.String() }),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const result = await fastify.db
        .select()
        .from(workspaceTable)
        .where(eq(workspaceTable.id, id))
        .limit(1);

      if (result.length === 0) {
        return reply
          .code(404)
          .send({ message: `Workspace with id ${id} not found` });
      }

      return reply.send(result[0]);
    }
  );

  // DELETE ONE
  const DeleteOneParamsSchema = Type.Object({ id: Type.String() });
  type DeleteOneParamsSchema = Static<typeof DeleteOneParamsSchema>;

  fastify.delete<{ Params: DeleteOneParamsSchema }>(
    "/:id",
    {
      schema: {
        description: "Delete a workspace by ID",
        tags: ["workspace"],
        params: DeleteOneParamsSchema,
        response: {
          200: Type.Object({ message: Type.String() }),
          404: Type.Object({ message: Type.String() }),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const result = await fastify.db
        .delete(workspaceTable)
        .where(eq(workspaceTable.id, id))
        .returning({ id: workspaceTable.id });

      if (result.length === 0) {
        return reply
          .code(404)
          .send({ message: `Workspace with id ${id} not found` });
      }

      return reply.send({
        message: `Workspace with id ${id} deleted successfully`,
      });
    }
  );

  // PATCH ONE
  const PatchOneParamsSchema = Type.Object({ id: Type.String() });
  type PatchOneParamsSchema = Static<typeof PatchOneParamsSchema>;

  const PatchOneBodySchema = Type.Partial(WorkspaceInsertSchema);
  type PatchOneBodySchema = Static<typeof PatchOneBodySchema>;

  fastify.patch<{ Params: PatchOneParamsSchema; Body: PatchOneBodySchema }>(
    "/:id",
    {
      schema: {
        description: "Update a workspace by ID (partial update)",
        tags: ["workspace"],
        params: PatchOneParamsSchema,
        body: PatchOneBodySchema,
        response: {
          200: WorkspaceSelectSchema,
          400: Type.Object({ message: Type.String() }),
          404: Type.Object({ message: Type.String() }),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const updateData = request.body;

      if (Object.keys(updateData).length === 0) {
        return reply
          .code(400)
          .send({ message: "Request body must not be empty for an update." });
      }

      const result = await fastify.db
        .update(workspaceTable)
        .set(updateData)
        .where(eq(workspaceTable.id, id))
        .returning();

      if (result.length === 0) {
        return reply
          .code(404)
          .send({ message: `Workspace with id ${id} not found` });
      }

      return reply.send(result[0]);
    }
  );
}
