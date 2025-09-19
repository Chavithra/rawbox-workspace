import { Check, ChevronsUpDown } from "lucide-react";
import { useMemo, useState } from "react";
import { Control } from "react-hook-form";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

import {
  PostWorkflowsApiArg,
  GetWorkspacesApiResponse,
} from "@/typebox/rawbox-api-schemas";
import { useGetWorkspacesQuery } from "@/redux/rawbox-api";

interface WorkspacesComboboxProps {
  control: Control<PostWorkflowsApiArg>;
}

export function WorkspacesComboboxForm({ control }: WorkspacesComboboxProps) {
  const { data: workspaces } = useGetWorkspacesQuery();
  const workspaceOptions = useMemo(
    () =>
      workspaces?.map((workspaceItem: GetWorkspacesApiResponse[number]) => ({
        label: workspaceItem.alias,
        value: workspaceItem.id,
      })) ?? [],
    [workspaces]
  );

  const [open, setOpen] = useState(false);

  return (
    <FormField
      control={control}
      name="body.workspaceId"
      render={({ field }) => (
        <FormItem className="flex flex-col">
          <FormLabel>Workspace</FormLabel>
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <FormControl>
                <Button
                  variant="outline"
                  role="combobox"
                  className={cn(
                    "w-[200px] justify-between",
                    !field.value && "text-muted-foreground"
                  )}
                >
                  {field.value
                    ? workspaceOptions.find(
                        (workspace) => workspace.value === field.value
                      )?.label
                    : "Select workspace"}
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </FormControl>
            </PopoverTrigger>
            <PopoverContent className="w-[200px] p-0">
              <Command>
                <CommandInput placeholder="Search workspace..." />
                <CommandList>
                  <CommandEmpty>No workspace found.</CommandEmpty>
                  <CommandGroup>
                    {workspaceOptions.map((workspace) => (
                      <CommandItem
                        value={workspace.label}
                        key={workspace.value}
                        onSelect={() => {
                          field.onChange(workspace.value);
                          setOpen(false);
                        }}
                      >
                        <Check
                          className={cn(
                            "mr-2 h-4 w-4",
                            workspace.value === field.value
                              ? "opacity-100"
                              : "opacity-0"
                          )}
                        />
                        {workspace.label}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
          <FormDescription>
            This is the workspace that will be used for the workflow.
          </FormDescription>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
