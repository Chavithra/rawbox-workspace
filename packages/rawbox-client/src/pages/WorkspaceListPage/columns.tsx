import type { ColumnDef } from "@tanstack/react-table";
import { Link } from "react-router";

import { Button } from "@/components/ui/button";
import { rawboxApi } from "@/redux/rawbox-api";
import { store } from "@/redux/store";
import { type GetWorkspacesApiResponse } from "@/redux/rawbox-api";

const onDeleteFactory = (id: string) => async () => {
  if (window.confirm("Are you sure you want to delete this workspace?")) {
    try {
      await store
        .dispatch(rawboxApi.endpoints.deleteWorkspacesById.initiate({ id }))
        .unwrap();
    } catch (error) {
      console.error("Failed to delete workspace:", error);
      alert("Failed to delete workspace. Please try again.");
    }
  }
};

export const columns: ColumnDef<GetWorkspacesApiResponse[number]>[] = [
  {
    accessorKey: "id",
    header: "Id",
  },
  {
    accessorKey: "alias",
    header: "Alias",
  },
  {
    id: "actions",
    header: "Actions",
    cell: ({ row }) => {
      const workspace = row.original;

      return (
        <>
          <div className="flex space-x-2">
            <Button asChild variant="outline" size="sm">
              <Link to={`/ConstantListEditPage/${workspace.id}`}>
                <span className="text-purple-600">Constants</span>
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to={`/WorkspaceEditPage/${workspace.id}`}>Edit</Link>
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={onDeleteFactory(workspace.id)}
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
