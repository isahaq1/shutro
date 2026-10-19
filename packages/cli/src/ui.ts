/**
 * Terminal output (RFC 0019 §7.7): glyphs, colors and a live progress line on an interactive terminal; plain ASCII
 * for CI logs and `NO_COLOR`; one JSON object per line with `--json`. No dependency: `node:util` `styleText` and
 * two ANSI sequences.
 */
import { styleText } from 'node:util';

/** How output is rendered. */
export type OutputMode = 'fancy' | 'plain' | 'json';

type Style = Parameters<typeof styleText>[0];

/** What the renderer needs from the CLI's I/O. */
export interface UiIo {
  write(text: string): void;
  error(text: string): void;
  /** True when stdout is an interactive terminal. */
  readonly isTTY?: boolean;
  /** Asks a question on an interactive terminal; `undefined` when there is none. */
  readonly prompt?: (question: string) => Promise<string>;
}

/** Picks the mode: `--json` wins, then a TTY without `NO_COLOR` / `TERM=dumb` is fancy. */
export function outputMode(
  io: UiIo,
  env: Readonly<Record<string, string | undefined>>,
  json: boolean,
): OutputMode {
  if (json) return 'json';
  if (io.isTTY !== true) return 'plain';
  if (env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '') return 'plain';
  if (env['TERM'] === 'dumb') return 'plain';
  return 'fancy';
}

const FANCY = {
  ok: '✔',
  fail: '✖',
  warn: '⚠',
  info: '●',
  step: '◆',
  ask: '?',
  on: '◉',
  off: '◯',
  arrow: '→',
  branch: '├─',
  last: '└─',
  bar: '━',
  rest: '─',
} as const;
const PLAIN = {
  ok: '[ok]',
  fail: '[x]',
  warn: '[!]',
  info: '[-]',
  step: '==',
  ask: '?',
  on: '[x]',
  off: '[ ]',
  arrow: '->',
  branch: '|-',
  last: '`-',
  bar: '#',
  rest: '.',
} as const;

/** The output helpers commands use. */
export interface Ui {
  readonly mode: OutputMode;
  readonly symbols: typeof FANCY | typeof PLAIN;
  /** Styles text in fancy mode; returns it unchanged otherwise. */
  style(format: Style, text: string): string;
  /** A module glyph in fancy mode, nothing otherwise. */
  glyph(glyph: string | undefined): string;
  line(text?: string): void;
  heading(text: string): void;
  ok(text: string): void;
  warn(text: string): void;
  fail(text: string): void;
  info(text: string): void;
  /** A JSON line (json mode only). */
  json(value: unknown): void;
  /** Left-aligned columns, two spaces apart. */
  table(rows: readonly (readonly string[])[], indent?: number): void;
  /** A progress bar: `━━━━━────  3/9`. */
  bar(done: number, total: number, width?: number): string;
  /** Replaces the live line (fancy mode); plain mode prints nothing. */
  live(text: string): void;
  /** Clears the live line. */
  settle(): void;
  /** Asks a question with a default; returns the default when not interactive. */
  ask(question: string, fallback: string): Promise<string>;
  /** Asks yes / no; `undefined` when not interactive. */
  confirm(question: string, fallback: boolean): Promise<boolean | undefined>;
}

/** Visible width of a string (ANSI sequences removed, wide glyphs count as two). */
export function visibleWidth(text: string): number {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences are what we strip.
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '');
  let width = 0;
  for (const ch of plain) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0xfe0f || code === 0x200d) continue; // emoji variation selector, joiner
    width += code >= 0x1f000 || (code >= 0x2600 && code <= 0x27bf) ? 2 : 1;
  }
  return width;
}

const pad = (text: string, width: number): string =>
  text + ' '.repeat(Math.max(0, width - visibleWidth(text)));

/** Creates the renderer for `mode`. */
export function createUi(io: UiIo, mode: OutputMode): Ui {
  const symbols = mode === 'fancy' ? FANCY : PLAIN;
  const style = (format: Style, text: string): string =>
    mode === 'fancy' ? styleText(format, text, { validateStream: false }) : text;
  let liveShown = false;
  const settle = (): void => {
    if (liveShown) io.write('\r\x1b[2K');
    liveShown = false;
  };
  const say = (text: string): void => {
    if (mode === 'json') return;
    settle();
    io.write(`${text}\n`);
  };
  const ui: Ui = {
    mode,
    symbols,
    style,
    glyph: (glyph) => (mode === 'fancy' && glyph !== undefined ? `${glyph} ` : ''),
    line: (text = '') => say(text),
    heading: (text) => say(`\n${style('bold', `${symbols.step} ${text}`)}`),
    ok: (text) => say(`  ${style('green', symbols.ok)} ${text}`),
    warn: (text) => say(`  ${style('yellow', symbols.warn)} ${text}`),
    fail: (text) => say(`  ${style('red', symbols.fail)} ${text}`),
    info: (text) => say(`  ${style('cyan', symbols.info)} ${text}`),
    json: (value) => {
      if (mode === 'json') io.write(`${JSON.stringify(value)}\n`);
    },
    table(rows, indent = 4) {
      const widths: number[] = [];
      for (const row of rows)
        row.forEach((cell, i) => {
          widths[i] = Math.max(widths[i] ?? 0, visibleWidth(cell));
        });
      for (const row of rows)
        say(
          `${' '.repeat(indent)}${row
            .map((cell, i) => (i === row.length - 1 ? cell : pad(cell, widths[i] ?? 0)))
            .join('  ')}`.trimEnd(),
        );
    },
    bar(done, total, width = 32) {
      const filled = total === 0 ? width : Math.round((done / total) * width);
      return `${style('green', symbols.bar.repeat(filled))}${style('dim', symbols.rest.repeat(width - filled))}  ${done}/${total}`;
    },
    live(text) {
      if (mode !== 'fancy') return;
      io.write(`\r\x1b[2K${text}`);
      liveShown = true;
    },
    settle,
    async ask(question, fallback) {
      if (io.prompt === undefined || mode === 'json') return fallback;
      settle();
      const answer = (
        await io.prompt(
          `  ${style('cyan', symbols.ask)} ${question} ${style('dim', `(${fallback})`)} `,
        )
      ).trim();
      return answer === '' ? fallback : answer;
    },
    async confirm(question, fallback) {
      if (io.prompt === undefined || mode === 'json') return undefined;
      settle();
      const hint = fallback ? 'Y/n' : 'y/N';
      const answer = (
        await io.prompt(`  ${style('cyan', symbols.ask)} ${question} ${style('dim', `(${hint})`)} `)
      )
        .trim()
        .toLowerCase();
      if (answer === '') return fallback;
      return answer === 'y' || answer === 'yes';
    },
  };
  return ui;
}

/** `1.2s` / `340ms`. */
export function duration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/** `1,284`. */
export function count(n: number): string {
  return n.toLocaleString('en-US');
}
