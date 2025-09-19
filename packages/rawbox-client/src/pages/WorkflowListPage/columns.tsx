import { ColumnDef } from "@tanstack/react-table";
import { Link } from "react-router";

import { Button } from "@/components/ui/button";
import { rawboxApi } from "@/redux/rawbox-api";
import { store } from "@/redux/store";
import { type GetWorkflowsApiResponse } from "@/typebox/rawbox-api-schemas";

export type WorkflowForList = GetWorkflowsApiResponse[number] & {
  workspaceAlias?: string;
};

const onDeleteFactory = (id: string) => async () => {
  if (window.confirm("Are you sure you want to delete this workflow?")) {
    try {
      await store
        .dispatch(rawboxApi.endpoints.deleteWorkflowsById.initiate({ id }))
        .unwrap();
    } catch (error) {
      console.error("Failed to delete workflow:", error);
      alert("Failed to delete workflow. Please try again.");
    }
  }
};

export const columns: ColumnDef<WorkflowForList>[] = [
  {
    accessorKey: "id",
    header: "Id",
  },
  {
    accessorKey: "workspaceAlias",
    header: "Workspace alias",
  },
  {
    accessorKey: "alias",
    header: "Alias",
  },
  {
    id: "actions",
    header: "Actions",
    cell: ({ row }) => {
      const workflow = row.original;

      return (
        <>
          <div className="flex space-x-2">
            <Button asChild variant="outline" size="sm">
              <Link to={`/StepListEditPage/${workflow.id}`}>
                <span className="text-purple-600">Steps</span>
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to={`/WorkflowEditPage/${workflow.id}`}>
                <span className="text-indigo-600">Edit</span>
              </Link>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={onDeleteFactory(workflow.id)}
              className="text-red-600"
            >
              Delete
            </Button>
          </div>
        </>
      );
    },
  },
];
