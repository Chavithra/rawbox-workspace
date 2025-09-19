import { fileURLToPath } from "node:url";
import path from "node:path";

import Generator from "yeoman-generator";
import { IndentationText, Project, SyntaxKind } from "ts-morph";

interface ProjectInfo {
  operationName: string;
  packageManager: "npm" | "yarn" | "pnpm";
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function addOperationSignatureToRegistryFile(
  signatureRegistryPath: string,
  newOperationName: string
) {
  const project = new Project({
    manipulationSettings: {
      indentationText: IndentationText.TwoSpaces,
    },
  });
  const sourceFile = project.addSourceFileAtPath(signatureRegistryPath);

  const contractsRecordProp = sourceFile.getFirstDescendant(
    (node) =>
      node.getKind() === SyntaxKind.PropertyAssignment &&
      node.getFirstChildByKind(SyntaxKind.Identifier)?.getText() ===
        "contractsRecord"
  );

  if (contractsRecordProp) {
    const objLiteral = contractsRecordProp.getFirstDescendantByKind(
      SyntaxKind.ObjectLiteralExpression
    );
    if (objLiteral) {
      objLiteral.addPropertyAssignment({
        name: `"./${newOperationName}.definition.js"`,
        initializer: (writer) => {
          writer
            .write("{")
            .writeLine('type: "operation",')
            .writeLine(`description: "New operation: ${newOperationName}",`)
            .writeLine(
              "inputSchema: Type.Object({ x: Type.Number(), y: Type.Number(), z: Type.Number() }),"
            )
            .writeLine("outputSchema: Type.Object({ value: Type.Number() }),")
            .writeLine("errorSchema: Type.Object({ message: Type.String() }),")
            .writeLine('version: "1.0.0"')
            .write("},");
        },
      });
      sourceFile.saveSync();
      console.log(
        `Added ./${newOperationName}.definition.js to contractsRecord.`
      );
    }
  }
}

export default class extends Generator<never> {
  private answers: ProjectInfo | undefined;

  initializing() {
    this.log("Welcome to the My Framework `create` generator!");
  }

  async prompting() {
    this.answers = await this.prompt<ProjectInfo>([
      {
        type: "input",
        name: "operationName",
        message: "What is the operation name?",
        default: path.basename(this.destinationRoot()), // Default to current folder name
      },
    ]);
  }

  writing() {
    if (this.answers) {
      const { operationName } = this.answers;

      this.fs.copyTpl(
        this.templatePath(
          __dirname,
          "partial-package-template",
          "src",
          "new-operation.definition.ts.ejs"
        ),
        this.destinationPath("src", `${operationName}.definition.ts`),
        { operationName }
      );

      addOperationSignatureToRegistryFile(
        this.destinationPath("src", "contracts-registry.ts"),
        operationName
      );

      this.log(`\nCreated ${operationName} folder.`);
    } else {
      this.log("\nCould not create project files; no answers were provided.");
    }
  }

  end() {
    this.log("\n✅ Project generation complete!");
    this.log("You can now `cd` into your new project and start building.");
  }
}
