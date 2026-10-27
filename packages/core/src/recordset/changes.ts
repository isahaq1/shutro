/**
 * Change events (RFC 0018 §7.5): a model with `changeEvents: true` emits one `record.changed` outbox event per model
 * and action at each flush, in the writing transaction, so it exists if and only if the change committed. The event
 * names the ids and the stored keys written; it carries no values (subscribers read the records in their own scope).
 */
import type { AnyModel } from '../model/model.js';

/** The topic of change events. */
export const CHANGE_TOPIC = 'record.changed';
/** At most this many ids per event: a larger change is split. */
export const CHANGE_IDS_PER_EVENT = 1000;

export interface ChangeRow {
  readonly model: string;
  readonly action: 'create' | 'write' | 'unlink';
  readonly ids: readonly number[];
  readonly keys: readonly string[];
}

/** What recording and emitting need of a scope. */
export interface ChangeHost {
  readonly changeRows: ChangeRow[];
  readonly env: {
    emit(topic: string, payload: unknown): Promise<number>;
    /** Why the scope acts (`env.reason`): subscribers tell their own writes apart (loop guards). */
    readonly reason?: string | undefined;
  };
}

/** Records a change of `model`'s rows (a no-op unless the model asks for change events; drafts are left out). */
export function recordChange(
  host: Pick<ChangeHost, 'changeRows'>,
  model: AnyModel,
  action: ChangeRow['action'],
  ids: readonly number[],
  keys: readonly string[] = [],
): void {
  if (!model.changeEvents) return;
  const real = ids.filter((id) => id > 0);
  if (real.length > 0) host.changeRows.push({ model: model.name, action, ids: real, keys });
}

/** Emits the recorded changes: one event per model and action (keys merged), split by {@link CHANGE_IDS_PER_EVENT}. */
export async function flushChanges(host: ChangeHost): Promise<void> {
  if (host.changeRows.length === 0) return;
  const rows = host.changeRows.splice(0);
  const merged = new Map<
    string,
    { model: string; action: string; ids: number[]; seen: Set<number>; keys: Set<string> }
  >();
  for (const row of rows) {
    const key = `${row.model}\u0000${row.action}`;
    const entry = merged.get(key) ?? {
      model: row.model,
      action: row.action,
      ids: [],
      seen: new Set(),
      keys: new Set(),
    };
    for (const id of row.ids)
      if (!entry.seen.has(id)) {
        entry.seen.add(id);
        entry.ids.push(id);
      }
    for (const k of row.keys) entry.keys.add(k);
    merged.set(key, entry);
  }
  for (const entry of merged.values()) {
    const keys = [...entry.keys].sort();
    for (let i = 0; i < entry.ids.length; i += CHANGE_IDS_PER_EVENT)
      await host.env.emit(CHANGE_TOPIC, {
        model: entry.model,
        action: entry.action,
        ids: entry.ids.slice(i, i + CHANGE_IDS_PER_EVENT),
        ...(entry.action === 'unlink' ? {} : { keys }),
        ...(host.env.reason === undefined ? {} : { reason: host.env.reason }),
      });
  }
}
