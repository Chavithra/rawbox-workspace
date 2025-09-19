import { Button } from "@/components/ui/button";
import { columns } from "./columns";
import { DataTable } from "@/components/ui/data-table";

import { useGetWorkspacesQuery } from "@/redux/rawbox-api";
import { useNavigate } from "react-router";

export default function WorkspaceListPage() {
  const {
    data: workspaces,
    isLoading,
    isError,
    error,
  } = useGetWorkspacesQuery();

  const navigate = useNavigate();

  if (isLoading) {
    return <div>Loading workspaces...</div>;
  } else if (isError) {
    return <div>Error: {JSON.stringify(error)}</div>;
  } else if (workspaces) {
    return (
      <>
        <div className="text-indigo-600 ml-2 font-bold text-2xl">
          Workspaces listing
        </div>

        <div className="my-2">
          <Button
            onClick={() => navigate("/WorkspaceCreatePage")}
            className="w-full text-indigo-600"
          >
            Create Workspace
          </Button>
        </div>

        <div>
          <DataTable columns={columns} data={workspaces} />
        </div>
      </>
    );
  } else {
    return <div>Error: Something went wrong</div>;
  }
}
