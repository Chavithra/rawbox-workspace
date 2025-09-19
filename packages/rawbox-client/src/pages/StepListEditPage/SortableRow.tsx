import * as React from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle,
  ChevronsUpDown,
} from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { BoxLocationRecord, Step } from "rawbox-runner";

export interface SortableRowProps {
  step: Step;
  id: number;
}

interface LocationRecordDisplayProps {
  title: string;
  record: BoxLocationRecord;
  icon: React.ReactNode;
  colorClass: string;
}

function LocationRecordDisplay({
  title,
  record,
  icon,
  colorClass,
}: LocationRecordDisplayProps) {
  const entries = Object.entries(record || {});
  if (entries.length === 0) {
    return null;
  }

  return (
    <div className="mt-4">
      <h4 className={`flex items-center text-md font-semibold ${colorClass}`}>
        {icon}
        <span className="ml-2">{title}</span>
      </h4>
      <div className="mt-2 pl-4 border-l-2 border-gray-200 ml-2">
        <dl className="grid grid-cols-[150px_1fr] gap-x-4 gap-y-1 text-sm">
          {entries.map(([key, value]) =>
            value ? (
              <React.Fragment key={key}>
                <dt className="font-medium text-gray-600 truncate">{key}</dt>
                <dd className="font-mono text-gray-800 break-all">
                  {value.key.id}
                </dd>
              </React.Fragment>
            ) : null
          )}
        </dl>
      </div>
    </div>
  );
}

export function SortableRow(props: SortableRowProps) {
  const { step, id } = props;
  const { attributes, listeners, setNodeRef, transform, transition } =
    useSortable({ id: id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const {
    definitionLocation,
    stepLabel,
    errorLocationRecord,
    inputLocationRecord,
    outputLocationRecord,
  } = step;
  const { definitionPath, contractsRegistryPath } = definitionLocation;

  return (
    <div ref={setNodeRef} style={style} {...attributes}>
      <Card className="my-2 shadow-sm hover:shadow-md transition-shadow">
        <CardHeader className="-mt-5 flex flex-row items-start justify-between bg-gray-50/50 border-b">
          <div className="flex-1 mr-4">
            <CardTitle className="text-lg font-semibold text-purple-600">
              {stepLabel ? (
                <span>
                  {`Step ${id + 1}`} - {stepLabel}
                </span>
              ) : (
                <span>{`Step ${id + 1}`}</span>
              )}
              {stepLabel && <span></span>}
            </CardTitle>
            <CardDescription className="font-mono text-xs mt-1 break-all">
              Operation: {definitionPath}
            </CardDescription>
            <CardDescription className="font-mono text-xs mt-1 text-gray-500 break-all">
              Registry Path: {contractsRegistryPath}
            </CardDescription>
          </div>
          <div
            {...listeners}
            className="p-2 cursor-grab rounded-md hover:bg-gray-200 active:cursor-grabbing"
          >
            <ChevronsUpDown className="h-5 w-5 text-gray-500" />
          </div>
        </CardHeader>
        <CardContent className="-mt-6">
          <LocationRecordDisplay
            title="Inputs"
            record={inputLocationRecord}
            icon={<ArrowRight className="h-4 w-4" />}
            colorClass="text-emerald-600"
          />
          <LocationRecordDisplay
            title="Outputs"
            record={outputLocationRecord}
            icon={<CheckCircle className="h-4 w-4" />}
            colorClass="text-yellow-600"
          />
          <LocationRecordDisplay
            title="Errors"
            record={errorLocationRecord}
            icon={<AlertTriangle className="h-4 w-4" />}
            colorClass="text-red-600"
          />
        </CardContent>
      </Card>
    </div>
  );
}
