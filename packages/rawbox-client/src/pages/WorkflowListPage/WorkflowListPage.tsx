import { useMemo } from "react";
import { useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import { columns, type WorkflowForList } from "./columns";
import { DataTable } from "@/components/ui/data-table";
import {
  useGetWorkflowsQuery,
  useGetWorkspacesQuery,
} from "@/redux/rawbox-api";

export default function WorkflowListPage() {
  const {
    data: workflowList,
    isLoading: isLoadingWorkflows,
    isError: isErrorWorkflows,
    error: errorWorkflows,
  } = useGetWorkflowsQuery();
  const {
    data: workspaceList,
    isLoading: isLoadingWorkspaces,
    isError: isErrorWorkspaces,
    error: errorWorkspaces,
  } = useGetWorkspacesQuery();

  const navigate = useNavigate();

  const data: WorkflowForList[] = useMemo(() => {
    if (!workflowList) {
      return [];
    }
    if (!workspaceList) {
      return workflowList;
    }
    const workspacesMap = new Map(workspaceList.map((ws) => [ws.id, ws.alias]));
    return workflowList.map((workflow) => ({
      ...workflow,
      workspaceAlias:
        workspacesMap.get(workflow.workspaceId) || workflow.workspaceId,
    }));
  }, [workflowList, workspaceList]);

  if (isLoadingWorkflows || isLoadingWorkspaces) {
    return <div>Loading workflows...</div>;
  } else if (isErrorWorkflows || isErrorWorkspaces) {
    return (
      <div>Error: {JSON.stringify(errorWorkflows || errorWorkspaces)}</div>
    );
  } else if (workflowList) {
    return (
      <>
        <div className="text-indigo-600 ml-2 font-bold text-2xl">
          Workflows listing
        </div>

        <div className="my-2">
          <Button
            onClick={() => navigate("/WorkflowCreatePage")}
            className="w-full text-indigo-600"
          >
            Create Workflow
          </Button>
        </div>

        <div>
          <DataTable columns={columns} data={data} />
        </div>
      </>
    );
  } else {
    return <div>Error: Something went wrong</div>;
  }
}
