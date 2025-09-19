import { ColumnDef } from "@tanstack/react-table";

import { type GetContractsRegistryApiResponse } from "@/typebox/rawbox-api-schemas";

export const columns: ColumnDef<GetContractsRegistryApiResponse[number]>[] = [
  {
    accessorKey: "contractsRegistryPath",
    header: "Contracts Registry Path",
  },
  {
    accessorKey: "contractsRecord",
    header: "Contracts Registry Record",
    cell: ({ row }) => {
      const contracsRegistry = row.original;

      return (
        <>
          <span>{JSON.stringify(contracsRegistry.contractsRecord)}</span>
        </>
      );
    },
  },
];
