import { Static, Type } from "@sinclair/typebox";
import { TypeCompiler } from "@sinclair/typebox/compiler";

type RawboxConfigPath = string;

export const RawboxConfig = Type.Object({
  contractsRegistryPathList: Type.Array(Type.String()),
});

export type RawboxConfig = Static<typeof RawboxConfig>;

export const RawboxConfigValidator = TypeCompiler.Compile(RawboxConfig);

export interface RawboxConfigFile {
  path: RawboxConfigPath;
  content: RawboxConfig;
}
