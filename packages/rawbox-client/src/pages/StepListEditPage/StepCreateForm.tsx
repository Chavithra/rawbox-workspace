import { toast } from "sonner";
import { Type, type Static } from "@sinclair/typebox";
import { typeboxResolver } from "@hookform/resolvers/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { useEffect, useMemo } from "react";
import { useForm, type FieldErrors } from "react-hook-form";

import { type BoxLocationRecord, type Step } from "rawbox-runner";
import { ControlFlowContract } from "rawbox-default-plugins/control-flow-definition";
import { OperationContract } from "rawbox-plugin/operation-definition";
import { createSimpleBoxLocation } from "rawbox-store/box-store-utils";

import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SortableRowProps } from "./SortableRow";

export interface ContractsRecord {
  contractsRegistryPath: string;
  contractsRecord: Record<string, OperationContract | ControlFlowContract>;
}

export type ContractsRecordsMap = Record<string, ContractsRecord>;

export const BaseDefinitionLocation = Type.Object({
  contractsRegistryPath: Type.String({ minLength: 1 }),
  definitionPath: Type.String({ minLength: 1 }),
});

const LocationRecord = Type.Record(Type.String(), Type.String());
type LocationRecord = Static<typeof LocationRecord>;

export const BaseFormSchema = Type.Object({
  definitionLocation: BaseDefinitionLocation,
  errorLocationRecord: LocationRecord,
  inputLocationRecord: LocationRecord,
  outputLocationRecord: LocationRecord,
  stepLabel: Type.Optional(Type.String()),
});
export type BaseFormSchema = Static<typeof BaseFormSchema>;

interface StepCreateFormProps {
  contractsRecordMap: ContractsRecordsMap;
  setSortableRowPropsList: React.Dispatch<
    React.SetStateAction<SortableRowProps[]>
  >;
}

function convertToBoxLocationRecord(
  locationRecord: LocationRecord
): BoxLocationRecord {
  return Object.entries(locationRecord).reduce(
    (acc, [parameterName, BoxLocationKeyId]) => {
      if (BoxLocationKeyId) {
        acc[parameterName] = createSimpleBoxLocation(
          "env1",
          "dbi1",
          BoxLocationKeyId
        );
      }
      return acc;
    },
    {} as BoxLocationRecord
  );
}

export function StepCreateForm({
  contractsRecordMap,
  setSortableRowPropsList,
}: StepCreateFormProps) {
  const formSchemaValidator = TypeCompiler.Compile(BaseFormSchema);
  const form = useForm<BaseFormSchema>({
    resolver: typeboxResolver(formSchemaValidator),
    defaultValues: {
      definitionLocation: {
        contractsRegistryPath: "",
        definitionPath: "",
      },
      inputLocationRecord: {},
      outputLocationRecord: {},
      errorLocationRecord: {},
      stepLabel: undefined,
    },
  });

  const { resetField } = form;
  const contractsRegistryPathValue = form.watch(
    "definitionLocation.contractsRegistryPath"
  );
  const definitionPathValue = form.watch("definitionLocation.definitionPath");

  const definitionPathOptions = useMemo(() => {
    const contractsRecord =
      contractsRecordMap[contractsRegistryPathValue]?.contractsRecord;

    if (contractsRecord && typeof contractsRecord === "object") {
      return Object.keys(contractsRecord);
    }

    return [];
  }, [contractsRegistryPathValue, contractsRecordMap]);

  const inputLocationNameList = useMemo(() => {
    let result: string[];

    const contract =
      contractsRecordMap[contractsRegistryPathValue]?.contractsRecord[
        definitionPathValue
      ];

    const inputSchema = contract?.inputSchema;
    if (inputSchema) {
      result = Object.keys(inputSchema.properties);
    } else {
      result = [];
    }

    return result;
  }, [contractsRegistryPathValue, contractsRecordMap, definitionPathValue]);

  const outputLocationNameList = useMemo(() => {
    let result: string[];

    const contract =
      contractsRecordMap[contractsRegistryPathValue]?.contractsRecord[
        definitionPathValue
      ];

    if (contract && contract.type == "operation") {
      const outputSchema = contract.outputSchema;
      result = Object.keys(outputSchema.properties);
    } else {
      result = [];
    }

    return result;
  }, [contractsRecordMap, contractsRegistryPathValue, definitionPathValue]);

  const errorLocationNameList = useMemo(() => {
    let result: string[];

    const contract =
      contractsRecordMap[contractsRegistryPathValue]?.contractsRecord[
        definitionPathValue
      ];

    const errorSchema = contract?.errorSchema;
    if (errorSchema) {
      result = Object.keys(errorSchema.properties);
    } else {
      result = [];
    }

    return result;
  }, [contractsRecordMap, contractsRegistryPathValue, definitionPathValue]);

  useEffect(() => {
    resetField("definitionLocation.definitionPath", { defaultValue: "" });
    resetField("inputLocationRecord", { defaultValue: {} });
    resetField("outputLocationRecord", { defaultValue: {} });
    resetField("errorLocationRecord", { defaultValue: {} });
    resetField("stepLabel", { defaultValue: undefined });
  }, [contractsRegistryPathValue, resetField]);

  const onInvalid = (e: FieldErrors<BaseFormSchema>) => {
    console.log(e);
    toast.error("Form is invalid. Please check the fields and try again.");
  };

  const onReset = () => {
    form.reset();
  };

  const onSubmit = async (inputs: BaseFormSchema) => {
    const {
      definitionLocation,
      inputLocationRecord,
      outputLocationRecord,
      errorLocationRecord,
      stepLabel,
    } = inputs;

    const step: Step = {
      definitionLocation,
      inputLocationRecord: convertToBoxLocationRecord(inputLocationRecord),
      outputLocationRecord: convertToBoxLocationRecord(outputLocationRecord),
      errorLocationRecord: convertToBoxLocationRecord(errorLocationRecord),
      stepLabel,
    };

    setSortableRowPropsList((sortableRowPropsList) => [
      ...sortableRowPropsList,
      {
        step,
        id: sortableRowPropsList.length,
      },
    ]);

    console.log("inputs", inputs);
    console.log("step", step);

    toast.success("Step created successfully!");
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
            name="definitionLocation.contractsRegistryPath"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Contracts Registry Path</FormLabel>
                <FormControl>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <SelectTrigger className="w-sm">
                      <SelectValue placeholder="Contracts Registry Path" />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.keys(contractsRecordMap).map(
                        (contractsRegistryPath) => (
                          <SelectItem
                            key={contractsRegistryPath}
                            value={contractsRegistryPath}
                          >
                            {contractsRegistryPath}
                          </SelectItem>
                        )
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
                    disabled={!contractsRegistryPathValue}
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
              name={`inputLocationRecord.${inputLocationName}`}
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-emerald-600">
                    Input - BoxLocation - {inputLocationName}
                  </FormLabel>
                  <FormControl>
                    <Input
                      placeholder=""
                      {...field}
                      value={field.value ?? ""}
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
              name={`outputLocationRecord.${outputLocationName}`}
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-yellow-600">
                    Output - BoxLocation - {outputLocationName}
                  </FormLabel>
                  <FormControl>
                    <Input
                      placeholder=""
                      {...field}
                      value={field.value ?? ""}
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
              name={`errorLocationRecord.${errorLocationName}`}
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-red-600">
                    Error - BoxLocation - {errorLocationName}
                  </FormLabel>
                  <FormControl>
                    <Input
                      placeholder=""
                      {...field}
                      value={field.value ?? ""}
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
