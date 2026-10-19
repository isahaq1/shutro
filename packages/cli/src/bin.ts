#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { runCli } from './cli.js';

const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;

process.exitCode = await runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  isTTY: process.stdout.isTTY === true,
  write: (text) => {
    process.stdout.write(text);
  },
  error: (text) => {
    process.stderr.write(text);
  },
  // One readline per question, so the process can exit when the command is done.
  ...(interactive
    ? {
        prompt: async (question: string) => {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          try {
            return await rl.question(question);
          } finally {
            rl.close();
          }
        },
      }
    : {}),
});
