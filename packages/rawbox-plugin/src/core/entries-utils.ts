import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { glob } from 'glob';

export function isAbsolute(inputPath: string): boolean {
  if (typeof inputPath !== 'string' || inputPath.trim() === '') {
    return false;
  }

  try {
    new URL(inputPath);
    return true;
  } catch {
    // Ignore URL parse error
  }

  return path.isAbsolute(inputPath);
}

export async function entryExists(entryPath: string): Promise<boolean> {
  try {
    await access(entryPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findFileAtFolderRoot(
  folderPathList: string[],
  targetFile: string = 'rawbox.config.js',
): Promise<string[]> {
  const folderPathListNew = [...folderPathList];
  const lastPath = folderPathListNew.pop();

  const patternList = folderPathListNew.map((folderPath) => {
    return path.posix.join(
      folderPath.split(path.sep).join('/'),
      `*/${targetFile}`,
    );
  });

  if (lastPath) {
    patternList.push(
      path.posix.join(lastPath.split(path.sep).join('/'), targetFile),
    );
  }

  const jsfiles = await glob(patternList);

  return jsfiles.map((file) => path.normalize(file));
}

export function getAllSubPaths(fullPath: string): string[] {
  const subPaths: string[] = [];
  let current = path.resolve(fullPath);

  while (current !== path.dirname(current)) {
    subPaths.push(current);
    current = path.dirname(current);
  }
  subPaths.push(current); // Push root

  return subPaths.reverse();
}

export async function findUpward(
  startFolder: string = path.dirname(fileURLToPath(import.meta.url)),
  targetEntry: string = 'node_modules',
): Promise<string[]> {
  const subFolderPathList = getAllSubPaths(startFolder);
  const candidatePathList = subFolderPathList.map((folderPath) => {
    return path.join(folderPath, targetEntry);
  });

  const existenceChecks = candidatePathList.map(entryExists);
  const existResultList = await Promise.all(existenceChecks);

  const existingPaths = candidatePathList.filter(
    (_, index) => existResultList[index],
  );

  return existingPaths;
}

/**
 * Attempts to determine the file path of the caller that invoked this function.
 * @param depth How many frames to go up the stack (default is 2).
 * @returns The file path of the caller.
 * @throws If the caller or file name cannot be determined.
 */
export function getCallerFilePath(depth: number = 2): string {
  const originalFunc = Error.prepareStackTrace;
  Error.prepareStackTrace = (_, stack) => stack;
  const e = new Error();
  const stack = e.stack as unknown as NodeJS.CallSite[];
  Error.prepareStackTrace = originalFunc;

  const caller = stack && stack[depth];
  if (!caller) {
    throw new Error(`No caller found at stack depth ${depth}.`);
  }

  const fileName = caller.getFileName();
  if (!fileName) {
    throw new Error('Caller was found but getFileName() returned null.');
  }

  return fileName.startsWith('file://') ? fileURLToPath(fileName) : fileName;
}
