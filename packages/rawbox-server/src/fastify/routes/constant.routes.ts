import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { and, eq } from "drizzle-orm";
import { Type, Static } from "@sinclair/typebox";

import { constantTable } from "../../drizzle/tables/constant.table.js";
import {
  ConstantInsertSchema,
  ConstantSelectSchema,
} from "../../typebox/schemas/constant.schema.js";

export default async function constantRoutes(
  fastify: FastifyInstance,
  options: FastifyPluginOptions
) {
  // POST ONE
  fastify.post<{ Body: ConstantInsertSchema }>(
    "/",
    {
      schema: {
        description: "Create a constant",
        tags: ["constant"],
        body: ConstantInsertSchema,
        response: {
          201: ConstantSelectSchema,
        },
      },
    },
    async (request, reply) => {
      const newConstant = request.body;
      const result = await fastify.db
        .insert(constantTable)
        .values(newConstant)
        .returning();
      return reply.code(201).send(result[0]);
    }
  );

  // GET ALL / BY FILTERS
  const GetAllQuerySchema = Type.Object({
    workspaceId: Type.Optional(Type.String()),
    workflowId: Type.Optional(Type.String()),
  });
  type GetAllQuerySchema = Static<typeof GetAllQuerySchema>;

  fastify.get<{ Querystring: GetAllQuerySchema }>(
    "/",
    {
      schema: {
        description:
          "Select all constants, optionally filtering by workspaceId and/or workflowId.",
        tags: ["constant"],
        querystring: GetAllQuerySchema,
        response: {
          200: Type.Array(ConstantSelectSchema),
        },
      },
    },
    async (request, reply) => {
      const { workspaceId, workflowId } = request.query;

      const conditions = [];
      if (workspaceId) {
        conditions.push(eq(constantTable.workspaceId, workspaceId));
      }
      if (workflowId) {
        conditions.push(eq(constantTable.workflowId, workflowId));
      }

      const query = fastify.db.select().from(constantTable);
      if (conditions.length > 0) {
        query.where(and(...conditions));
      }
      const result = await query;
      return reply.send(result);
    }
  );

  // GET ONE
  const GetOneParamsSchema = Type.Object({
    workspaceId: Type.String(),
    workflowId: Type.String(),
    keyId: Type.String(),
  });
  type GetOneParamsSchema = Static<typeof GetOneParamsSchema>;

  fastify.get<{ Params: GetOneParamsSchema }>(
    "/:workspaceId/:workflowId/:keyId",
    {
      schema: {
        description: "Get a single constant by its composite key",
        tags: ["constant"],
        params: GetOneParamsSchema,
        response: {
          200: ConstantSelectSchema,
          404: Type.Object({ message: Type.String() }),
        },
      },
    },
    async (request, reply) => {
      const { workspaceId, workflowId, keyId } = request.params;
      const result = await fastify.db
        .select()
        .from(constantTable)
        .where(
          and(
            eq(constantTable.workspaceId, workspaceId),
            eq(constantTable.workflowId, workflowId),
            eq(constantTable.keyId, keyId)
          )
        )
        .limit(1);

      if (result.length === 0) {
        return reply.code(404).send({
          message: `Constant with keyId ${keyId} not found in workspace ${workspaceId} and workflow ${workflowId}`,
        });
      }

      return reply.send(result[0]);
    }
  );

  // DELETE ONE
  const DeleteOneParamsSchema = Type.Object({
    workspaceId: Type.String(),
    workflowId: Type.String(),
    keyId: Type.String(),
  });
  type DeleteOneParamsSchema = Static<typeof DeleteOneParamsSchema>;

  fastify.delete<{ Params: DeleteOneParamsSchema }>(
    "/:workspaceId/:workflowId/:keyId",
    {
      schema: {
        description: "Delete a constant by its composite key",
        tags: ["constant"],
        params: DeleteOneParamsSchema,
        response: {
          200: Type.Object({ message: Type.String() }),
          404: Type.Object({ message: Type.String() }),
        },
      },
    },
    async (request, reply) => {
      const { workspaceId, workflowId, keyId } = request.params;
      const result = await fastify.db
        .delete(constantTable)
        .where(
          and(
            eq(constantTable.workspaceId, workspaceId),
            eq(constantTable.workflowId, workflowId),
            eq(constantTable.keyId, keyId)
          )
        )
        .returning({ keyId: constantTable.keyId });

      if (result.length === 0) {
        return reply.code(404).send({
          message: `Constant with keyId ${keyId} not found in workspace ${workspaceId} and workflow ${workflowId}`,
        });
      }

      return reply.send({
        message: `Constant with keyId ${keyId} in workspace ${workspaceId} and workflow ${workflowId} deleted successfully`,
      });
    }
  );

  // PATCH ONE
  const PatchOneParamsSchema = Type.Object({
    workspaceId: Type.String(),
    workflowId: Type.String(),
    keyId: Type.String(),
  });
  type PatchOneParamsSchema = Static<typeof PatchOneParamsSchema>;

  const PatchOneBodySchema = Type.Partial(
    Type.Pick(ConstantInsertSchema, ["value"])
  );
  type PatchOneBodySchema = Static<typeof PatchOneBodySchema>;

  fastify.patch<{ Params: PatchOneParamsSchema; Body: PatchOneBodySchema }>(
    "/:workspaceId/:workflowId/:keyId",
    {
      schema: {
        description: "Update a constant by its composite key (partial update)",
        tags: ["constant"],
        params: PatchOneParamsSchema,
        body: PatchOneBodySchema,
        response: {
          200: ConstantSelectSchema,
          400: Type.Object({ message: Type.String() }),
          404: Type.Object({ message: Type.String() }),
        },
      },
    },
    async (request, reply) => {
      const { workspaceId, workflowId, keyId } = request.params;
      const updateData = request.body;

      if (Object.keys(updateData).length === 0) {
        return reply
          .code(400)
          .send({ message: "Request body must not be empty for an update." });
      }

      const result = await fastify.db
        .update(constantTable)
        .set(updateData)
        .where(
          and(
            eq(constantTable.workspaceId, workspaceId),
            eq(constantTable.workflowId, workflowId),
            eq(constantTable.keyId, keyId)
          )
        )
        .returning();

      if (result.length === 0) {
        return reply.code(404).send({
          message: `Constant with keyId ${keyId} not found in workspace ${workspaceId} and workflow ${workflowId}`,
        });
      }

      return reply.send(result[0]);
    }
  );
}
