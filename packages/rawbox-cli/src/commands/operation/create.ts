import fs from 'node:fs/promises';
import path from 'node:path';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { IndentationText, Project, SyntaxKind } from 'ts-morph';
import { copyTemplateFile } from '../../utils/template.js';

function getObjectLiteral(node: any): any {
  if (!node) return null;
  const initializer = node.getInitializer();
  if (!initializer) return null;

  if (initializer.getKind() === SyntaxKind.AsExpression) {
    const expr = initializer.getExpression();
    if (expr && expr.getKind() === SyntaxKind.ObjectLiteralExpression) {
      return expr;
    }
  } else if (initializer.getKind() === SyntaxKind.ObjectLiteralExpression) {
    return initializer;
  }
  return null;
}

function addOperationSignatureToRegistryFile(
  registryPath: string,
  newOperationName: string,
  definitionKeyPath: string
) {
  const project = new Project({
    manipulationSettings: {
      indentationText: IndentationText.TwoSpaces,
    },
  });
  const sourceFile = project.addSourceFileAtPath(registryPath);

  // Search for the object literal where contracts are registered
  const variableDecs = sourceFile.getVariableDeclarations();
  let targetObjectLiteral: any = null;

  for (const dec of variableDecs) {
    const name = dec.getName();
    if (['operationsRecord', 'operationRecord', 'ContractRecord', 'contractRecord', 'mathsRecord'].includes(name)) {
      const objLit = getObjectLiteral(dec);
      if (objLit) {
        targetObjectLiteral = objLit;
        break;
      }
    }
  }

  if (!targetObjectLiteral) {
    const propAssignments = sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAssignment);
    for (const prop of propAssignments) {
      const propName = prop.getName();
      if (['contractRecord', 'operationsRecord', 'operationRecord', 'mathsRecord'].includes(propName)) {
        const objLit = getObjectLiteral(prop);
        if (objLit) {
          targetObjectLiteral = objLit;
          break;
        }
      }
    }
  }

  if (targetObjectLiteral) {
    // Check if the property already exists to prevent duplicate key errors
    const existingProps = targetObjectLiteral.getProperties();
    const keyString = `"${definitionKeyPath}"`;
    const keyAltString = `'${definitionKeyPath}'`;
    const alreadyExists = existingProps.some((prop: any) => {
      if (prop.getKind() === SyntaxKind.PropertyAssignment) {
        const nameText = prop.getName();
        return nameText === keyString || nameText === keyAltString || nameText === definitionKeyPath;
      }
      return false;
    });

    if (alreadyExists) {
      return 'exists';
    }

    targetObjectLiteral.addPropertyAssignment({
      name: keyString,
      initializer: (writer: any) => {
        writer
          .write('{')
          .writeLine('type: "operation",')
          .writeLine(`description: "New operation: ${newOperationName}",`)
          .writeLine(
            'inputSchema: Type.Object({ x: Type.Number(), y: Type.Number(), z: Type.Number() }),',
          )
          .writeLine('outputSchema: Type.Object({ value: Type.Number() }),')
          .writeLine('errorSchema: Type.Object({ message: Type.String() }),')
          .writeLine('version: "1.0.0"')
          .write('}');
      },
    });
    sourceFile.saveSync();
    return 'success';
  }
  return 'not_found';
}

export async function createOperation(options: { name?: string | undefined } = {}) {
  p.intro(pc.cyan('Create a new Operation'));

  // Locate the registry file (search in src/ or current folder)
  let registryPath = '';
  const possiblePaths = [
    path.join(process.cwd(), 'src', 'contract-registry.ts'),
    path.join(process.cwd(), 'src', 'contracts-registry.ts'),
    path.join(process.cwd(), 'contract-registry.ts'),
    path.join(process.cwd(), 'contracts-registry.ts'),
  ];

  for (const p of possiblePaths) {
    try {
      const stat = await fs.stat(p);
      if (stat.isFile()) {
        registryPath = p;
        break;
      }
    } catch {}
  }

  if (!registryPath) {
    p.log.error(pc.red('Could not find contract registry file in src/contract-registry.ts or src/contracts-registry.ts.'));
    p.log.info('Make sure you run this command inside a Rawbox project or plugin directory.');
    process.exit(1);
  }

  p.log.info(`Found registry file at: ${pc.green(registryPath)}`);

  const answers = await p.group(
    {
      operationName: async () =>
        options.name !== undefined
          ? options.name
          : p.text({
              message: 'What is the name of your new operation?',
              placeholder: 'my-operation',
              validate: (val) => {
                if (!val.trim()) return 'Operation name is required';
              },
            }),
    },
    {
      onCancel: () => {
        p.cancel('Operation cancelled.');
        process.exit(0);
      },
    }
  );

  const { operationName } = answers;
  const camelCaseName = operationName.replace(/-([a-z])/g, (g) => g[1]!.toUpperCase());
  const registryDir = path.dirname(registryPath);
  
  // Check if operations/ subdirectory exists (like in a plugin layout)
  const hasOperationsSubdir = await fs.stat(path.join(registryDir, 'operations'))
    .then((s) => s.isDirectory())
    .catch(() => false);

  const destDir = hasOperationsSubdir ? path.join(registryDir, 'operations') : registryDir;
  const definitionFile = path.join(destDir, `${operationName}.definition.ts`);
  const definitionKeyPath = hasOperationsSubdir 
    ? `./operations/${operationName}.definition.js` 
    : `./${operationName}.definition.js`;

  const s = p.spinner();
  s.start(`Generating operation definition file in ${pc.green(definitionFile)}...`);

  try {
    const isPluginRegistry = registryPath.endsWith('contract-registry.ts');
    const registryImportPath = isPluginRegistry ? '../contract-registry.js' : './contracts-registry.js';
    
    // Copy definition template
    await copyTemplateFile('operation/operation.definition.ts.ejs', definitionFile, {
      camelCaseName,
      operationName,
      definitionKeyPath,
      registryImportPath,
    });

    s.stop('Operation definition generated.');

    s.start(`Registering operation in ${pc.green(registryPath)}...`);
    const status = addOperationSignatureToRegistryFile(registryPath, operationName, definitionKeyPath);
    
    if (status === 'success') {
      s.stop('Registered successfully.');
      p.outro(pc.green(`✅ Operation ${operationName} created successfully!`));
    } else if (status === 'exists') {
      s.stop('Already exists.');
      p.log.warn(`Signature for ${definitionKeyPath} was already present in registry.`);
      p.outro(pc.green(`✅ Operation file created successfully.`));
    } else {
      s.stop('Failed to register.');
      p.log.error('Could not find operations record variable inside registry file to append signature.');
      p.outro(pc.yellow('⚠ Operation file created, but not registered.'));
    }
  } catch (error: any) {
    s.stop('Failed.');
    p.log.error(pc.red(`Error: ${error.message}`));
    process.exit(1);
  }
}
