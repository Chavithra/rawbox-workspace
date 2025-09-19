import { useNavigate, useParams } from "react-router";
import { useForm } from "react-hook-form";
import { useEffect } from "react";
import { typeboxResolver } from "@hookform/resolvers/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";

import {
  useDeleteWorkflowsByIdMutation,
  useGetWorkflowsByIdQuery,
  usePatchWorkflowsByIdMutation,
} from "@/redux/rawbox-api";
import { PatchWorkflowsByIdApiArg } from "@/typebox/rawbox-api-schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const PatchWorkflowsByIdApiArgCheck = TypeCompiler.Compile(
  PatchWorkflowsByIdApiArg
);

export default function WorkflowEditPage() {
  const { id: workflowId } = useParams<{ id: string }>();
  const { data: workflow, isLoading: isWorkflowLoading } =
    useGetWorkflowsByIdQuery({ id: workflowId! }, { skip: !workflowId });

  const [updateWorkflow, { isLoading }] = usePatchWorkflowsByIdMutation();
  const [deleteWorkflow, { isLoading: isDeleting }] =
    useDeleteWorkflowsByIdMutation();

  const form = useForm<PatchWorkflowsByIdApiArg>({
    resolver: typeboxResolver(PatchWorkflowsByIdApiArgCheck),
  });

  const navigate = useNavigate();

  useEffect(() => {
    if (workflow) {
      form.reset({
        id: workflowId,
        body: {
          alias: workflow.alias,
        },
      });
    }
  }, [workflow, form, workflowId]);

  const onSubmit = async (inputs: PatchWorkflowsByIdApiArg) => {
    try {
      await updateWorkflow(inputs).unwrap();
      navigate("/WorkflowListPage");
    } catch (error) {
      console.error("Failed to update workflow:", error);
      alert("Failed to update workflow. Please try again.");
    }
  };

  const onInvalid = (errors: object) => {
    console.error("Form validation errors:", errors);
    alert("Form is invalid. Please check the console for details.");
  };

  const onCancel = async () => {
    navigate("/WorkflowListPage");
  };

  const onDelete = async () => {
    if (window.confirm("Are you sure you want to delete this workflow?")) {
      try {
        await deleteWorkflow({ id: workflowId! }).unwrap();
        navigate("/WorkflowListPage");
      } catch (error) {
        console.error("Failed to delete workflow:", error);
        alert("Failed to delete workflow. Please try again.");
      }
    }
  };

  if (isWorkflowLoading) {
    return <div>Loading...</div>;
  }

  return (
    <>
      <div className="text-indigo-600 ml-2 font-bold text-2xl">
        Workflow edition
      </div>

      <div className="p-4">
        <h1 className="text-center text-lg font-medium">Workflow Edit Page</h1>
        <form
          onSubmit={form.handleSubmit(onSubmit, onInvalid)}
          className="mt-4 space-y-4"
        >
          <div>
            <div>Workflow Id</div>
            <div className="text-gray-400">{workflow?.id}</div>
          </div>
          <div>
            <div>Workspace Id</div>
            <div className="text-gray-400">{workflow?.workspaceId}</div>
          </div>
          <div>
            <Label htmlFor="alias">Alias</Label>
            <Input
              id="alias"
              className="mt-1"
              {...form.register("body.alias")}
            />
            {form.formState.errors.body?.alias && (
              <p className="mt-2 text-red-600">
                {form.formState.errors.body.alias.message}
              </p>
            )}
          </div>

          <div className="flex flex-col space-y-4 gap-2">
            <Button
              type="submit"
              disabled={isLoading || isDeleting}
              className="text-indigo-600"
            >
              {isLoading ? "Editing..." : "Edit"}
            </Button>

            <Button
              variant="outline"
              type="button"
              onClick={() => form.reset()}
              disabled={isLoading || isDeleting}
              className="text-gray-600"
            >
              Reset
            </Button>

            <Button
              variant="outline"
              type="button"
              onClick={onCancel}
              disabled={isLoading || isDeleting}
              className="text-amber-600"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              type="button"
              onClick={onDelete}
              disabled={isLoading || isDeleting}
              className="text-red-600"
            >
              {isDeleting ? "Deleting..." : "Delete"}
            </Button>
          </div>
        </form>
      </div>
    </>
  );
}
