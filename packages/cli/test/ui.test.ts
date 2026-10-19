/**
 * Terminal output modes (RFC 0019 §7.7), password redaction, and module packages named in the config.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test, vi } from 'vitest';
import {
  ConfigError,
  createUi,
  type Key,
  outputMode,
  redact,
  SPINNER,
  visibleWidth,
} from '../src/index.js';
import { isPackageSpecifier, resolvePackageEntry } from '../src/resolve.js';

/** Removes color sequences, so assertions read what the terminal shows. */
function stripAnsi(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences are what we strip.
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

function capture(isTTY: boolean, answers: string[] = [], keys?: Key[]) {
  let out = '';
  return {
    get out() {
      return out;
    },
    isTTY,
    write: (t: string) => {
      out += t;
    },
    error: (t: string) => {
      out += t;
    },
    ...(answers.length === 0 ? {} : { prompt: async () => answers.shift() ?? '' }),
    ...(keys === undefined ? {} : { readKey: async (): Promise<Key> => keys.shift() ?? 'enter' }),
  };
}

describe('output mode', () => {
  test('--json wins; a terminal is fancy unless NO_COLOR or TERM=dumb', () => {
    expect(outputMode(capture(true), {}, true)).toBe('json');
    expect(outputMode(capture(true), {}, false)).toBe('fancy');
    expect(outputMode(capture(false), {}, false)).toBe('plain');
    expect(outputMode(capture(true), { NO_COLOR: '1' }, false)).toBe('plain');
    expect(outputMode(capture(true), { TERM: 'dumb' }, false)).toBe('plain');
  });

  test('plain output is ASCII: no colors, no glyphs, no live line', () => {
    const io = capture(false);
    const ui = createUi(io, 'plain');
    ui.ok('installed');
    ui.warn('careful');
    ui.live('progress');
    ui.line(`${ui.glyph('🛒')}purchase ${ui.bar(1, 2, 4)}`);
    expect(io.out).toBe('  [ok] installed\n  [!] careful\npurchase ##..  50%  1/2\n');
    expect(io.out).toMatch(/^[\x20-\x7e\n]*$/);
  });

  test('fancy output has glyphs, colors, and a spinner line that hides the cursor until it settles', () => {
    const io = capture(true);
    const ui = createUi(io, 'fancy');
    ui.live('working');
    expect(io.out).toContain('\x1b[?25l'); // cursor hidden while animating
    expect(io.out).toContain('\r\x1b[2K  \x1b[36m⠋\x1b[39m working');
    ui.ok(`${ui.glyph('🛒')}purchase`); // printed above the live line, which comes back
    expect(io.out).toContain('✔');
    expect(io.out).toContain('🛒 purchase');
    ui.settle();
    expect(io.out.endsWith('\r\x1b[2K\x1b[?25h')).toBe(true); // cleared, cursor shown
  });

  test('the spinner animates every 80 ms and stops when settled', () => {
    vi.useFakeTimers();
    try {
      const io = capture(true);
      const ui = createUi(io, 'fancy');
      ui.live('installing');
      vi.advanceTimersByTime(80 * 3);
      for (const frame of SPINNER.slice(0, 4))
        expect(io.out).toContain(`${frame}\x1b[39m installing`);
      ui.settle();
      const after = io.out.length;
      vi.advanceTimersByTime(800);
      expect(io.out.length).toBe(after);
    } finally {
      vi.useRealTimers();
    }
  });

  test('tasks end as a ✔ or ✖ line in every mode but json', () => {
    const plain = capture(false);
    const ui = createUi(plain, 'plain');
    ui.task('Connecting').done('Connected');
    ui.task('Creating').fail('Cannot create');
    expect(plain.out).toBe('  [ok] Connected\n  [x] Cannot create\n');
    const json = capture(false);
    createUi(json, 'json').task('hidden').done();
    expect(json.out).toBe('');
  });

  test('boxes and the progress bar', () => {
    const io = capture(true);
    const ui = createUi(io, 'fancy');
    ui.box(['5 apps ready'], { title: 'Ready' });
    const plain = stripAnsi(io.out);
    expect(plain).toBe('  ╭─ Ready ────────╮\n  │  5 apps ready  │\n  ╰────────────────╯\n');
    const bar = stripAnsi(ui.bar(7, 12, 10));
    expect(bar).toBe('━━━━━╸────  58%  7/12'); // percentages right-aligned
    expect(stripAnsi(ui.bar(12, 12, 10))).toBe('━━━━━━━━━━ 100%  12/12');
  });

  test('the arrow-key picker: move, toggle, all; required stays on', async () => {
    const keys: Key[] = ['down', 'space', 'down', 'space', 'up', 'up', 'space', 'enter'];
    const io = capture(true, [], keys);
    const ui = createUi(io, 'fancy');
    const picked = await ui.choose('Apps', [
      { value: 'settings', label: 'Settings', checked: true, locked: true },
      { value: 'account', label: 'Accounting', glyph: '📒', checked: true },
      { value: 'sale', label: 'Sales', checked: false },
    ]);
    // down→account (off), down→sale (on), up up→settings: locked, stays on.
    expect(picked).toEqual(['settings', 'sale']);
    expect(io.out).toContain('\x1b[?25h'); // cursor restored
    expect(stripAnsi(io.out)).toContain('✔ Apps Settings, Sales');

    const all: Key[] = ['all', 'enter'];
    const io2 = capture(true, [], all);
    expect(
      await createUi(io2, 'fancy').choose('Apps', [
        { value: 'a', label: 'A', checked: true },
        { value: 'b', label: 'B', checked: false },
      ]),
    ).toEqual(['a', 'b']);

    const esc: Key[] = ['cancel'];
    const io3 = capture(true, [], esc);
    await expect(
      createUi(io3, 'fancy').choose('Apps', [{ value: 'a', label: 'A', checked: true }]),
    ).rejects.toThrow(/nothing was changed/);
    expect(io3.out).toContain('\x1b[?25h');
  });

  test('without key input or a terminal, the picker steps aside', async () => {
    expect(
      await createUi(capture(true), 'fancy').choose('Apps', [
        { value: 'a', label: 'A', checked: true },
      ]),
    ).toBeUndefined();
    const io = capture(false, [], ['enter']);
    expect(
      await createUi(io, 'plain').choose('Apps', [{ value: 'a', label: 'A', checked: true }]),
    ).toBeUndefined();
  });

  test('json mode prints only JSON lines', () => {
    const io = capture(false);
    const ui = createUi(io, 'json');
    ui.ok('hidden');
    ui.json({ type: 'done' });
    expect(io.out).toBe('{"type":"done"}\n');
  });

  test('tables align on visible width (emoji count as two columns)', () => {
    expect(visibleWidth('🛒 Purchase')).toBe(11);
    expect(visibleWidth('\x1b[32mok\x1b[39m')).toBe(2);
    const io = capture(false);
    createUi(io, 'plain').table([
      ['a', 'x'],
      ['long', 'y'],
    ]);
    expect(io.out).toBe('    a     x\n    long  y\n');
  });

  test('questions take the default without a terminal, and the answer with one', async () => {
    expect(await createUi(capture(false), 'plain').ask('Company', 'Acme')).toBe('Acme');
    expect(await createUi(capture(false), 'plain').confirm('Sure?', true)).toBeUndefined();
    const io = capture(true, ['Globex', '', 'n']);
    const ui = createUi(io, 'fancy');
    expect(await ui.ask('Company', 'Acme')).toBe('Globex');
    expect(await ui.confirm('Install?', true)).toBe(true); // empty answer: the default
    expect(await ui.confirm('Delete?', false)).toBe(false);
  });
});

describe('redact', () => {
  test('passwords never reach the screen or the config', () => {
    expect(redact('postgres://erp:s3cret@db.local:5432/erp')).toBe(
      'postgres://erp@db.local:5432/erp',
    );
    expect(redact('postgres://db.local/erp')).toBe('postgres://db.local/erp');
  });
});

describe('module packages', () => {
  const root = mkdtempSync(join(tmpdir(), 'shutro-resolve-'));
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('bare specifiers are packages; paths are not', () => {
    expect(isPackageSpecifier('@shutro/apps')).toBe(true);
    expect(isPackageSpecifier('shutro/apps')).toBe(true);
    expect(isPackageSpecifier('./modules/sale/module.ts')).toBe(false);
    expect(isPackageSpecifier('/abs/module.ts')).toBe(false);
    expect(isPackageSpecifier('C:\\abs\\module.ts')).toBe(false);
  });

  test('entries resolve through exports subpaths and conditions, from node_modules above the project', () => {
    const pkg = join(root, 'node_modules', 'erp-pack');
    mkdirSync(join(pkg, 'dist', 'apps'), { recursive: true });
    writeFileSync(join(pkg, 'dist', 'apps', 'index.js'), 'export {};\n');
    writeFileSync(join(pkg, 'dist', 'index.js'), 'export {};\n');
    writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({
        name: 'erp-pack',
        exports: {
          '.': { types: './dist/index.d.ts', default: './dist/index.js' },
          './apps': { types: './dist/apps/index.d.ts', default: './dist/apps/index.js' },
        },
      }),
    );
    const project = join(root, 'projects', 'acme');
    mkdirSync(project, { recursive: true });
    expect(resolvePackageEntry('erp-pack/apps', project)).toBe(
      join(pkg, 'dist', 'apps', 'index.js'),
    );
    expect(resolvePackageEntry('erp-pack', project)).toBe(join(pkg, 'dist', 'index.js'));
    expect(() => resolvePackageEntry('erp-pack/missing', project)).toThrow(ConfigError);
    expect(() => resolvePackageEntry('not-installed-anywhere', project)).toThrow(/npm install/);
  });

  test('a workspace package resolves to its sources when the CLI runs from sources', () => {
    expect(resolvePackageEntry('@shutro/apps', root)).toMatch(
      /packages[\\/]apps[\\/]src[\\/]index\.ts$/,
    );
  });
});
