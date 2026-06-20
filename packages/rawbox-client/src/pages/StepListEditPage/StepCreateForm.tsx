import { toast } from 'sonner';
import { Type, type Static } from 'typebox';
import { typeboxResolver } from '@hookform/resolvers/typebox';
import { TypeCompiler } from 'typebox/compile';
import { useEffect, useMemo } from 'react';
import { useForm, type FieldErrors } from 'react-hook-form';

import { type BoxLocationRecord, type Step } from 'rawbox-runner';
import { ControlFlowContract } from 'rawbox-default-plugins/control-flow-definition';
import { OperationContract } from 'rawbox-plugin/operation-definition';

import { Button } from '@/components/ui/button';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SortableRowProps } from './SortableRow';

export interface ContractRecord {
  contractRegistryPath: string;
  contractRecord: Record<string, OperationContract | ControlFlowContract>;
}

export type ContractRecordsMap = Record<string, ContractRecord>;

export const BaseDefinitionLocation = Type.Object({
  contractRegistryPath: Type.String({ minLength: 1 }),
  definitionPath: Type.String({ minLength: 1 }),
});

const LocationRecord = Type.Record(Type.String(), Type.String());
type LocationRecord = Static<typeof LocationRecord>;

export const BaseFormSchema = Type.Object({
  definitionLocation: BaseDefinitionLocation,
  errorBoxLocationRecord: LocationRecord,
  inputBoxLocationRecord: LocationRecord,
  outputBoxLocationRecord: LocationRecord,
  stepLabel: Type.Optional(Type.String()),
});
export type BaseFormSchema = Static<typeof BaseFormSchema>;

interface StepCreateFormProps {
  ContractRecordMap: ContractRecordsMap;
  setSortableRowPropsList: React.Dispatch<
    React.SetStateAction<SortableRowProps[]>
  >;
}

function convertToBoxLocationRecord(
  locationRecord: LocationRecord,
): BoxLocationRecord {
  return Object.entries(locationRecord).reduce(
    (acc, [parameterName, BoxLocationKeyId]) => {
      if (BoxLocationKeyId) {
        acc[parameterName] = {
          key: Number(BoxLocationKeyId),
          workflow: 'dbi1',
          workspace: 'env1',
          strategy: { name: 'lmdb-kv', valueSizeMax: 1024 },
        };
      }
      return acc;
    },
    {} as BoxLocationRecord,
  );
}

