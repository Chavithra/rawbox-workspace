import { Type, Static } from 'typebox';

export type GetContractRegistryApiResponse = Static<
  typeof GetContractRegistryApiResponse
>;
export const GetContractRegistryApiResponse = Type.Array(
  Type.Object({
    contractRegistryPath: Type.String(),
    contractRecord: Type.Union([
      Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]),
      Type.Array(Type.Any()),
      Type.Object(
        {},
        {
          additionalProperties: Type.Any(),
        },
      ),
    ]),
  }),
);

export type GetContractRegistryApiArg = Static<
  typeof GetContractRegistryApiArg
>;
export const GetContractRegistryApiArg = Type.Void();

export type DeleteContractRegistryApiResponse = Static<
  typeof DeleteContractRegistryApiResponse
>;
export const DeleteContractRegistryApiResponse = Type.Object({
  message: Type.String(),
});

export type DeleteContractRegistryApiArg = Static<
  typeof DeleteContractRegistryApiArg
>;
export const DeleteContractRegistryApiArg = Type.Void();

export type PostContractRegistryReloadSyncApiResponse = Static<
  typeof PostContractRegistryReloadSyncApiResponse
>;
export const PostContractRegistryReloadSyncApiResponse = Type.Object({
  message: Type.String(),
});

export type PostContractRegistryReloadSyncApiArg = Static<
  typeof PostContractRegistryReloadSyncApiArg
>;
export const PostContractRegistryReloadSyncApiArg = Type.Void();

export type PostContractRegistryReloadAsyncApiResponse = Static<
  typeof PostContractRegistryReloadAsyncApiResponse
>;
export const PostContractRegistryReloadAsyncApiResponse = Type.Object({
  message: Type.String(),
});

export type PostContractRegistryReloadAsyncApiArg = Static<
  typeof PostContractRegistryReloadAsyncApiArg
>;
export const PostContractRegistryReloadAsyncApiArg = Type.Void();

export type PostConstantsApiResponse = Static<typeof PostConstantsApiResponse>;
export const PostConstantsApiResponse = Type.Object({
  workflowId: Type.String(),
  workspaceId: Type.String(),
  keyId: Type.String(),
  value: Type.Union([
    Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]),
    Type.Array(Type.Any()),
    Type.Object(
      {},
      {
        additionalProperties: Type.Any(),
      },
    ),
  ]),
});

export type PostConstantsApiArg = Static<typeof PostConstantsApiArg>;
export const PostConstantsApiArg = Type.Object({
  body: Type.Object({
    workflowId: Type.String(),
    workspaceId: Type.String(),
    keyId: Type.String(),
    value: Type.Union([
      Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]),
      Type.Array(Type.Any()),
      Type.Object(
        {},
        {
          additionalProperties: Type.Any(),
        },
      ),
    ]),
  }),
});

export type GetConstantsApiResponse = Static<typeof GetConstantsApiResponse>;
export const GetConstantsApiResponse = Type.Array(
  Type.Object({
    workflowId: Type.String(),
    workspaceId: Type.String(),
    keyId: Type.String(),
    value: Type.Union([
      Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]),
      Type.Array(Type.Any()),
      Type.Object(
        {},
        {
          additionalProperties: Type.Any(),
        },
      ),
    ]),
  }),
);

export type GetConstantsApiArg = Static<typeof GetConstantsApiArg>;
export const GetConstantsApiArg = Type.Object({
  workspaceId: Type.Optional(Type.String()),
  workflowId: Type.Optional(Type.String()),
});

export type GetConstantsByWorkspaceIdAndWorkflowIdKeyIdApiResponse = Static<
  typeof GetConstantsByWorkspaceIdAndWorkflowIdKeyIdApiResponse
>;
export const GetConstantsByWorkspaceIdAndWorkflowIdKeyIdApiResponse =
  Type.Object({
    workflowId: Type.String(),
    workspaceId: Type.String(),
    keyId: Type.String(),
    value: Type.Union([
      Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]),
      Type.Array(Type.Any()),
      Type.Object(
        {},
        {
          additionalProperties: Type.Any(),
        },
      ),
    ]),
  });

export type GetConstantsByWorkspaceIdAndWorkflowIdKeyIdApiArg = Static<
  typeof GetConstantsByWorkspaceIdAndWorkflowIdKeyIdApiArg
