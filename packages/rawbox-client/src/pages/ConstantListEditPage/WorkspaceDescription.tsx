import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { GetWorkspacesByIdApiResponse } from "@/redux/rawbox-api";

export interface WorkspaceDescriptionProps {
  workspace: GetWorkspacesByIdApiResponse;
}

export function WorkspaceDescription({ workspace }: WorkspaceDescriptionProps) {
  return (
    <Card className="my-4 bg-purple-50">
      <CardHeader>
        <CardTitle>Workspace Details</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="font-medium text-gray-600">Id</dt>
          <dd className="font-mono text-gray-800">{workspace.id}</dd>

          <dt className="font-medium text-gray-600">Alias</dt>
          <dd className="text-gray-800">{workspace.alias}</dd>
        </dl>
      </CardContent>
    </Card>
  );
}
