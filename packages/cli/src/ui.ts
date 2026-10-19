/**
 * Terminal output (RFC 0019 §7.7). On an interactive terminal: section icons, colors, an animated spinner and
 * progress bar on a live line, boxed banners, and an arrow-key picker. Plain ASCII for CI logs and `NO_COLOR`; one
 * JSON object per line with `--json`. No dependency: `node:util` `styleText` and a few ANSI sequences.
 */
import { styleText } from 'node:util';

/** How output is rendered. */
export type OutputMode = 'fancy' | 'plain' | 'json';

type Style = Parameters<typeof styleText>[0];

/** A key the arrow-key picker understands. */
export type Key = 'up' | 'down' | 'space' | 'enter' | 'all' | 'cancel' | 'other';

/** What the renderer needs from the CLI's I/O. */
export interface UiIo {
  write(text: string): void;
  error(text: string): void;
  /** True when stdout is an interactive terminal. */
  readonly isTTY?: boolean;
  /** Asks a question on an interactive terminal; `undefined` when there is none. */
  readonly prompt?: (question: string) => Promise<string>;
  /** The next key press, in raw mode (arrow-key pickers); `undefined` when keys cannot be read. */
  readonly readKey?: () => Promise<Key>;
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
  pointer: '❯',
  arrow: '→',
  branch: '├─',
  last: '└─',
  bar: '━',
  head: '╸',
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
  pointer: '>',
  arrow: '->',
  branch: '|-',
  last: '`-',
  bar: '#',
  head: '',
  rest: '.',
} as const;

/** Spinner frames (braille dots), about 80 ms each. */
export const SPINNER: readonly string[] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const FRAME_MS = 80;
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

/** A piece of work shown with a spinner until it ends. */
export interface Task {
  /** Changes the text next to the spinner. */
  update(text: string): void;
  /** Ends with ✔ and `text` (default: the last text). */
  done(text?: string): void;
  /** Ends with ✖ and `text`. */
  fail(text?: string): void;
}

/** One option of {@link Ui.choose}. */
export interface Choice {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
  readonly glyph?: string;
  readonly checked: boolean;
  /** Always selected; cannot be unchecked (required apps). */
  readonly locked?: boolean;
}

/** The output helpers commands use. */
export interface Ui {
  readonly mode: OutputMode;
  readonly symbols: typeof FANCY | typeof PLAIN;
  /** Styles text in fancy mode; returns it unchanged otherwise. */
  style(format: Style, text: string): string;
  /** A module glyph in fancy mode, nothing otherwise. */
  glyph(glyph: string | undefined): string;
  line(text?: string): void;
  /** A section title; `icon` replaces the ◆ on a terminal. */
  heading(text: string, icon?: string): void;
  ok(text: string): void;
  warn(text: string): void;
  fail(text: string): void;
  info(text: string): void;
  /** A JSON line (json mode only). */
  json(value: unknown): void;
  /** Left-aligned columns, two spaces apart. */
  table(rows: readonly (readonly string[])[], indent?: number): void;
  /** A rounded box around `lines` (fancy); the lines indented otherwise. */
  box(
    lines: readonly string[],
    options?: { readonly title?: string; readonly color?: Style },
  ): void;
  /** A progress bar: `━━━━━━╸───  58%  7/12`. */
  bar(done: number, total: number, width?: number): string;
  /** Replaces the live line, with an animated spinner in front (fancy mode); plain mode prints nothing. */
  live(text: string): void;
  /** Clears the live line and stops the animation. */
  settle(): void;
  /** Work with a spinner (fancy) that ends as a ✔ / ✖ line (every mode but json). */
  task(text: string): Task;
  /** Asks a question with a default; returns the default when not interactive. */
  ask(question: string, fallback: string): Promise<string>;
  /** Asks yes / no; `undefined` when not interactive. */
  confirm(question: string, fallback: boolean): Promise<boolean | undefined>;
  /**
   * An arrow-key checklist (↑/↓ move, space toggles, `a` all, Enter confirms). Returns the selected values, or
   * `undefined` when keys cannot be read (then ask another way).
   */
  choose(question: string, choices: readonly Choice[]): Promise<readonly string[] | undefined>;
}

