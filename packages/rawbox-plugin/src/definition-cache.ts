import path from "node:path";

import { err, ok, Result } from "neverthrow";

import {
  Definition,
  DefinitionLoader,
  DefinitionLocation,
  DefinitionPath,
} from "./definition.js";
import { Contract } from "./contracts-registry.js";
import { isAbsolute } from "path";
import { definitionGuard } from "./definition-utils.js";
import { TObject } from "@sinclair/typebox";

export function createLoadDefinition<
  TContract extends Contract,
  TDefinition extends Definition<TContract>,
>(
  contractGuard: (contract: object) => contract is TContract
): DefinitionLoader<TContract, TDefinition> {
  async function loadDefinitionFromAbsolutePath(
    definitionAbsolutePath: DefinitionPath
  ): Promise<Result<TDefinition, string>> {
    if (!isAbsolute(definitionAbsolutePath)) {
      return err(
        `Parameter 'definitionAbsolutePath' should be absolute: '${definitionAbsolutePath}'`
      );
    }

    try {
      const module = await import(definitionAbsolutePath);
      const definition = module.default;

      if (!definitionGuard(definition)) {
        return err(
          `Module default export from '${definitionAbsolutePath}' is not a valid Definition.`
        );
      }

      if (!contractGuard(definition.contract)) {
        return err(
          `Contract in '${definitionAbsolutePath}' is not a valid contract for this loader.`
        );
      }

      return ok(definition as TDefinition);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return err(
        `Failed to load definition from '${definitionAbsolutePath}': ${message}`
      );
    }
  }

  return async (
    definitionLocation: DefinitionLocation
  ): Promise<Result<TDefinition, string>> => {
    const { contractsRegistryPath, definitionPath } = definitionLocation;

    const definitionAbsolutePath = path.isAbsolute(definitionPath)
      ? definitionPath
      : path.join(path.dirname(contractsRegistryPath), definitionPath);

    return loadDefinitionFromAbsolutePath(definitionAbsolutePath);
  };
}

export class DefinitionCache<
  TContract extends Contract,
  TDefinition extends Definition<any, any, any, any>,
> {
  public constructor(
    private readonly definitionLoader: DefinitionLoader<TContract, TDefinition>,
    private readonly definitionMap: Map<DefinitionPath, TDefinition> = new Map<
      DefinitionPath,
      TDefinition
    >()
  ) {}

  public async getOrLoadDefinition(
    definitionLocation: DefinitionLocation,
    forceReload: boolean = false
  ): Promise<Result<TDefinition, string>> {
    const { contractsRegistryPath, definitionPath } = definitionLocation;
    const cacheKey = `${contractsRegistryPath}:${definitionPath}`;

    const resultOfLoadDefinition = await this.loadDefinition(
      definitionLocation,
      forceReload
    );

    if (resultOfLoadDefinition.isOk()) {
      // The non-null assertion is safe because loadDefinition ensures the entry exists.
      return ok(this.definitionMap.get(cacheKey)!);
    } else {
      return err(resultOfLoadDefinition.error);
    }
  }

  public async loadDefinition(
    definitionLocation: DefinitionLocation,
    forceReload: boolean = false
  ): Promise<Result<void, string>> {
    let result: Result<void, string>;

    const { contractsRegistryPath, definitionPath } = definitionLocation;
    const cacheKey = `${contractsRegistryPath}:${definitionPath}`;

    if (!forceReload && this.definitionMap.has(cacheKey)) {
      result = ok();
    } else {
      const definition = await this.definitionLoader(definitionLocation);

      if (definition.isOk()) {
        this.definitionMap.set(cacheKey, definition.value);
        result = ok();
      } else {
        result = err(definition.error);
      }
    }

    return result;
  }
}

export function createDefinitionCache<
  TContract extends Contract,
  TDefinition extends Definition<TContract>,
>(
  definitionLoader: DefinitionLoader<TContract, TDefinition>
): new (
  definitionMap?: Map<DefinitionPath, TDefinition>
) => DefinitionCache<TContract, TDefinition> {
  return class extends DefinitionCache<TContract, TDefinition> {
    public constructor(
      definitionMap: Map<DefinitionPath, TDefinition> = new Map()
    ) {
      super(definitionLoader, definitionMap);
    }
  };
}
