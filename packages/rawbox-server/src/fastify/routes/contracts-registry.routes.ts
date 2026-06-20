import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import path from 'node:path';
import { Type, type Static } from 'typebox';

import { ContractRegistryLoader } from 'rawbox-plugin/contracts-registry-loader';

import { ContractRegistryTable } from '../../drizzle/tables/contracts-registry.table.js';
import { ContractRegistrySelectSchema } from '../../typebox/schemas/contracts-registry.schemas.js';

async function refreshContractsRegistries(fastify: FastifyInstance) {
  const benchmarkFilesPath = path.resolve(
    '/home/dtp2/code/javascript/real/rawbox-workspace/packages/rawbox-default-plugins',
  );
  const ContractRegistryPathList =
    await ContractRegistryLoader.loadContractRegistryPathList(
      benchmarkFilesPath,
    );

  await fastify.db.delete(ContractRegistryTable);

  for (const ContractRegistryPath of ContractRegistryPathList) {
    console.log(ContractRegistryPath);
    const loadContractRegistryResult =
      await ContractRegistryLoader.loadContractRegistry(ContractRegistryPath);
    if (loadContractRegistryResult.isOk()) {
      const ContractRegistry = loadContractRegistryResult.value;
      ContractRegistry.ContractRegistryPath = ContractRegistryPath;
      await fastify.db
        .insert(ContractRegistryTable)
        .values(ContractRegistry)
        .returning();
    } else {
      fastify.log.error(
        `Failed to load contracts registry from ${ContractRegistryPath}: ${loadContractRegistryResult.error}`,
      );
    }
  }
}

export default async function ContractRegistryRoutes(
  fastify: FastifyInstance,
  options: FastifyPluginOptions,
) {
  // GET ALL
  fastify.get(
    '/',
    {
      schema: {
        description: 'Get all contracts registries from the database',
        tags: ['contracts-registry'],
        response: {
          200: Type.Array(ContractRegistrySelectSchema),
        },
      },
    },
    async (request, reply) => {
      const contractsRegistries = await fastify.db
        .select()
        .from(ContractRegistryTable);

      return reply.send(contractsRegistries);
    },
  );

  // RELOAD ALL (SYNC)
  const ReloadResponseSchema = Type.Object({
    message: Type.String(),
  });
  type ReloadResponseSchema = Static<typeof ReloadResponseSchema>;
  fastify.post(
    '/reload-sync',
    {
      schema: {
        description: 'Reload all contracts registries and wait for completion',
        tags: ['contracts-registry'],
        response: {
          201: ReloadResponseSchema,
        },
      },
    },
    async (request, reply) => {
      await refreshContractsRegistries(fastify);
      return reply.code(201).send({
        message: 'Contracts registries have been reloaded',
      });
    },
  );

  // RELOAD ALL (ASYNC)
  const AsyncReloadResponseSchema = Type.Object({
    message: Type.String(),
  });
  type AsyncReloadResponseSchema = Static<typeof AsyncReloadResponseSchema>;
  fastify.post(
    '/reload-async',
    {
      schema: {
        description:
          'Trigger a reload of all contracts registries in the background',
        tags: ['contracts-registry'],
        response: {
          202: AsyncReloadResponseSchema,
        },
      },
    },
    (request, reply) => {
      refreshContractsRegistries(fastify).catch((err) => {
        request.log.error('Background contracts registry reload failed:', err);
      });
      return reply.code(202).send({
        message: 'Contracts registries reload initiated',
      });
    },
  );

  // DELETE ALL
  fastify.delete(
    '/',
    {
      schema: {
        description: 'Delete all contracts registries',
        tags: ['contracts-registry'],
        response: {
          200: Type.Object({
            message: Type.String(),
          }),
        },
      },
    },
    async (request, reply) => {
      await fastify.db.delete(ContractRegistryTable);

      return reply.send({
        message: 'All contracts registries have been deleted',
      });
    },
  );
}
