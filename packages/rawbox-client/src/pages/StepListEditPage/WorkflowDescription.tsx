import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { GetWorkflowsByIdApiResponse } from "@/redux/rawbox-api";

export interface WorkflowDescriptionProps {
  workflow: GetWorkflowsByIdApiResponse;
}

export function WorkflowDescription({ workflow }: WorkflowDescriptionProps) {
  return (
    <Card className="my-4 bg-purple-50">
      <CardHeader>
        <CardTitle>Workflow Details</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="font-medium text-gray-600">Id</dt>
          <dd className="font-mono text-gray-800">{workflow.id}</dd>

          <dt className="font-medium text-gray-600">Alias</dt>
          <dd className="text-gray-800">{workflow.alias}</dd>

          <dt className="font-medium text-gray-600">Workspace Id</dt>
          <dd className="font-mono text-gray-800">{workflow.workspaceId}</dd>
        </dl>
      </CardContent>
    </Card>
  );
}