>;
export const GetConstantsByWorkspaceIdAndWorkflowIdKeyIdApiArg = Type.Object({
  workspaceId: Type.String(),
  workflowId: Type.String(),
  keyId: Type.String(),
});

export type DeleteConstantsByWorkspaceIdAndWorkflowIdKeyIdApiResponse = Static<
  typeof DeleteConstantsByWorkspaceIdAndWorkflowIdKeyIdApiResponse
>;
export const DeleteConstantsByWorkspaceIdAndWorkflowIdKeyIdApiResponse =
  Type.Object({
    message: Type.String(),
  });

export type DeleteConstantsByWorkspaceIdAndWorkflowIdKeyIdApiArg = Static<
  typeof DeleteConstantsByWorkspaceIdAndWorkflowIdKeyIdApiArg
>;
export const DeleteConstantsByWorkspaceIdAndWorkflowIdKeyIdApiArg = Type.Object(
  {
    workspaceId: Type.String(),
    workflowId: Type.String(),
    keyId: Type.String(),
  },
);

export type PatchConstantsByWorkspaceIdAndWorkflowIdKeyIdApiResponse = Static<
  typeof PatchConstantsByWorkspaceIdAndWorkflowIdKeyIdApiResponse
>;
export const PatchConstantsByWorkspaceIdAndWorkflowIdKeyIdApiResponse =
  Type.Object({
    workflowId: Type.String(),
    workspaceId: Type.String(),
    keyId: Type.String(),
    value: Type.Union([
      Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]),
      Type.Array(Type.Any()),
      Type.Object(
        {},
        {
          additionalProperties: Type.Any(),
        },
      ),
    ]),
  });

export type PatchConstantsByWorkspaceIdAndWorkflowIdKeyIdApiArg = Static<
  typeof PatchConstantsByWorkspaceIdAndWorkflowIdKeyIdApiArg
>;
export const PatchConstantsByWorkspaceIdAndWorkflowIdKeyIdApiArg = Type.Object({
  workspaceId: Type.String(),
  workflowId: Type.String(),
  keyId: Type.String(),
  body: Type.Object({
    value: Type.Optional(
      Type.Union([
        Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]),
        Type.Array(Type.Any()),
        Type.Object(
          {},
          {
            additionalProperties: Type.Any(),
          },
        ),
      ]),
    ),
  }),
});

export type PostWorkflowsApiResponse = Static<typeof PostWorkflowsApiResponse>;
export const PostWorkflowsApiResponse = Type.Object({
  alias: Type.String(),
  id: Type.Optional(Type.String()),
  stepList: Type.Union([
    Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]),
    Type.Array(Type.Any()),
    Type.Object(
      {},
      {
        additionalProperties: Type.Any(),
      },
    ),
  ]),
  workspaceId: Type.String(),
});

export type PostWorkflowsApiArg = Static<typeof PostWorkflowsApiArg>;
export const PostWorkflowsApiArg = Type.Object({
  body: Type.Object({
    alias: Type.String(),
    id: Type.Optional(Type.String()),
    stepList: Type.Union([
      Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]),
      Type.Array(Type.Any()),
      Type.Object(
        {},
        {
          additionalProperties: Type.Any(),
        },
      ),
    ]),
    workspaceId: Type.String(),
  }),
});

export type GetWorkflowsApiResponse = Static<typeof GetWorkflowsApiResponse>;
export const GetWorkflowsApiResponse = Type.Array(
  Type.Object({
    alias: Type.String(),
    id: Type.String(),
    stepList: Type.Union([
      Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]),
      Type.Array(Type.Any()),
      Type.Object(
        {},
        {
          additionalProperties: Type.Any(),
        },
      ),
    ]),
    workspaceId: Type.String(),
  }),
);

export type GetWorkflowsApiArg = Static<typeof GetWorkflowsApiArg>;
export const GetWorkflowsApiArg = Type.Void();

export type GetWorkflowsByIdApiResponse = Static<
  typeof GetWorkflowsByIdApiResponse
>;
export const GetWorkflowsByIdApiResponse = Type.Object({
  alias: Type.String(),
  id: Type.String(),
  stepList: Type.Union([
    Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]),
    Type.Array(Type.Any()),
    Type.Object(
      {},
      {
        additionalProperties: Type.Any(),
      },
    ),
  ]),
  workspaceId: Type.String(),
});

