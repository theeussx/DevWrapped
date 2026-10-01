#!/usr/bin/env node
/**
 * Test runner.
 *
 * `node --test "out/test/*.test.js"` only understands glob patterns from Node
 * 21 onwards, so the glob is expanded here instead. This keeps `npm test`
 * working on Node 20, Windows and every shell without extra dependencies.
 *
 * The compiled test files are imported directly: `node:test` executes the
 * tests as they are registered and sets the process exit code when one fails,
 * which is the same contract as `node --test <files>`.
 */

import { readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = join(root, 'out', 'test');

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

if (!(await exists(directory))) {
  console.error('The compiled tests were not found. Run `npm run build` first.');
  process.exit(1);
}

const entries = await readdir(directory);
const files = entries
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => join(directory, name));

if (files.length === 0) {
  console.error(`No *.test.js files found in ${directory}.`);
  process.exit(1);
}

for (const file of files) {
  await import(pathToFileURL(file).href);
}
