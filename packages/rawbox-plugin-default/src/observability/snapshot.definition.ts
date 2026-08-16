import { ok } from '@rawbox/plugin/neverthrow';
import { emitRunEvent } from '@rawbox/plugin';
import { createOperationDefinition } from '../contract-registry.js';
import { SNAPSHOT_VALUE_FIELD_LIST } from './snapshot-fields.js';

/**
 * `observability/snapshot` — a read-only monitor's whole job in one step.
 *
 * The monitor-workflow pattern in one operation: a monitor cross-reads other
 * workflows' storage keys on a throttle and logs what it found, so a
 * multi-workflow system is legible from a fifth terminal without a bespoke
 * operation per project. This definition takes whatever a workflow author
 * binds to `value1`..`value{SNAPSHOT_VALUE_FIELD_LIST.length}` — typically
 * `{ key, workflow }` cross-workflow reads (FORMAT.md, "Bindings") —
 * and emits every *provided* one as a single structured `log` event.
 *
 * ## Why fixed `valueN` fields, not an open schema
 *
 * The natural shape for "arbitrary named values" is a schema whose field names
 * are not fixed — TypeBox's `Type.Record`. That shape was tried and rejected:
 *
 * - `OperationContract`'s `inputSchema` type parameter is bounded by `TObject`
 *   (`@rawbox/plugin`'s `operation-contract-types.ts`), and `Type.Record(...)`
 *   compiles to `{ '~kind': 'Record', patternProperties }`, which is not a
 *   `TObject` (`{ '~kind': 'Object', properties, required }`). Declaring the
 *   contract this way does not type-check without casting away the very
 *   safety `createOperationDefinition` exists to provide.
 * - Even set aside, `validateSeedData` (`@rawbox/runner`'s `validation.ts`)
 *   pairs a seed to the input field that consumes it by reading
 *   `contract.inputSchema.properties[fieldName]` — a lookup that only exists
 *   on an object schema. A `Type.Record` `inputSchema` has no `.properties`,
 *   so a constant seeded onto this operation would silently skip the
 *   preflight type-check every other operation's seeded input gets, rather
 *   than failing loudly on a type mismatch.
 *
 * A step binds one contract field to one storage location — that is the whole
 * binding model (FORMAT.md, "Bindings") — so distinct cross-workflow
 * reads need distinct top-level field names regardless: nesting them under one
 * `Type.Record` field would still only let a single storage key be bound to
 * it, which defeats the point of snapshotting several keys at once. Fixed,
 * named optional fields are therefore not a fallback approximating the ideal
 * shape; they are the shape the format's binding model, and the contract type
 * layer, actually support end to end.
 */
const snapshotDefinition = createOperationDefinition(
  './observability/snapshot.definition.js',
  async (input) => {
    const { label } = input;
    const timestamp = Date.now();

    const snapshot: Record<string, unknown> = {};
    for (const field of SNAPSHOT_VALUE_FIELD_LIST) {
      const value = input[field];
      if (value !== undefined) {
        snapshot[field] = value;
      }
    }

    const count = Object.keys(snapshot).length;
    const message =
      label !== undefined ? `Snapshot: ${label}` : 'Workflow snapshot';

    const routed = emitRunEvent({
      event: 'log',
      level: 'info',
      message,
      data: snapshot,
    });

    if (!routed) {
      console.info(
        JSON.stringify({ timestamp, level: 'info', message, data: snapshot }),
      );
    }

    return ok({
      ...(label !== undefined ? { label } : {}),
      snapshot,
      count,
      timestamp,
    });
  },
);

export default snapshotDefinition;