export type GetWorkflowsByIdApiArg = Static<typeof GetWorkflowsByIdApiArg>;
export const GetWorkflowsByIdApiArg = Type.Object({
  id: Type.String(),
});

export type DeleteWorkflowsByIdApiResponse = Static<
  typeof DeleteWorkflowsByIdApiResponse
>;
export const DeleteWorkflowsByIdApiResponse = Type.Object({
  message: Type.String(),
});

export type DeleteWorkflowsByIdApiArg = Static<
  typeof DeleteWorkflowsByIdApiArg
>;
export const DeleteWorkflowsByIdApiArg = Type.Object({
  id: Type.String(),
});

export type PatchWorkflowsByIdApiResponse = Static<
  typeof PatchWorkflowsByIdApiResponse
>;
export const PatchWorkflowsByIdApiResponse = Type.Object({
  alias: Type.String(),
  id: Type.String(),
  stepList: Type.Union([
    Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]),
    Type.Array(Type.Any()),
    Type.Object(
      {},
      {
        additionalProperties: Type.Any(),
      },
    ),
  ]),
  workspaceId: Type.String(),
});

export type PatchWorkflowsByIdApiArg = Static<typeof PatchWorkflowsByIdApiArg>;
export const PatchWorkflowsByIdApiArg = Type.Object({
  id: Type.String(),
  body: Type.Object({
    alias: Type.Optional(Type.String()),
    id: Type.Optional(Type.String()),
    stepList: Type.Optional(
      Type.Union([
        Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]),
        Type.Array(Type.Any()),
        Type.Object(
          {},
          {
            additionalProperties: Type.Any(),
          },
        ),
      ]),
    ),
    workspaceId: Type.Optional(Type.String()),
  }),
});

export type PostWorkspacesApiResponse = Static<
  typeof PostWorkspacesApiResponse
>;
export const PostWorkspacesApiResponse = Type.Object({
  alias: Type.String(),
  id: Type.String(),
});

export type PostWorkspacesApiArg = Static<typeof PostWorkspacesApiArg>;
export const PostWorkspacesApiArg = Type.Object({
  body: Type.Object({
    alias: Type.String(),
    id: Type.Optional(Type.String()),
  }),
});

export type GetWorkspacesApiResponse = Static<typeof GetWorkspacesApiResponse>;
export const GetWorkspacesApiResponse = Type.Array(
  Type.Object({
    alias: Type.String(),
    id: Type.String(),
  }),
);

export type GetWorkspacesApiArg = Static<typeof GetWorkspacesApiArg>;
export const GetWorkspacesApiArg = Type.Void();

export type GetWorkspacesByIdApiResponse = Static<
  typeof GetWorkspacesByIdApiResponse
>;
export const GetWorkspacesByIdApiResponse = Type.Object({
  alias: Type.String(),
  id: Type.String(),
});

export type GetWorkspacesByIdApiArg = Static<typeof GetWorkspacesByIdApiArg>;
export const GetWorkspacesByIdApiArg = Type.Object({
  id: Type.String(),
});

export type DeleteWorkspacesByIdApiResponse = Static<
  typeof DeleteWorkspacesByIdApiResponse
>;
export const DeleteWorkspacesByIdApiResponse = Type.Object({
  message: Type.String(),
});

export type DeleteWorkspacesByIdApiArg = Static<
  typeof DeleteWorkspacesByIdApiArg
>;
export const DeleteWorkspacesByIdApiArg = Type.Object({
  id: Type.String(),
});

export type PatchWorkspacesByIdApiResponse = Static<
  typeof PatchWorkspacesByIdApiResponse
>;
export const PatchWorkspacesByIdApiResponse = Type.Object({
  alias: Type.String(),
  id: Type.String(),
});

export type PatchWorkspacesByIdApiArg = Static<
  typeof PatchWorkspacesByIdApiArg
>;
export const PatchWorkspacesByIdApiArg = Type.Object({
  id: Type.String(),
  body: Type.Object({
    alias: Type.Optional(Type.String()),
    id: Type.Optional(Type.String()),
  }),
});
