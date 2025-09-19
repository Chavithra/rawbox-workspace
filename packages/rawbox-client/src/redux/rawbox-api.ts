import { rawboxApiEmpty as api } from "./rawbox-api-empty";
export const addTagTypes = [
  "contracts-registry",
  "constant",
  "workflow",
  "workspace",
] as const;
const injectedRtkApi = api
  .enhanceEndpoints({
    addTagTypes,
  })
  .injectEndpoints({
    endpoints: (build) => ({
      getContractsRegistry: build.query<
        GetContractsRegistryApiResponse,
        GetContractsRegistryApiArg
      >({
        query: () => ({ url: `/contracts-registry/` }),
        providesTags: ["contracts-registry"],
      }),
      deleteContractsRegistry: build.mutation<
        DeleteContractsRegistryApiResponse,
        DeleteContractsRegistryApiArg
      >({
        query: () => ({ url: `/contracts-registry/`, method: "DELETE" }),
        invalidatesTags: ["contracts-registry"],
      }),
      postContractsRegistryReloadSync: build.mutation<
        PostContractsRegistryReloadSyncApiResponse,
        PostContractsRegistryReloadSyncApiArg
      >({
        query: () => ({
          url: `/contracts-registry/reload-sync`,
          method: "POST",
        }),
        invalidatesTags: ["contracts-registry"],
      }),
      postContractsRegistryReloadAsync: build.mutation<
        PostContractsRegistryReloadAsyncApiResponse,
        PostContractsRegistryReloadAsyncApiArg
      >({
        query: () => ({
          url: `/contracts-registry/reload-async`,
          method: "POST",
        }),
        invalidatesTags: ["contracts-registry"],
      }),
      postConstants: build.mutation<
        PostConstantsApiResponse,
        PostConstantsApiArg
      >({
        query: (queryArg) => ({
          url: `/constants/`,
          method: "POST",
          body: queryArg.body,
        }),
        invalidatesTags: ["constant"],
      }),
      getConstants: build.query<GetConstantsApiResponse, GetConstantsApiArg>({
        query: (queryArg) => ({
          url: `/constants/`,
          params: {
            workspaceId: queryArg.workspaceId,
            workflowId: queryArg.workflowId,
          },
        }),
        providesTags: ["constant"],
      }),
      getConstantsByWorkspaceIdAndWorkflowIdKeyId: build.query<
        GetConstantsByWorkspaceIdAndWorkflowIdKeyIdApiResponse,
        GetConstantsByWorkspaceIdAndWorkflowIdKeyIdApiArg
      >({
        query: (queryArg) => ({
          url: `/constants/${queryArg.workspaceId}/${queryArg.workflowId}/${queryArg.keyId}`,
        }),
        providesTags: ["constant"],
      }),
      deleteConstantsByWorkspaceIdAndWorkflowIdKeyId: build.mutation<
        DeleteConstantsByWorkspaceIdAndWorkflowIdKeyIdApiResponse,
        DeleteConstantsByWorkspaceIdAndWorkflowIdKeyIdApiArg
      >({
        query: (queryArg) => ({
          url: `/constants/${queryArg.workspaceId}/${queryArg.workflowId}/${queryArg.keyId}`,
          method: "DELETE",
        }),
        invalidatesTags: ["constant"],
      }),
      patchConstantsByWorkspaceIdAndWorkflowIdKeyId: build.mutation<
        PatchConstantsByWorkspaceIdAndWorkflowIdKeyIdApiResponse,
        PatchConstantsByWorkspaceIdAndWorkflowIdKeyIdApiArg
      >({
        query: (queryArg) => ({
          url: `/constants/${queryArg.workspaceId}/${queryArg.workflowId}/${queryArg.keyId}`,
          method: "PATCH",
          body: queryArg.body,
        }),
        invalidatesTags: ["constant"],
      }),
      postWorkflows: build.mutation<
        PostWorkflowsApiResponse,
        PostWorkflowsApiArg
      >({
        query: (queryArg) => ({
          url: `/workflows/`,
          method: "POST",
          body: queryArg.body,
        }),
        invalidatesTags: ["workflow"],
      }),
      getWorkflows: build.query<GetWorkflowsApiResponse, GetWorkflowsApiArg>({
        query: () => ({ url: `/workflows/` }),
        providesTags: ["workflow"],
      }),
      getWorkflowsById: build.query<
        GetWorkflowsByIdApiResponse,
        GetWorkflowsByIdApiArg
      >({
        query: (queryArg) => ({ url: `/workflows/${queryArg.id}` }),
        providesTags: ["workflow"],
      }),
      deleteWorkflowsById: build.mutation<
        DeleteWorkflowsByIdApiResponse,
        DeleteWorkflowsByIdApiArg
      >({
        query: (queryArg) => ({
          url: `/workflows/${queryArg.id}`,
          method: "DELETE",
        }),
        invalidatesTags: ["workflow"],
      }),
      patchWorkflowsById: build.mutation<
        PatchWorkflowsByIdApiResponse,
        PatchWorkflowsByIdApiArg
      >({
        query: (queryArg) => ({
          url: `/workflows/${queryArg.id}`,
          method: "PATCH",
          body: queryArg.body,
        }),
        invalidatesTags: ["workflow"],
      }),
      postWorkspaces: build.mutation<
        PostWorkspacesApiResponse,
        PostWorkspacesApiArg
      >({
        query: (queryArg) => ({
          url: `/workspaces/`,
          method: "POST",
          body: queryArg.body,
        }),
        invalidatesTags: ["workspace"],
      }),
      getWorkspaces: build.query<GetWorkspacesApiResponse, GetWorkspacesApiArg>(
        {
          query: () => ({ url: `/workspaces/` }),
          providesTags: ["workspace"],
        },
      ),
      getWorkspacesById: build.query<
        GetWorkspacesByIdApiResponse,
        GetWorkspacesByIdApiArg
      >({
        query: (queryArg) => ({ url: `/workspaces/${queryArg.id}` }),
        providesTags: ["workspace"],
      }),
      deleteWorkspacesById: build.mutation<
        DeleteWorkspacesByIdApiResponse,
        DeleteWorkspacesByIdApiArg
      >({
        query: (queryArg) => ({
          url: `/workspaces/${queryArg.id}`,
          method: "DELETE",
        }),
        invalidatesTags: ["workspace"],
      }),
      patchWorkspacesById: build.mutation<
        PatchWorkspacesByIdApiResponse,
        PatchWorkspacesByIdApiArg
      >({
        query: (queryArg) => ({
          url: `/workspaces/${queryArg.id}`,
          method: "PATCH",
          body: queryArg.body,
        }),
        invalidatesTags: ["workspace"],
      }),
    }),
    overrideExisting: false,
  });
