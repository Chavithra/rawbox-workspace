import { Type, type Static } from 'typebox';

export const Workspace = Type.Object({
  name: Type.String(),
  workflowPathList: Type.Array(Type.String()),
});

export type Workspace = Static<typeof Workspace>;
