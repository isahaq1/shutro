#!/usr/bin/env node
import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { runCli } from './cli.js';
import type { Key } from './ui.js';

const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;

if (process.stdout.isTTY === true) {
  // Animations hide the cursor; bring it back however the process ends.
  const showCursor = (): void => {
    process.stdout.write('\x1b[?25h');
  };
  process.on('exit', showCursor);
  process.on('SIGINT', () => {
    showCursor();
    process.stdout.write('\n');
    process.exit(130);
  });
}

/** One key press in raw mode, mapped to what the pickers understand. */
function readKey(): Promise<Key> {
  return new Promise((resolve) => {
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once(
      'keypress',
      (_text: string | undefined, key: { name?: string; ctrl?: boolean } | undefined) => {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        const name = key?.name;
        if (key?.ctrl === true && name === 'c') resolve('cancel');
        else if (name === 'escape') resolve('cancel');
        else if (name === 'up' || name === 'k') resolve('up');
        else if (name === 'down' || name === 'j') resolve('down');
        else if (name === 'space') resolve('space');
        else if (name === 'return' || name === 'enter') resolve('enter');
        else if (name === 'a') resolve('all');
        else resolve('other');
      },
    );
  });
}

process.exitCode = await runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  isTTY: process.stdout.isTTY === true,
  write: (text) => {
    process.stdout.write(text);
  },
  error: (text) => {
    process.stderr.write(text);
  },
  ...(interactive
    ? {
        // One readline per question, so the process can exit when the command is done.
        prompt: async (question: string) => {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          try {
            return await rl.question(question);
          } finally {
            rl.close();
          }
        },
        readKey,
      }
    : {}),
});
