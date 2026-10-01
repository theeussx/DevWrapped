#!/usr/bin/env node
/**
 * Secret and policy scanner (offline, dependency free).
 *
 * Fails when it finds, anywhere in the repository:
 *  - credentials or high entropy tokens;
 *  - private keys;
 *  - absolute developer paths;
 *  - network APIs, child processes or dynamic code execution in shipped code.
 *
 * Run with `npm run security:scan`.
 */

import { promises as fs } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'out',
  'dist',
  'coverage',
  '.vscode-test',
]);
const TEXT_EXTENSIONS = new Set([
  '.ts',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.yml',
  '.yaml',
  '.css',
  '.html',
  '.svg',
  '.txt',
  '.sh',
  '.example',
]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Patterns that indicate a real credential. */
const SECRET_PATTERNS = [
  { name: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: 'GitHub fine grained token', pattern: /\bgithub_pat_[A-Za-z0-9_]{30,}\b/ },
  { name: 'OpenAI style key', pattern: /\bsk-[A-Za-z0-9]{24,}\b/ },
  { name: 'AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  { name: 'private key block', pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY/ },
  { name: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/ },
  {
    name: 'assigned secret literal',
    pattern: /(?:api[_-]?key|client[_-]?secret|access[_-]?token|password)\s*[:=]\s*['"][A-Za-z0-9+/_-]{20,}['"]/i,
  },
];

/** Patterns that must never appear in shipped code (offline + sandboxed). */
const FORBIDDEN_CODE_PATTERNS = [
  { name: 'network call (fetch)', pattern: /\bfetch\s*\(/ },
  { name: 'network module', pattern: /(?:from|require\()\s*['"](?:node:)?(?:http|https|net|dgram|tls|dns)['"]/ },
  { name: 'websocket', pattern: /\bnew\s+WebSocket\s*\(/ },
  { name: 'XMLHttpRequest', pattern: /\bXMLHttpRequest\b/ },
  { name: 'child process', pattern: /(?:from|require\()\s*['"](?:node:)?child_process['"]/ },
  { name: 'dynamic evaluation', pattern: /\b(?:eval|new\s+Function)\s*\(/ },
  { name: 'remote script', pattern: /<script[^>]+src\s*=\s*['"]https?:/i },
  { name: 'inline style attribute', pattern: /setAttribute\(\s*['"]style['"]/ },
];

/** Absolute paths that should never be committed. */
const PATH_PATTERNS = [
  { name: 'developer home path', pattern: /(?:\/home\/|\/Users\/|C:\\Users\\)[A-Za-z0-9._-]+\// },
];

const findings = [];

async function walk(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      await walk(absolute);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const extension = extname(entry.name).toLowerCase();
    if (!TEXT_EXTENSIONS.has(extension) && entry.name !== '.gitignore' && entry.name !== '.npmrc') {
      continue;
    }
    const info = await fs.stat(absolute);
    if (info.size > MAX_FILE_BYTES) {
      continue;
    }
    await scanFile(absolute);
  }
}

async function scanFile(absolute) {
  const relativePath = relative(root, absolute);
  const content = await fs.readFile(absolute, 'utf8');
  const lines = content.split(/\r?\n/);

  lines.forEach((line, index) => {
    // Fixtures that exercise the redaction rules are marked explicitly with a
    // `secret-scan:allow` comment on the line or just above it.
    const window = lines.slice(Math.max(0, index - 3), index + 1).join('\n');
    if (window.includes('secret-scan:allow')) {
      return;
    }
    for (const { name, pattern } of SECRET_PATTERNS) {
      if (pattern.test(line)) {
        findings.push({ file: relativePath, line: index + 1, kind: 'secret', name });
      }
    }
    for (const { name, pattern } of PATH_PATTERNS) {
      if (pattern.test(line)) {
        findings.push({ file: relativePath, line: index + 1, kind: 'path', name });
      }
    }
    // Only shipped code is held to the "no network / no eval" rule.
    if (relativePath.startsWith('src/') || relativePath.startsWith('media/')) {
      for (const { name, pattern } of FORBIDDEN_CODE_PATTERNS) {
        if (pattern.test(line) && !/^\s*(?:\*|\/\/)/.test(line)) {
          findings.push({ file: relativePath, line: index + 1, kind: 'policy', name });
        }
      }
    }
  });
}

await walk(root);

if (findings.length === 0) {
  console.log('Secret scan: no credentials, absolute paths or policy violations found.');
  process.exit(0);
}

console.error(`Secret scan found ${findings.length} issue(s):`);
for (const finding of findings) {
  console.error(`  ${finding.file}:${finding.line} [${finding.kind}] ${finding.name}`);
}
console.error('\nRemove the value from the repository (and rotate it if it was real).');
process.exit(1);
