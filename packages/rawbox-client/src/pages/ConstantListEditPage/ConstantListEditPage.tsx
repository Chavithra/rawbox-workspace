import { useParams } from "react-router";
import { toast } from "sonner";

import {
  useGetConstantsQuery,
  useGetWorkspacesByIdQuery,
  useDeleteConstantsByWorkspaceIdAndWorkflowIdKeyIdMutation,
} from "@/redux/rawbox-api";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { WorkspaceDescription } from "./WorkspaceDescription";
import { ConstantCreateForm } from "./ConstantCreateForm";

export default function ConstantListEditPage() {
  const { id: workspaceId } = useParams<{ id: string }>();

  const {
    data: workspace,
    isLoading: isWorkspaceLoading,
    isError: isWorkspaceError,
    error: workspaceError,
  } = useGetWorkspacesByIdQuery({ id: workspaceId! });

  const {
    data: constantList,
    isLoading: isConstantLoading,
    isError: isConstantError,
    error: constantError,
  } = useGetConstantsQuery({ workspaceId });

  const [deleteConstant, { isLoading: isDeleting }] =
    useDeleteConstantsByWorkspaceIdAndWorkflowIdKeyIdMutation();

  const handleDelete = async (workflowId: string, keyId: string) => {
    if (window.confirm("Are you sure you want to delete this constant?")) {
      try {
        await deleteConstant({
          workspaceId: workspaceId!,
          workflowId,
          keyId,
        }).unwrap();
        toast.success("Constant deleted successfully!");
      } catch (error) {
        console.error("Failed to delete constant:", error);
        toast.error("Failed to delete constant. Please try again.");
      }
    }
  };

  if (isConstantLoading || isWorkspaceLoading) {
    return <div>Loading constants...</div>;
  } else if (isConstantError) {
    return <div>Error: {JSON.stringify(constantError)}</div>;
  } else if (isWorkspaceError) {
    return <div>Error: {JSON.stringify(workspaceError)}</div>;
  } else if (constantList && workspace) {
    return (
      <>
        <div className="text-purple-600 ml-2 font-bold text-2xl">
          Constants edition
        </div>

        <WorkspaceDescription workspace={workspace} />

        {constantList.map((constant) => (
          <Card key={constant.keyId}>
            <CardHeader>
              <CardTitle>Constant Details</CardTitle>
            </CardHeader>
            <CardContent>
              <div>
                <p>Worklow Id: {constant.workflowId}</p>
                <p>Key Id: {constant.keyId}</p>
                <p>Value (JSON string): {JSON.stringify(constant.value)}</p>
              </div>
              <Button
                variant="destructive"
                size="sm"
                onClick={() =>
                  handleDelete(constant.workflowId, constant.keyId)
                }
                disabled={isDeleting}
                className="mt-4 text-red-600"
              >
                {isDeleting ? "Deleting..." : "Delete"}
              </Button>
            </CardContent>
          </Card>
        ))}

        <ConstantCreateForm workspaceId={workspace.id} />
      </>
    );
  } else {
    return <div>Something went wrong.</div>;
  }
}
