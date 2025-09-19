import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { eq } from "drizzle-orm";
import { Type, Static } from "@sinclair/typebox";

import { workflowTable } from "../../drizzle/tables/workflow.table.js";
import {
  WorkflowInsertSchema,
  WorkflowSelectSchema,
} from "../../typebox/schemas/workflow.schemas.js";

export default async function workflowRoutes(
  fastify: FastifyInstance,
  options: FastifyPluginOptions
) {
  // POST ONE
  fastify.post<{ Body: WorkflowInsertSchema }>(
    "/",
    {
      schema: {
        description: "Create a workflow",
        tags: ["workflow"],
        body: WorkflowInsertSchema,
        response: {
          201: WorkflowInsertSchema,
        },
      },
    },
    async (request, reply) => {
      const newWorkflow = request.body;
      const result = await fastify.db
        .insert(workflowTable)
        .values(newWorkflow)
        .returning();
      return reply.code(201).send(result[0]);
    }
  );

  // GET ALL
  fastify.get(
    "/",
    {
      schema: {
        description: "Select all workflow",
        tags: ["workflow"],
        response: {
          200: Type.Array(WorkflowSelectSchema),
        },
      },
    },
    async (request, reply) => {
      const result = await fastify.db.select().from(workflowTable);
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
        description: "Get a single workflow by ID",
        tags: ["workflow"],
        params: GetOneParamsSchema,
        response: {
          200: WorkflowSelectSchema,
          404: Type.Object({ message: Type.String() }),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const result = await fastify.db
        .select()
        .from(workflowTable)
        .where(eq(workflowTable.id, id))
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
        description: "Delete a workflow by ID",
        tags: ["workflow"],
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
        .delete(workflowTable)
        .where(eq(workflowTable.id, id))
        .returning({ id: workflowTable.id });

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

  const PatchOneBodySchema = Type.Partial(WorkflowInsertSchema);
  type PatchOneBodySchema = Static<typeof PatchOneBodySchema>;

  fastify.patch<{ Params: PatchOneParamsSchema; Body: PatchOneBodySchema }>(
    "/:id",
    {
      schema: {
        description: "Update a workflow by ID (partial update)",
        tags: ["workflow"],
        params: PatchOneParamsSchema,
        body: PatchOneBodySchema,
        response: {
          200: WorkflowSelectSchema,
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
        .update(workflowTable)
        .set(updateData)
        .where(eq(workflowTable.id, id))
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
