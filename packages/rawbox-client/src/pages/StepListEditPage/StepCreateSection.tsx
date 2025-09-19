import { useMemo } from "react";

import { useGetContractsRegistryQuery } from "@/redux/rawbox-api";

import {
  ContractsRecord,
  ContractsRecordsMap,
  StepCreateForm,
} from "./StepCreateForm";
import { SortableRowProps } from "./SortableRow";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface StepCreateSectionProps {
  setSortableRowPropsList: React.Dispatch<
    React.SetStateAction<SortableRowProps[]>
  >;
}

export default function StepCreateSection({
  setSortableRowPropsList,
}: StepCreateSectionProps) {
  const {
    data: contractsRegistryList,
    isLoading,
    isError,
    error,
  } = useGetContractsRegistryQuery();

  const contractsRecordMap = useMemo(() => {
    if (contractsRegistryList) {
      return contractsRegistryList.reduce<ContractsRecordsMap>((acc, item) => {
        acc[item.contractsRegistryPath] = item as ContractsRecord;
        return acc;
      }, {});
    } else {
      return {};
    }
  }, [contractsRegistryList]);

  if (isLoading) {
    return <div>Loading...</div>;
  } else if (isError) {
    return <div>Error: {JSON.stringify(error)}</div>;
  } else if (contractsRegistryList) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>New Step</CardTitle>
        </CardHeader>
        <CardContent>
          <StepCreateForm
            contractsRecordMap={contractsRecordMap}
            setSortableRowPropsList={setSortableRowPropsList}
          />
        </CardContent>
      </Card>
    );
  }
}
