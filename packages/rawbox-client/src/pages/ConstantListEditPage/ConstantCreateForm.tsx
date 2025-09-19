import { FieldErrors, useForm } from "react-hook-form";
import { Static, Type } from "@sinclair/typebox";
import { toast } from "sonner";
import { typeboxResolver } from "@hookform/resolvers/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { useNavigate } from "react-router";

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
import { usePostConstantsMutation } from "@/redux/rawbox-api";

export interface ConstantCreateFormProps {
  workspaceId: string;
}

const FormSchema = Type.Object({
  workflowId: Type.String({ minLength: 1 }),
  workspaceId: Type.String({ minLength: 1 }),
  keyId: Type.String({ minLength: 1 }),
  value: Type.String({ minLength: 1 }),
});

type FormSchema = Static<typeof FormSchema>;

const formSchemaValidator = TypeCompiler.Compile(FormSchema);

export function ConstantCreateForm({ workspaceId }: ConstantCreateFormProps) {
  const navigate = useNavigate();
  const [createConstant, { isLoading }] = usePostConstantsMutation();

  const form = useForm<FormSchema>({
    resolver: typeboxResolver(formSchemaValidator),
    defaultValues: {
      workflowId: "",
      workspaceId,
      keyId: "",
      value: "",
    },
  });

  const onSubmit = async (inputs: FormSchema) => {
    try {
      const body = { ...inputs, value: JSON.parse(inputs.value) };
      await createConstant({ body }).unwrap();
      toast.success("Constant created successfully!");
      form.reset();
    } catch (error) {
      console.error("Failed to create constant:", error);
      if (error instanceof SyntaxError) {
        toast.error("Failed to create constant: Value is not valid JSON.");
      } else {
        toast.error("Failed to create constant. Please try again.");
      }
    }
  };

  const onInvalid = (errors: FieldErrors<FormSchema>) => {
    console.error("Form validation errors:", errors);
    toast.error("Form is invalid. Please check the console for details.");
  };

  const onCancel = () => {
    navigate("/WorkspaceListPage");
  };

  return (
    <>
      <div className="text-purple-600 ml-2 font-bold text-2xl mt-8">
        Constant creation
      </div>

      <div className="p-4">
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit, onInvalid)}
            className="mt-4 space-y-4"
          >
            <FormField
              control={form.control}
              name="workflowId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Workflow ID</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="keyId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Key ID</FormLabel>
                  <FormControl>
                    <Input {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="value"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Value (JSON string)</FormLabel>
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
