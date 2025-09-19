import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { glob } from "glob";

export function isAbsolute(inputPath: string) {
  if (typeof inputPath !== "string" || inputPath.trim() === "") {
    return false;
  }

  try {
    const url = new URL(inputPath);
    return true;
  } catch (error) {}

  return path.isAbsolute(inputPath);
}

export async function entryExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findFileAtFolderRoot(
  folderPathList: string[],
  targetFile: string = "rawbox.config.js"
): Promise<string[]> {
  const lastPath = folderPathList.pop();
  const patternList = folderPathList.map((folderPath) => {
    return path.join(folderPath, `/*/${targetFile}`);
  });

  if (lastPath) {
    patternList.push(path.join(lastPath, targetFile));
  }

  const jsfiles = await glob(patternList);

  return jsfiles;
}

export function getAllSubPaths(fullPath: string): string[] {
  const parts = fullPath.split(path.sep).filter(Boolean);
  const root = path.parse(fullPath).root;
  const subPaths: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    subPaths.push(path.join(root, ...parts.slice(0, i + 1)));
  }
  return subPaths;
}

export async function findUpward(
  startFolder: string = path.dirname(fileURLToPath(import.meta.url)),
  targetEntry: string = "node_modules"
) {
  const subFoldePathList = getAllSubPaths(startFolder);
  const candidatePathList = subFoldePathList.map((folderPath) => {
    return path.join(folderPath, targetEntry);
  });

  const existenceChecks = candidatePathList.map(entryExists);
  const existResultList = await Promise.all(existenceChecks);
  const existingPaths = candidatePathList.filter(
    (_, index) => existResultList[index]
  );

  return existingPaths;
}

/**
 * Attempts to determine the file path of the caller that invoked this function.
 * @returns The file path of the caller.
 * @throws If the caller or file name cannot be determined.
 */
export function getCallerFilePath(): string {
  let result: string;

  const originalFunc = Error.prepareStackTrace;
  Error.prepareStackTrace = (_, stack) => stack;
  const e = new Error();
  const stack = e.stack as unknown as NodeJS.CallSite[];
  Error.prepareStackTrace = originalFunc;

  // stack[0] = this function,
  // stack[1] = SignatureRegistry constructor
  // stack[2] = caller
  const caller = stack && stack[2];
  if (caller) {
    const fileName = caller.getFileName();
    if (fileName) {
      result = fileName;
    } else {
      throw Error("No fileName null.");
    }
  } else {
    throw Error("No caller found.");
  }

  return result;
}
