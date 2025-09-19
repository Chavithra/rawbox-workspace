import { typeboxResolver } from "@hookform/resolvers/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { FieldErrors, useForm } from "react-hook-form";
import { useNavigate } from "react-router";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { PostWorkflowsApiArg } from "@/typebox/rawbox-api-schemas";
import { usePostWorkflowsMutation } from "@/redux/rawbox-api";
import { WorkspacesComboboxForm } from "./WorkspacesComboboxForm";

const PostWorkflowsApiArgValidator = TypeCompiler.Compile(PostWorkflowsApiArg);

export default function WorkflowCreatePage() {
  const navigate = useNavigate();
  const [createWorkflow, { isLoading }] = usePostWorkflowsMutation();
  const form = useForm<PostWorkflowsApiArg>({
    resolver: typeboxResolver(PostWorkflowsApiArgValidator),
    defaultValues: {
      body: {
        alias: "",
        workspaceId: "",
        stepList: [],
      },
    },
  });

  const onSubmit = async (inputs: PostWorkflowsApiArg) => {
    try {
      await createWorkflow(inputs).unwrap();
      toast.success("Workflow created successfully!");
      navigate("/WorkflowListPage");
    } catch (error) {
      console.error("Failed to create workflow:", error);
      toast.error("Failed to create workflow. Please try again.");
    }
  };

  const onInvalid = (errors: FieldErrors<PostWorkflowsApiArg>) => {
    console.error("Form validation errors:", errors);
    toast.error("Form is invalid. Please check the console for details.");
  };

  const onCancel = () => {
    navigate("/WorkflowListPage");
  };

  return (
    <>
      <div className="text-indigo-600 ml-2 font-bold text-2xl">
        Workflow creation
      </div>

      <div className="p-4">
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit, onInvalid)}
            className="mt-4 space-y-4"
          >
            <WorkspacesComboboxForm control={form.control} />
            <FormField
              control={form.control}
              name="body.alias"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Alias</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

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
                onClick={() => form.reset()}
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
        </Form>
      </div>
    </>
  );
}
