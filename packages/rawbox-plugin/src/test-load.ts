import path from "node:path";
import { ContractsRegistryLoader } from "./contracts-registry-loader.js";
// const benchmarkFilesPath = path.resolve(
//   "/home/dtp2/code/javascript/real/rawbox-workspace/packages/rawbox-default-plugins"
// );
// const contractsRegistryPathList =
//   await ContractsRegistryLoader.loadContractsRegistryPathList(
//     benchmarkFilesPath
//   );
// console.log(contractsRegistryPathList);

// for (const contractsRegistryPath of contractsRegistryPathList) {
//   const contractsRegistry = await ContractsRegistryLoader.loadContractsRegistry(
//     contractsRegistryPath
//   );
//   console.log(contractsRegistry);
// }

const contractsRegistryPath =
  "/home/dtp2/code/javascript/real/rawbox-workspace/node_modules/rawbox-default-plugins/dist/src/maths/contracts-registry.js";
const contractsRegistry = await ContractsRegistryLoader.loadContractsRegistry(
  contractsRegistryPath
);
console.log(contractsRegistryPath);
if (contractsRegistry.isOk()) {
  console.log(
    Object.keys(
      contractsRegistry.value.contractsRecord["./sum.definition.js"][
        "inputSchema"
      ]["properties"]
    )
  );
}

import { Type } from "@sinclair/typebox";
const formSchema = Type.Object({
  contractsRegistryPath: Type.String(),
  definitionPath: Type.String(),
  inputSchema: Type.Object({
    properties: Type.Record(Type.String(), Type.Any()),
  }),
});
console.log(formSchema);
