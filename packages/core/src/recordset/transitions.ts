/**
 * Running a state transition (RFC 0010 §7.2): validate the source states, run the guard, run the events, write the
 * state through the unit of work.
 */

import { InvalidTransitionError, TransitionGuardError } from '../errors.js';
import type { Field, Transition } from '../model/field.js';
import type { AnyModel } from '../model/model.js';
import { trackChange } from './audit.js';
import type { ComputeHost } from './compute.js';
import { failingIds } from './constraints.js';

type Hook = (this: unknown, records: unknown) => unknown;

interface StateFieldRuntime {
  readonly transitions: Readonly<Record<string, Transition<string>>>;
  readonly stateHooks: Readonly<
    Record<string, { readonly onEnter?: Hook; readonly onExit?: Hook }>
  >;
}

/** Runs transition `name` of state field `key` on `ids` of `model`. */
export async function runTransition(
  host: ComputeHost,
  model: AnyModel,
  ids: readonly number[],
  key: string,
  name: string,
): Promise<void> {
  if (ids.length === 0) return;
  const { internals } = host;
  const field = model.fields[key] as Field & StateFieldRuntime;
  const transition = field.transitions[name];
  if (transition === undefined) throw new InvalidTransitionError(model.name, name, [], []);

  await host.load(model, ids, { fields: new Set(['id', key]), relations: new Map() });
  const stateOf = (id: number): string => String(host.values(model.name, id)?.get(key));
  const invalid = ids.filter((id) => !transition.from.includes(stateOf(id)));
  if (invalid.length > 0) {
    throw new InvalidTransitionError(
      model.name,
      name,
      invalid.map((id) => ({ id, state: stateOf(id) })),
      transition.from,
    );
  }

  const records = host.recordset(model, ids);
  const guard = transition.guard as Hook | undefined;
  if (guard !== undefined) {
    const failing = failingIds(await guard.call(records, records));
    if (failing.length > 0) {
      throw new TransitionGuardError(
        model.name,
        name,
        failing,
        transition.message ?? `${failing.length} record(s) do not satisfy the guard of '${name}'.`,
      );
    }
  }

  const byState = new Map<string, number[]>();
  for (const id of ids) byState.set(stateOf(id), [...(byState.get(stateOf(id)) ?? []), id]);
  for (const [state, group] of byState) {
    const onExit = field.stateHooks[state]?.onExit;
    if (onExit !== undefined) {
      const set = host.recordset(model, group);
      await onExit.call(set, set);
    }
  }
  const before = transition.before as Hook | undefined;
  if (before !== undefined) await before.call(records, records);

  // The state write: cache, journal, dirty, triggers (RFC 0008 §7.2). The field is readonly for write(); this is the one path that sets it.
  for (const id of ids) {
    const values = host.values(model.name, id, true) as Map<string, unknown>;
    internals.journal({
      kind: 'value',
      model: model.name,
      id,
      key,
      had: values.has(key),
      prev: values.get(key),
      wasDirty: internals.isDirty(model.name, id, key),
    });
    trackChange(internals, model, id, key, values.get(key), transition.to, (k) => values.get(k));
    values.set(key, transition.to);
    internals.markDirty(model.name, id, key);
  }
  internals.trigger(model.name, key, ids);

  const after = transition.after as Hook | undefined;
  if (after !== undefined) await after.call(records, records);
  const onEnter = field.stateHooks[transition.to]?.onEnter;
  if (onEnter !== undefined) await onEnter.call(records, records);
}

/** Transition names available from the current state of one record (state must be loaded). */
export function availableTransitions(model: AnyModel, key: string, state: unknown): string[] {
  const field = model.fields[key] as Field & StateFieldRuntime;
  return Object.entries(field.transitions)
    .filter(([, t]) => t.from.includes(String(state)))
    .map(([n]) => n);
}
