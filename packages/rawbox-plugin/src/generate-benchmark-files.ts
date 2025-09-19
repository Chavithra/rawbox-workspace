import fs from "node:fs/promises";
import path from "node:path";
import { faker } from "@faker-js/faker";

const NUM_FOLDERS = 1000;
const NUM_FUNCTIONS_PER_FILE = 1000;
const NUM_PARAMS_PER_FUNCTION = 10;

const BASE_DIR = path.resolve(process.cwd(), "benchmark_files");

/**
 * Returns a random TypeBox type name.
 */
function getRandomTypeName(): "String" | "Number" | "Boolean" {
  const types = ["String", "Number", "Boolean"] as const;
  return types[Math.floor(Math.random() * types.length)];
}

/**
 * Generates a single contract entry for the contractsRecord as a string.
 * @param funcIndex The index of the function.
 */
function generateContractEntryString(funcIndex: number): string {
  const verb = faker.word.verb();
  const noun = faker.word.noun();
  // Sanitize to ensure it's a valid variable name.
  const functionName = `${verb}${
    noun.charAt(0).toUpperCase() + noun.slice(1)
  }`.replace(/[^a-zA-Z0-9]/g, "");

  const definitionPath = `./${functionName}_${funcIndex}.definition.js`;

  const inputParams = Array.from(
    { length: NUM_PARAMS_PER_FUNCTION },
    (_, i) => {
      const paramType = getRandomTypeName();
      const paramName = `${faker.lorem.word()}_${i}`.replace(
        /[^a-zA-Z0-9_]/g,
        ""
      );
      return `        ${paramName}: Type.${paramType}()`;
    }
  ).join(",\n");

  const outputType = getRandomTypeName();

  const contractObject = `{
      type: "operation",
      description: "${faker.lorem.sentence()}",
      inputSchema: Type.Object({\n${inputParams}\n      }),
      outputSchema: Type.Object({
        value: Type.${outputType}(),
      }),
      errorSchema: Type.Object({
        message: Type.String(),
      }),
      version: "1.0.0",
    }`;

  return `    "${definitionPath}": ${contractObject}`;
}

/**
 * Generates the full content for a contracts-registry.ts file.
 */
function generateContractsRegistryContent(): string {
  const contractEntries = Array.from(
    { length: NUM_FUNCTIONS_PER_FILE },
    (_, i) => generateContractEntryString(i)
  );

  return `import { Type } from "@sinclair/typebox";
import {
  setupOperationContractsRegistry,
  getOperationDefinitionCreator,
} from "rawbox-plugin";

const contractsRegistry = setupOperationContractsRegistry({
  contractsRecord: {
${contractEntries.join(",\n")}
  },
});

export const createOperationDefinition =
  getOperationDefinitionCreator(contractsRegistry);

export default contractsRegistry;`;
}

/**
 * The main function to generate all folders and files.
 */
async function main() {
  console.log(`Generating ${NUM_FOLDERS} folders in ${BASE_DIR}...`);
  await fs.mkdir(BASE_DIR, { recursive: true });

  for (let i = 0; i < NUM_FOLDERS; i++) {
    const folderName = `plugin-${i}`;
    const folderPath = path.join(BASE_DIR, folderName);
    await fs.mkdir(folderPath, { recursive: true });

    // Generate rawbox.config.json
    const configContent = JSON.stringify(
      {
        contractsRegistryPathList: ["./contracts-registry.js"],
      },
      null,
      2
    );
    await fs.writeFile(
      path.join(folderPath, "rawbox.config.json"),
      configContent
    );

    // Generate contracts-registry.js
    const contractsContent = generateContractsRegistryContent();
    await fs.writeFile(
      path.join(folderPath, "contracts-registry.js"),
      contractsContent
    );

    if ((i + 1) % 50 === 0 || i + 1 === NUM_FOLDERS) {
      console.log(`Generated ${i + 1}/${NUM_FOLDERS} folders...`);
    }
  }

  console.log("✅ Done generating benchmark files.");
}

main().catch((err) => {
  console.error("An error occurred during file generation:", err);
  process.exit(1);
});