export { injectedRtkApi as rawboxApi };
export type GetContractsRegistryApiResponse =
  /** status 200 Default Response */ {
    contractsRegistryPath: string;
    contractsRecord:
      | (string | number | boolean | null)
      | any[]
      | {
          [key: string]: any;
        };
  }[];
export type GetContractsRegistryApiArg = void;
export type DeleteContractsRegistryApiResponse =
  /** status 200 Default Response */ {
    message: string;
  };
export type DeleteContractsRegistryApiArg = void;
export type PostContractsRegistryReloadSyncApiResponse =
  /** status 201 Default Response */ {
    message: string;
  };
export type PostContractsRegistryReloadSyncApiArg = void;
export type PostContractsRegistryReloadAsyncApiResponse =
  /** status 202 Default Response */ {
    message: string;
  };
export type PostContractsRegistryReloadAsyncApiArg = void;
export type PostConstantsApiResponse = /** status 201 Default Response */ {
  workflowId: string;
  workspaceId: string;
  keyId: string;
  value:
    | (string | number | boolean | null)
    | any[]
    | {
        [key: string]: any;
      };
};
export type PostConstantsApiArg = {
  body: {
    workflowId: string;
    workspaceId: string;
    keyId: string;
    value:
      | (string | number | boolean | null)
      | any[]
      | {
          [key: string]: any;
        };
  };
};
export type GetConstantsApiResponse = /** status 200 Default Response */ {
  workflowId: string;
  workspaceId: string;
  keyId: string;
  value:
    | (string | number | boolean | null)
    | any[]
    | {
        [key: string]: any;
      };
}[];
export type GetConstantsApiArg = {
  workspaceId?: string;
  workflowId?: string;
};
export type GetConstantsByWorkspaceIdAndWorkflowIdKeyIdApiResponse =
  /** status 200 Default Response */ {
    workflowId: string;
    workspaceId: string;
    keyId: string;
    value:
      | (string | number | boolean | null)
      | any[]
      | {
          [key: string]: any;
        };
  };
export type GetConstantsByWorkspaceIdAndWorkflowIdKeyIdApiArg = {
  workspaceId: string;
  workflowId: string;
  keyId: string;
};
export type DeleteConstantsByWorkspaceIdAndWorkflowIdKeyIdApiResponse =
  /** status 200 Default Response */ {
    message: string;
  };
