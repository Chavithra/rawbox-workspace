import { type Static, Type } from 'typebox';
import { Compile } from 'typebox/compile';

type RawboxPluginPath = string;

export const RawboxPlugin = Type.Object({
  ContractRegistryPathList: Type.Array(Type.String()),
});

export type RawboxPlugin = Static<typeof RawboxPlugin>;

export const RawboxPluginValidator = Compile(RawboxPlugin);

export interface RawboxPluginFile {
  path: RawboxPluginPath;
  content: RawboxPlugin;
}
