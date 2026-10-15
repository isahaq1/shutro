/**
 * The dev-mode query inspector: records every statement a Shutro instance runs (SQL text, parameters, duration,
 * transaction), flags slow statements, and warns about N+1 patterns — the same SQL text run many times inside one
 * transaction attempt, which batched loads never do.
 */

/** One statement the inspector saw. */
export interface InspectedQuery {
  readonly sql: string;
  readonly params: readonly unknown[];
  readonly ms: number;
  /** Groups the statements of one transaction attempt. */
  readonly tx: string;
  readonly uid: number;
  /** Set when the statement failed. */
  readonly error?: string;
}

/** A pattern the inspector warns about. */
export interface InspectorWarning {
  readonly kind: 'n+1' | 'slow';
  readonly sql: string;
  readonly tx: string;
  /** How many times the statement ran in the transaction (n+1), or its duration (slow). */
  readonly count: number;
  readonly message: string;
}

/** Options of {@link createInspector}. */
export interface InspectorOptions {
  /** Same SQL text this many times in one transaction is an N+1 warning (default 10). */
  readonly n1Threshold?: number;
  /** Statements slower than this many milliseconds are reported (default 200). */
  readonly slowMs?: number;
  /** Keep at most this many statements (oldest dropped; default 5,000). */
  readonly limit?: number;
  /** Called once per warning as it happens (default: `process.emitWarning`). Pass `() => {}` to silence. */
  readonly onWarning?: (warning: InspectorWarning) => void;
}

/** The inspector: pass it to `createShutro({ inspector })` in development. */
export interface Inspector {
  readonly queries: readonly InspectedQuery[];
  readonly warnings: readonly InspectorWarning[];
  /** @internal Called by the environment around every statement. */
  record(query: InspectedQuery): void;
  /** Statements grouped by SQL text, most frequent first, with total and max duration. */
  summary(): readonly {
    readonly sql: string;
    readonly count: number;
    readonly totalMs: number;
    readonly maxMs: number;
  }[];
  /** A plain-text report (`shutro inspect --queries` prints it). */
  report(): string;
  clear(): void;
}

/** Creates an inspector. Not for production: it keeps parameters in memory. */
export function createInspector(options: InspectorOptions = {}): Inspector {
  const n1 = options.n1Threshold ?? 10;
  const slow = options.slowMs ?? 200;
  const limit = options.limit ?? 5_000;
  const warn =
    options.onWarning ??
    ((w: InspectorWarning) => process.emitWarning(w.message, { code: 'SHUTRO_INSPECTOR' }));
  const queries: InspectedQuery[] = [];
  const warnings: InspectorWarning[] = [];
  const perTx = new Map<string, Map<string, number>>();
  const flagged = new Set<string>();

  const add = (w: InspectorWarning): void => {
    warnings.push(w);
    warn(w);
  };

  return {
    queries,
    warnings,
    record(query) {
      queries.push(query);
      if (queries.length > limit) queries.splice(0, queries.length - limit);
      let counts = perTx.get(query.tx);
      if (counts === undefined) {
        counts = new Map();
        perTx.set(query.tx, counts);
        if (perTx.size > 1_000) perTx.delete(perTx.keys().next().value as string);
      }
      const count = (counts.get(query.sql) ?? 0) + 1;
      counts.set(query.sql, count);
      const key = `${query.tx}|${query.sql}`;
      if (count >= n1 && !flagged.has(key)) {
        flagged.add(key);
        add({
          kind: 'n+1',
          sql: query.sql,
          tx: query.tx,
          count,
          message: `Possible N+1: the same statement ran ${count} times in one transaction. Load the relation for the whole recordset (records.load({ ... })) instead of per record. SQL: ${query.sql.slice(0, 160)}`,
        });
      }
      if (query.ms >= slow) {
        add({
          kind: 'slow',
          sql: query.sql,
          tx: query.tx,
          count: Math.round(query.ms),
          message: `Slow statement (${Math.round(query.ms)} ms ≥ ${slow} ms): ${query.sql.slice(0, 160)}`,
        });
      }
    },
    summary() {
      const groups = new Map<
        string,
        { sql: string; count: number; totalMs: number; maxMs: number }
      >();
      for (const q of queries) {
        const g = groups.get(q.sql) ?? { sql: q.sql, count: 0, totalMs: 0, maxMs: 0 };
        g.count++;
        g.totalMs += q.ms;
        g.maxMs = Math.max(g.maxMs, q.ms);
        groups.set(q.sql, g);
      }
      return [...groups.values()].sort((a, b) => b.count - a.count || b.totalMs - a.totalMs);
    },
    report() {
      const lines = [`${queries.length} statement(s), ${warnings.length} warning(s)`];
      for (const g of this.summary().slice(0, 20)) {
        lines.push(
          `${String(g.count).padStart(5)}×  ${g.totalMs.toFixed(1).padStart(8)} ms  max ${g.maxMs.toFixed(1)} ms  ${g.sql.replace(/\s+/g, ' ').slice(0, 120)}`,
        );
      }
      for (const w of warnings) lines.push(`! ${w.kind}: ${w.message}`);
      return lines.join('\n');
    },
    clear() {
      queries.length = 0;
      warnings.length = 0;
      perTx.clear();
      flagged.clear();
    },
  };
}
