import { ColumnDef } from '@tanstack/react-table';

import { type GetContractRegistryApiResponse } from '@/typebox/rawbox-api-schemas';

export const columns: ColumnDef<GetContractRegistryApiResponse[number]>[] = [
  {
    accessorKey: 'ContractRegistryPath',
    header: 'Contracts Registry Path',
  },
  {
    accessorKey: 'ContractRecord',
    header: 'Contracts Registry Record',
    cell: ({ row }) => {
      const contracsRegistry = row.original;

      return (
        <>
          <span>{JSON.stringify(contracsRegistry.ContractRecord)}</span>
        </>
      );
    },
  },
];
