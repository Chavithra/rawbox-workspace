import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { columns } from './columns';
import { DataTable } from '@/components/ui/data-table';
import {
  useGetContractRegistryQuery,
  usePostContractRegistryReloadSyncMutation,
  useDeleteContractRegistryMutation,
} from '@/redux/rawbox-api';

export default function ContractRegistryListPage() {
  const {
    data: ContractRegistryList,
    isLoading,
    isError,
    error,
  } = useGetContractRegistryQuery();

  const [contractsRegistriesReloadSync, { isLoading: isReloadLoading }] =
    usePostContractRegistryReloadSyncMutation();

  const [deleteAllContracts, { isLoading: isDeleteLoading }] =
    useDeleteContractRegistryMutation();

  function handleReload() {
    toast.promise(contractsRegistriesReloadSync().unwrap(), {
      loading: 'Reloading contracts registry...',
      success: 'Contracts registry reloaded successfully!',
      error: 'Failed to reload contracts registry.',
    });
  }

  function handleDeleteAll() {
    toast.promise(deleteAllContracts().unwrap(), {
      loading: 'Deleting all contracts...',
      success: 'All contracts deleted successfully!',
      error: 'Failed to delete all contracts.',
    });
  }

  if (isLoading) {
    return <div>Loading...</div>;
  } else if (isError) {
    return <div>Error: {JSON.stringify(error)}</div>;
  } else if (ContractRegistryList) {
    return (
      <>
        <div className="text-indigo-600 ml-2 font-bold text-2xl">
          Contracts Registry listing
        </div>

        <div className="my-2">
          <Button
            variant="destructive"
            disabled={isDeleteLoading}
            onClick={handleDeleteAll}
            className="w-full text-red-600 my-2"
          >
            Delete all
          </Button>
          <Button
            disabled={isReloadLoading}
            onClick={handleReload}
            className="w-full text-indigo-600"
          >
            Reload
          </Button>
        </div>
        <div>
          <DataTable columns={columns} data={ContractRegistryList} />
        </div>
      </>
    );
  } else {
    return <div>Error: Something went wrong</div>;
  }
}
