import { useNavigate, useParams } from "react-router";
import { useForm } from "react-hook-form";
import { useEffect } from "react";
import { typeboxResolver } from "@hookform/resolvers/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";

import {
  useDeleteWorkspacesByIdMutation,
  useGetWorkspacesByIdQuery,
  usePatchWorkspacesByIdMutation,
} from "@/redux/rawbox-api";
import { PatchWorkspacesByIdApiArg } from "@/typebox/rawbox-api-schemas";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const PatchWorkspacesByIdApiArgCheck = TypeCompiler.Compile(
  PatchWorkspacesByIdApiArg
);

export default function WorkspaceEditPage() {
  const { id: workspaceId } = useParams<{ id: string }>();
  const { data: workspace, isLoading: isWorkspaceLoading } =
    useGetWorkspacesByIdQuery({ id: workspaceId! }, { skip: !workspaceId });

  const [updateWorkspace, { isLoading }] = usePatchWorkspacesByIdMutation();
  const [deleteWorkspace, { isLoading: isDeleting }] =
    useDeleteWorkspacesByIdMutation();

  const {
    register,
    handleSubmit,
    formState: { errors },
    reset,
  } = useForm<PatchWorkspacesByIdApiArg>({
    resolver: typeboxResolver(PatchWorkspacesByIdApiArgCheck),
  });

  const navigate = useNavigate();

  useEffect(() => {
    if (workspace) {
      reset({
        id: workspaceId,
        body: {
          alias: workspace.alias,
        },
      });
    }
  }, [workspace, reset, workspaceId]);

  const onSubmit = async (inputs: PatchWorkspacesByIdApiArg) => {
    try {
      await updateWorkspace(inputs).unwrap();
      navigate("/WorkspaceListPage");
    } catch (error) {
      console.error("Failed to update workspace:", error);
      alert("Failed to update workspace. Please try again.");
    }
  };

  const onInvalid = (errors: object) => {
    console.error("Form validation errors:", errors);
    alert("Form is invalid. Please check the console for details.");
  };

  const onCancel = async () => {
    navigate("/WorkspaceListPage");
  };

  const onDelete = async () => {
    if (window.confirm("Are you sure you want to delete this workspace?")) {
      try {
        await deleteWorkspace({ id: workspaceId! }).unwrap();
        navigate("/WorkspaceListPage");
      } catch (error) {
        console.error("Failed to delete workspace:", error);
        alert("Failed to delete workspace. Please try again.");
      }
    }
  };

  if (isWorkspaceLoading) {
    return <div>Loading...</div>;
  }

  return (
    <>
      <div className="text-indigo-600 ml-2 font-bold text-2xl">
        Workspace edition
      </div>

      <div className="p-4">
        <h1 className="text-center text-lg font-medium">Workspace Edit Page</h1>
        <form
          onSubmit={handleSubmit(onSubmit, onInvalid)}
          className="mt-4 space-y-4"
        >
          <div>
            <Label htmlFor="id">Workspace Id</Label>
            <Input
              id="id"
              disabled
              type="text"
              {...register("id")}
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor="alias">Alias</Label>
            <Input id="alias" className="mt-1" {...register("body.alias")} />
            {errors.body?.alias && (
              <p className="mt-2 text-red-600">{errors.body.alias.message}</p>
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
              onClick={() => reset()}
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