export type DeleteConstantsByWorkspaceIdAndWorkflowIdKeyIdApiArg = {
  workspaceId: string;
  workflowId: string;
  keyId: string;
};
export type PatchConstantsByWorkspaceIdAndWorkflowIdKeyIdApiResponse =
  /** status 200 Default Response */ {
    workflowId: string;
    workspaceId: string;
    keyId: string;
    value:
      | (string | number | boolean | null)
      | any[]
      | {
          [key: string]: any;
        };
  };
export type PatchConstantsByWorkspaceIdAndWorkflowIdKeyIdApiArg = {
  workspaceId: string;
  workflowId: string;
  keyId: string;
  body: {
    value?:
      | (string | number | boolean | null)
      | any[]
      | {
          [key: string]: any;
        };
  };
};
export type PostWorkflowsApiResponse = /** status 201 Default Response */ {
  alias: string;
  id?: string;
  stepList:
    | (string | number | boolean | null)
    | any[]
    | {
        [key: string]: any;
      };
  workspaceId: string;
};
export type PostWorkflowsApiArg = {
  body: {
    alias: string;
    id?: string;
    stepList:
      | (string | number | boolean | null)
      | any[]
      | {
          [key: string]: any;
        };
    workspaceId: string;
  };
};
export type GetWorkflowsApiResponse = /** status 200 Default Response */ {
  alias: string;
  id: string;
  stepList:
    | (string | number | boolean | null)
    | any[]
    | {
        [key: string]: any;
      };
  workspaceId: string;
}[];
export type GetWorkflowsApiArg = void;
export type GetWorkflowsByIdApiResponse = /** status 200 Default Response */ {
  alias: string;
  id: string;
  stepList:
    | (string | number | boolean | null)
    | any[]
    | {
        [key: string]: any;
      };
  workspaceId: string;
};
export type GetWorkflowsByIdApiArg = {
  id: string;
};
export type DeleteWorkflowsByIdApiResponse =
  /** status 200 Default Response */ {
    message: string;
  };
export type DeleteWorkflowsByIdApiArg = {
  id: string;
};
export type PatchWorkflowsByIdApiResponse = /** status 200 Default Response */ {
  alias: string;
  id: string;
  stepList:
    | (string | number | boolean | null)
    | any[]
    | {
        [key: string]: any;
      };
  workspaceId: string;
};
export type PatchWorkflowsByIdApiArg = {
  id: string;
  body: {
    alias?: string;
    id?: string;
    stepList?:
      | (string | number | boolean | null)
      | any[]
      | {
          [key: string]: any;
        };
    workspaceId?: string;
  };
};
export type PostWorkspacesApiResponse = /** status 201 Default Response */ {
  alias: string;
  id: string;
};
export type PostWorkspacesApiArg = {
  body: {
    alias: string;
    id?: string;
  };
};
export type GetWorkspacesApiResponse = /** status 200 Default Response */ {
  alias: string;
  id: string;
}[];
export type GetWorkspacesApiArg = void;
export type GetWorkspacesByIdApiResponse = /** status 200 Default Response */ {
  alias: string;
  id: string;
};
export type GetWorkspacesByIdApiArg = {
  id: string;
};
export type DeleteWorkspacesByIdApiResponse =
  /** status 200 Default Response */ {
    message: string;
  };
export type DeleteWorkspacesByIdApiArg = {
  id: string;
};
export type PatchWorkspacesByIdApiResponse =
  /** status 200 Default Response */ {
    alias: string;
    id: string;
  };
export type PatchWorkspacesByIdApiArg = {
  id: string;
  body: {
    alias?: string;
    id?: string;
  };
};
export const {
  useGetContractsRegistryQuery,
  useDeleteContractsRegistryMutation,
  usePostContractsRegistryReloadSyncMutation,
  usePostContractsRegistryReloadAsyncMutation,
  usePostConstantsMutation,
  useGetConstantsQuery,
  useGetConstantsByWorkspaceIdAndWorkflowIdKeyIdQuery,
  useDeleteConstantsByWorkspaceIdAndWorkflowIdKeyIdMutation,
  usePatchConstantsByWorkspaceIdAndWorkflowIdKeyIdMutation,
  usePostWorkflowsMutation,
  useGetWorkflowsQuery,
  useGetWorkflowsByIdQuery,
  useDeleteWorkflowsByIdMutation,
  usePatchWorkflowsByIdMutation,
  usePostWorkspacesMutation,
  useGetWorkspacesQuery,
  useGetWorkspacesByIdQuery,
  useDeleteWorkspacesByIdMutation,
  usePatchWorkspacesByIdMutation,
} = injectedRtkApi;
