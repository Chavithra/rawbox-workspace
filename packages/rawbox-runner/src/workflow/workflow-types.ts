import { Type, type Static } from 'typebox';

import { BoxStrategy } from 'rawbox-store';

import  { Step } from '../workflow/step-types.js';

export const Seed = Type.Object({
  key: Type.String(),
  strategy: BoxStrategy,
  value: Type.Unknown(),
});

export type Seed = Static<typeof Seed>;

export const Workflow = Type.Object({
  name: Type.String(),
  pluginPathList: Type.Array(Type.String()),
  stepList: Type.Array(Step),
  seedData: Type.Optional(Type.Array(Seed)),
});

export type Workflow = Static<typeof Workflow>;