/** Visible width of a string (ANSI sequences removed, wide glyphs count as two). */
export function visibleWidth(text: string): number {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences are what we strip.
  const plain = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
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

  // The live line: text redrawn with the next spinner frame every FRAME_MS while something runs.
  let liveText: string | undefined;
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const draw = (): void => {
    if (liveText === undefined) return;
    io.write(`\r\x1b[2K  ${style('cyan', SPINNER[frame % SPINNER.length] ?? '')} ${liveText}`);
  };
  const settle = (): void => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    if (liveText !== undefined) io.write(`\r\x1b[2K${SHOW_CURSOR}`);
    liveText = undefined;
  };
  const say = (text: string): void => {
    if (mode === 'json') return;
    const resume = liveText;
    settle();
    io.write(`${text}\n`);
    // A line printed while work runs goes above the live line, which keeps animating below it.
    if (resume !== undefined) live(resume);
  };
  function live(text: string): void {
    if (mode !== 'fancy') return;
    if (liveText === undefined) io.write(HIDE_CURSOR);
    liveText = text;
    draw();
    if (timer === undefined) {
      timer = setInterval(() => {
        frame++;
        draw();
      }, FRAME_MS);
      timer.unref(); // never keeps the process alive
    }
  }

  const ui: Ui = {
    mode,
    symbols,
    style,
    glyph: (glyph) => (mode === 'fancy' && glyph !== undefined ? `${glyph} ` : ''),
    line: (text = '') => say(text),
    heading: (text, icon) =>
      say(
        `\n${style('bold', `${mode === 'fancy' && icon !== undefined ? icon : symbols.step} ${text}`)}`,
      ),
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
    box(lines, options = {}) {
      if (mode !== 'fancy') {
        if (options.title !== undefined) say(`  ${options.title}`);
        for (const line of lines) say(`    ${line}`);
        return;
      }
      const color = options.color ?? 'cyan';
      const title = options.title === undefined ? '' : ` ${options.title} `;
      const inner = Math.max(visibleWidth(title) + 2, ...lines.map((l) => visibleWidth(l) + 4));
      say(
        `  ${style(color, '╭─')}${style('bold', title)}${style(color, `${'─'.repeat(inner - 1 - visibleWidth(title))}╮`)}`,
      );
      for (const line of lines)
        say(`  ${style(color, '│')}  ${pad(line, inner - 4)}  ${style(color, '│')}`);
      say(`  ${style(color, `╰${'─'.repeat(inner)}╯`)}`);
    },
    bar(done, total, width = 28) {
      const ratio = total === 0 ? 1 : Math.min(1, done / total);
      const filled = Math.floor(ratio * width);
      const head = filled < width && ratio > 0 ? symbols.head : '';
      const rest = width - filled - head.length;
      const percent = `${Math.round(ratio * 100)}%`.padStart(4);
      return `${style('green', symbols.bar.repeat(filled) + head)}${style('dim', symbols.rest.repeat(rest))} ${style('bold', percent)}  ${style('dim', `${done}/${total}`)}`;
    },
    live,
    settle,
    task(text) {
      const started = Date.now();
      let current = text;
      live(current);
      const end = (ok: boolean, final?: string): void => {
        settle();
        const ms = Date.now() - started;
        const time = ms >= 1000 ? style('dim', `  ${duration(ms)}`) : '';
        (ok ? ui.ok : ui.fail)(`${final ?? current}${time}`);
      };
      return {
        update(next) {
          current = next;
          live(next);
        },
        done: (final) => end(true, final),
        fail: (final) => end(false, final),
      };
    },
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
    async choose(question, choices) {
      const readKey = io.readKey;
      if (readKey === undefined || mode !== 'fancy' || choices.length === 0) return undefined;
      settle();
      const checked = choices.map((c) => c.checked || c.locked === true);
      let cursor = 0;
      const labelWidth = Math.max(
        ...choices.map((c) => visibleWidth(`${ui.glyph(c.glyph)}${c.label}`)),
      );
      const render = (): string[] => [
        `  ${style('cyan', symbols.ask)} ${style('bold', question)} ${style('dim', '↑/↓ move · space toggle · a all · enter confirm')}`,
        ...choices.map((c, i) => {
          const here = i === cursor;
          const box = checked[i] ? style('green', symbols.on) : style('dim', symbols.off);
          const label = pad(
            `${ui.glyph(c.glyph)}${here ? style('bold', c.label) : c.label}`,
            labelWidth,
          );
          const hint = c.locked === true ? 'required' : (c.hint ?? '');
          return `  ${here ? style('cyan', symbols.pointer) : ' '} ${box} ${label}  ${style('dim', hint)}`;
        }),
      ];
      io.write(HIDE_CURSOR);
      let lines = render();
      io.write(`${lines.join('\n')}\n`);
      try {
        for (;;) {
          const key = await readKey();
          if (key === 'cancel')
            throw new Error('Cancelled at the app picker: nothing was changed.');
          if (key === 'enter') break;
          if (key === 'up') cursor = (cursor + choices.length - 1) % choices.length;
          if (key === 'down') cursor = (cursor + 1) % choices.length;
          if (key === 'space' && choices[cursor]?.locked !== true)
            checked[cursor] = !checked[cursor];
          if (key === 'all') {
            const all = choices.every((c, i) => checked[i] || c.locked === true);
            choices.forEach((c, i) => {
              checked[i] = c.locked === true || !all;
            });
          }
          // Redraw in place: up to the first line, rewrite every line.
          io.write(`\x1b[${lines.length}A`);
          lines = render();
          io.write(`${lines.map((l) => `\x1b[2K${l}`).join('\n')}\n`);
        }
      } finally {
        io.write(SHOW_CURSOR);
      }
      const selected = choices.filter((_, i) => checked[i]);
      // Collapse the list into one answered line.
      io.write(`\x1b[${lines.length}A\x1b[J`);
      io.write(
        `  ${style('green', symbols.ok)} ${question} ${style('cyan', selected.map((c) => `${ui.glyph(c.glyph)}${c.label}`).join(', '))}\n`,
      );
      return selected.map((c) => c.value);
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
