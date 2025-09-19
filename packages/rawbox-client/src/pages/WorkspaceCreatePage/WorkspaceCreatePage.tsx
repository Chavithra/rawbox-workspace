import { useNavigate } from "react-router";
import { useForm } from "react-hook-form";
import { typeboxResolver } from "@hookform/resolvers/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PostWorkspacesApiArg } from "@/typebox/rawbox-api-schemas";
import { usePostWorkspacesMutation } from "@/redux/rawbox-api";

const PostWorkspacesApiArgCheck = TypeCompiler.Compile(PostWorkspacesApiArg);

export default function WorkspaceCreatePage() {
  const [createWorkspace, { isLoading }] = usePostWorkspacesMutation();
  const {
    register,
    handleSubmit,
    formState: { errors },
    reset,
  } = useForm<PostWorkspacesApiArg>({
    resolver: typeboxResolver(PostWorkspacesApiArgCheck),
    defaultValues: {
      body: {
        alias: "",
      },
    },
  });

  const navigate = useNavigate();

  const onSuccess = async (inputs: PostWorkspacesApiArg) => {
    try {
      await createWorkspace(inputs).unwrap();
      navigate("/WorkspaceListPage");
    } catch (error) {
      console.error("Failed to create workspace:", error);
      alert("Failed to create workspace. Please try again.");
    }
  };

  const onInvalid = (errors: object) => {
    console.error("Form validation errors:", errors);
    alert("Form is invalid. Please check the console for details.");
  };

  const onCancel = async () => {
    navigate("/WorkspaceListPage");
  };

  return (
    <>
      <div className="text-indigo-600 ml-2 font-bold text-2xl">
        Workspace creation
      </div>

      <div className="p-4">
        <h1 className="text-center text-lg font-medium">
          Workspace Create Page
        </h1>
        <form
          onSubmit={handleSubmit(onSuccess, onInvalid)}
          className="mt-4 space-y-4"
        >
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
              disabled={isLoading}
              className="text-indigo-600"
            >
              {isLoading ? "Creating..." : "Create"}
            </Button>

            <Button
              variant="outline"
              type="button"
              onClick={() => reset()}
              disabled={isLoading}
              className="text-gray-600"
            >
              Reset
            </Button>

            <Button
              variant="destructive"
              type="button"
              onClick={onCancel}
              disabled={isLoading}
              className="text-amber-600"
            >
              Cancel
            </Button>
          </div>
        </form>
      </div>
    </>
  );
}
