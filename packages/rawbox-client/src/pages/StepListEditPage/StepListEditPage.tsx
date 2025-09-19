import type { Step } from "rawbox-runner";
import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  useGetWorkflowsByIdQuery,
  usePatchWorkflowsByIdMutation,
} from "@/redux/rawbox-api";
import StepCreateSection from "./StepCreateSection";
import StepDndSection from "./StepDndSection";
import { type SortableRowProps } from "./SortableRow";
import { WorkflowDescription } from "./WorkflowDescription";

export default function StepListEditPage() {
  const { id: workflowId } = useParams<{ id: string }>();

  const [updateWorkflow, { isLoading: isSaving }] =
    usePatchWorkflowsByIdMutation();

  const {
    data: workflow,
    isLoading,
    isError,
    error,
  } = useGetWorkflowsByIdQuery({ id: workflowId! });

  const [sortableRowPropsList, setSortableRowPropsList] = useState<
    SortableRowProps[]
  >([]);

  useEffect(() => {
    if (workflow?.stepList && Array.isArray(workflow.stepList)) {
      const initialSteps = (workflow.stepList as Step[]).map((step, index) => ({
        step,
        id: index,
      }));
      setSortableRowPropsList(initialSteps);
    }
  }, [workflow]);

  const handleSave = async () => {
    if (!workflow) return;

    const stepList = sortableRowPropsList.map((prop) => prop.step);

    try {
      await updateWorkflow({
        id: workflow.id,
        body: {
          stepList,
        },
      }).unwrap();
      toast.success("Workflow saved successfully!");
    } catch (err) {
      toast.error("Failed to save workflow.");
      console.error(err);
    }
  };

  if (isLoading) {
    return <div>Loading...</div>;
  } else if (isError) {
    return <div>Error: {JSON.stringify(error)}</div>;
  } else if (workflow) {
    return (
      <>
        <div className="text-purple-600 ml-2 font-bold text-2xl">
          Step list edition
        </div>
        <WorkflowDescription workflow={workflow} />

        <div className="flex flex-col">
          <Button
            onClick={handleSave}
            disabled={isSaving}
            className="text-green-600 my-4"
          >
            {isSaving ? "Saving..." : "Save"}
          </Button>
          <Button
            type="submit"
            onClick={() => setSortableRowPropsList([])}
            className="text-red-600 mb-4"
          >
            Clear
          </Button>
        </div>

        <StepDndSection
          sortableRowPropsList={sortableRowPropsList}
          setSortableRowPropsList={setSortableRowPropsList}
        />
        <StepCreateSection setSortableRowPropsList={setSortableRowPropsList} />
      </>
    );
  } else {
    return <div>Workflow not found</div>;
  }
}