export function StepCreateForm({
  ContractRecordMap,
  setSortableRowPropsList,
}: StepCreateFormProps) {
  const formSchemaValidator = TypeCompiler.Compile(BaseFormSchema);
  const form = useForm<BaseFormSchema>({
    resolver: typeboxResolver(formSchemaValidator),
    defaultValues: {
      definitionLocation: {
        contractRegistryPath: '',
        definitionPath: '',
      },
      inputBoxLocationRecord: {},
      outputBoxLocationRecord: {},
      errorBoxLocationRecord: {},
      stepLabel: undefined,
    },
  });

  const { resetField } = form;
  const ContractRegistryPathValue = form.watch(
    'definitionLocation.ContractRegistryPath',
  );
  const definitionPathValue = form.watch('definitionLocation.definitionPath');

  const definitionPathOptions = useMemo(() => {
    const ContractRecord =
      ContractRecordMap[ContractRegistryPathValue]?.ContractRecord;

    if (ContractRecord && typeof ContractRecord === 'object') {
      return Object.keys(ContractRecord);
    }

    return [];
  }, [ContractRegistryPathValue, ContractRecordMap]);

  const inputLocationNameList = useMemo(() => {
    let result: string[];

    const contract =
      ContractRecordMap[ContractRegistryPathValue]?.ContractRecord[
        definitionPathValue
      ];

    const inputSchema = contract?.inputSchema;
    if (inputSchema) {
      result = Object.keys(inputSchema.properties);
    } else {
      result = [];
    }

    return result;
  }, [ContractRegistryPathValue, ContractRecordMap, definitionPathValue]);

  const outputLocationNameList = useMemo(() => {
    let result: string[];

    const contract =
      ContractRecordMap[ContractRegistryPathValue]?.ContractRecord[
        definitionPathValue
      ];

    if (contract && contract.type == 'operation') {
      const outputSchema = contract.outputSchema;
      result = Object.keys(outputSchema.properties);
    } else {
      result = [];
    }

    return result;
  }, [ContractRecordMap, ContractRegistryPathValue, definitionPathValue]);

  const errorLocationNameList = useMemo(() => {
    let result: string[];

    const contract =
      ContractRecordMap[ContractRegistryPathValue]?.ContractRecord[
        definitionPathValue
      ];

    const errorSchema = contract?.errorSchema;
    if (errorSchema) {
      result = Object.keys(errorSchema.properties);
    } else {
      result = [];
    }

    return result;
  }, [ContractRecordMap, ContractRegistryPathValue, definitionPathValue]);

  useEffect(() => {
    resetField('definitionLocation.definitionPath', { defaultValue: '' });
    resetField('inputBoxLocationRecord', { defaultValue: {} });
    resetField('outputBoxLocationRecord', { defaultValue: {} });
    resetField('errorBoxLocationRecord', { defaultValue: {} });
    resetField('stepLabel', { defaultValue: undefined });
  }, [ContractRegistryPathValue, resetField]);

  const onInvalid = (e: FieldErrors<BaseFormSchema>) => {
    console.log(e);
    toast.error('Form is invalid. Please check the fields and try again.');
  };

  const onReset = () => {
    form.reset();
  };

  const onSubmit = async (inputs: BaseFormSchema) => {
    const {
      definitionLocation,
      inputBoxLocationRecord,
      outputBoxLocationRecord,
      errorBoxLocationRecord,
      stepLabel,
    } = inputs;

    const step: Step = {
      definitionLocation,
      inputBoxLocationRecord: convertToBoxLocationRecord(
        inputBoxLocationRecord,
      ),
      outputBoxLocationRecord: convertToBoxLocationRecord(
        outputBoxLocationRecord,
      ),
      errorBoxLocationRecord: convertToBoxLocationRecord(
        errorBoxLocationRecord,
      ),
      stepLabel,
    };

    setSortableRowPropsList((sortableRowPropsList) => [
      ...sortableRowPropsList,
      {
        step,
        id: sortableRowPropsList.length,
      },
    ]);

    console.log('inputs', inputs);
    console.log('step', step);

    toast.success('Step created successfully!');
    form.reset();
  };

  return (
    <>
      <Form {...form}>
        <form
          onSubmit={form.handleSubmit(onSubmit, onInvalid)}
          className="mt-4 space-y-4"
        >
          <FormField
            control={form.control}
            name="definitionLocation.ContractRegistryPath"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Contracts Registry Path</FormLabel>
                <FormControl>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <SelectTrigger className="w-sm">
                      <SelectValue placeholder="Contracts Registry Path" />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.keys(ContractRecordMap).map(
                        (ContractRegistryPath) => (
                          <SelectItem
                            key={ContractRegistryPath}
                            value={ContractRegistryPath}
                          >
                            {ContractRegistryPath}
                          </SelectItem>
                        ),
                      )}
                    </SelectContent>
                  </Select>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="definitionLocation.definitionPath"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Definition Path</FormLabel>
                <FormControl>
                  <Select
                    onValueChange={field.onChange}
                    value={field.value}
                    disabled={!ContractRegistryPathValue}
                    required
                  >
                    <SelectTrigger className="w-sm">
                      <SelectValue placeholder="Select a definition path" />
                    </SelectTrigger>
                    <SelectContent>
                      {definitionPathOptions.map((path) => (
                        <SelectItem key={path} value={path}>
                          {path}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {inputLocationNameList.map((inputLocationName) => (
            <FormField
              key={inputLocationName}
              control={form.control}
              name={`inputBoxLocationRecord.${inputLocationName}`}
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-emerald-600">
                    Input - BoxLocation - {inputLocationName}
                  </FormLabel>
                  <FormControl>
                    <Input
                      placeholder=""
                      {...field}
                      value={field.value ?? ''}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          ))}

          {outputLocationNameList.map((outputLocationName) => (
            <FormField
              key={outputLocationName}
              control={form.control}
              name={`outputBoxLocationRecord.${outputLocationName}`}
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-yellow-600">
                    Output - BoxLocation - {outputLocationName}
                  </FormLabel>
                  <FormControl>
                    <Input
                      placeholder=""
                      {...field}
                      value={field.value ?? ''}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          ))}

          {errorLocationNameList.map((errorLocationName) => (
            <FormField
              key={errorLocationName}
              control={form.control}
              name={`errorBoxLocationRecord.${errorLocationName}`}
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-red-600">
                    Error - BoxLocation - {errorLocationName}
                  </FormLabel>
                  <FormControl>
                    <Input
                      placeholder=""
                      {...field}
                      value={field.value ?? ''}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          ))}

          {definitionPathValue && (
            <FormField
              key="stepLabel"
              control={form.control}
              name="stepLabel"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-purple-600">Step Label</FormLabel>
                  <FormControl>
                    <Input placeholder="" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}

          <div className="flex flex-col space-y-4 gap-2">
            <Button type="submit" className="text-indigo-600">
              Create
            </Button>

            <Button
              variant="outline"
              type="button"
              onClick={onReset}
              className="text-gray-600"
            >
              Reset
            </Button>
          </div>
        </form>
      </Form>
    </>
  );
}
