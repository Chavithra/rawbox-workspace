import { ContractsRegistryCache } from "rawbox-plugin/contracts-registry-cache";
import { OperationDefinitionCache } from "rawbox-plugin/operation-definition-cache";

const signatureRegistryCache = await ContractsRegistryCache.build(
  "/home/dtp2/code/javascript/real/rawbox-workspace/"
);

const definitionLocationList =
  signatureRegistryCache.getDefinitionLocationList();

const operationLocation = definitionLocationList[0];

const operationDefinitionCache = new OperationDefinitionCache();

const resultOrgetOrLoadOperationImplementation =
  await operationDefinitionCache.getOrLoadDefinition(operationLocation);

if (resultOrgetOrLoadOperationImplementation.isOk()) {
  const operation = resultOrgetOrLoadOperationImplementation.value;
  console.log(JSON.stringify(operation, null, 2));

  const v = operation.validatedHandler({ a: 1, b: 2, c: 3 });

  console.log(v);
}

console.log(definitionLocationList);
