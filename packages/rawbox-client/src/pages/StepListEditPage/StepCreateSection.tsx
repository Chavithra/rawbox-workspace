import { useMemo } from 'react';

import { useGetContractRegistryQuery } from '@/redux/rawbox-api';

import {
  contractRecord,
  ContractRecordsMap,
  StepCreateForm,
} from './StepCreateForm';
import { SortableRowProps } from './SortableRow';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface StepCreateSectionProps {
  setSortableRowPropsList: React.Dispatch<
    React.SetStateAction<SortableRowProps[]>
  >;
}

export default function StepCreateSection({
  setSortableRowPropsList,
}: StepCreateSectionProps) {
  const {
    data: ContractRegistryList,
    isLoading,
    isError,
    error,
  } = useGetContractRegistryQuery();

  const ContractRecordMap = useMemo(() => {
    if (ContractRegistryList) {
      return ContractRegistryList.reduce<ContractRecordsMap>((acc, item) => {
        acc[item.ContractRegistryPath] = item as ContractRecord;
        return acc;
      }, {});
    } else {
      return {};
    }
  }, [ContractRegistryList]);

  if (isLoading) {
    return <div>Loading...</div>;
  } else if (isError) {
    return <div>Error: {JSON.stringify(error)}</div>;
  } else if (ContractRegistryList) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>New Step</CardTitle>
        </CardHeader>
        <CardContent>
          <StepCreateForm
            ContractRecordMap={ContractRecordMap}
            setSortableRowPropsList={setSortableRowPropsList}
          />
        </CardContent>
      </Card>
    );
  }
}
