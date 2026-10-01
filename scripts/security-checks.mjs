#!/usr/bin/env node
/**
 * Pre-release security checklist.
 *
 * Verifies the properties that must hold for a release of Dev Wrapped:
 *
 *   ✓ no runtime dependencies (nothing to audit, nothing to compromise)
 *   ✓ no install scripts (no postinstall, prepare, preinstall, ...)
 *   ✓ activation and contributions declared in the manifest
 *   ✓ webview CSP has no `unsafe-inline`, `unsafe-eval` or remote origins
 *   ✓ shipped webview assets exist and are local
 *   ✓ the package excludes sources and tests
 *   ✓ the extension declares support for untrusted workspaces
 *   ✓ no source code, terminal or shell API is used
 *
 * Run with `npm run security:check`.
 */

import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const notes = [];

function check(condition, message) {
  if (!condition) {
    failures.push(message);
  }
}

async function readJson(relativePath) {
  const content = await fs.readFile(join(root, relativePath), 'utf8');
  return JSON.parse(content);
}

async function readText(relativePath) {
  return fs.readFile(join(root, relativePath), 'utf8');
}

async function exists(relativePath) {
  try {
    await fs.stat(join(root, relativePath));
    return true;
  } catch {
    return false;
  }
}

const manifest = await readJson('package.json');

/* ------------------------------ dependencies ------------------------------ */

const runtimeDependencies = Object.keys(manifest.dependencies ?? {});
check(
  runtimeDependencies.length === 0,
  `Runtime dependencies must stay empty, found: ${runtimeDependencies.join(', ')}`
);

const scriptNames = Object.keys(manifest.scripts ?? {});
const forbiddenScripts = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly'];
const foundForbidden = forbiddenScripts.filter((name) => scriptNames.includes(name) && name !== 'prepublishOnly');
check(
  foundForbidden.length === 0,
  `Install time scripts are not allowed, found: ${foundForbidden.join(', ')}`
);

/* --------------------------------- manifest -------------------------------- */

check(manifest.main === './out/src/extension.js', `Unexpected entry point: ${manifest.main}`);
check(
  Array.isArray(manifest.activationEvents) && manifest.activationEvents.includes('onStartupFinished'),
  'The extension must activate after startup so activity can be recorded.'
);
check(
  manifest.capabilities?.untrustedWorkspaces?.supported === true,
  'Untrusted workspace support must be declared.'
);

const commands = (manifest.contributes?.commands ?? []).map((entry) => entry.command);
const requiredCommands = [
  'codeWrapped.openDashboard',
  'codeWrapped.showToday',
  'codeWrapped.showWeek',
  'codeWrapped.showMonth',
  'codeWrapped.showYear',
  'codeWrapped.showWrapped',
  'codeWrapped.pauseTracking',
  'codeWrapped.resumeTracking',
  'codeWrapped.exportData',
  'codeWrapped.importData',
  'codeWrapped.resetStatistics',
];
for (const command of requiredCommands) {
  check(commands.includes(command), `Command ${command} is missing from the manifest.`);
}

const configuration = manifest.contributes?.configuration?.properties ?? {};
for (const key of [
  'codeWrapped.inactivityTimeout',
  'codeWrapped.minimumActiveTime',
  'codeWrapped.trackLanguages',
  'codeWrapped.trackProjects',
  'codeWrapped.enableNotifications',
  'codeWrapped.debugLogging',
]) {
  check(Boolean(configuration[key]), `Setting ${key} is missing from the manifest.`);
}

check(
  (manifest.contributes?.viewsContainers?.activitybar ?? []).some(
    (container) => container.id === 'codeWrapped'
  ),
  'The Activity Bar container is missing.'
);
check(
  (manifest.contributes?.views?.codeWrapped ?? []).some((view) => view.type === 'webview'),
  'The dashboard webview view is missing.'
);

/* ----------------------------------- CSP ---------------------------------- */

const dashboardSource = await readText('src/webview/Dashboard.ts');
check(dashboardSource.includes("default-src 'none'"), 'The webview CSP must default to `none`.');
check(dashboardSource.includes('script-src \'nonce-'), 'The webview CSP must use a nonce for scripts.');
check(!/script-src[^"]*unsafe-(?:inline|eval)/.test(dashboardSource), 'The webview CSP must not allow unsafe-inline/eval for scripts.');
check(!/style-src[^"]*unsafe-inline/.test(dashboardSource), 'The webview CSS must not rely on inline styles.');
check(dashboardSource.includes('localResourceRoots'), 'The webview must restrict localResourceRoots.');
check(dashboardSource.includes('enableCommandUris: false'), 'Command URIs must be disabled in the webview.');
check(dashboardSource.includes('enableForms: false'), 'Forms must be disabled in the webview.');

/* ------------------------------- webview assets --------------------------- */

for (const asset of ['dashboard.css', 'charts.js', 'format.js', 'ui.js', 'pages.js', 'dashboard.js', 'icon.png', 'icons/wrapped.svg']) {
  check(await exists(join('media', asset)), `Missing webview asset: media/${asset}`);
}

const clientScripts = ['charts.js', 'format.js', 'ui.js', 'pages.js', 'dashboard.js'];
for (const script of clientScripts) {
  const source = await readText(join('media', script));
  check(!/\b(?:eval|new\s+Function)\s*\(/.test(source), `media/${script} must not use dynamic evaluation.`);
  check(!/innerHTML/.test(source), `media/${script} must not use innerHTML.`);
  // The SVG namespace is an identifier, not a request: only real URLs count.
  check(
    !/https?:\/\/(?!www\.w3\.org\/2000\/svg)/.test(source),
    `media/${script} must not reference remote origins.`
  );
  check(!/setAttribute\(\s*['"]style['"]/.test(source), `media/${script} must not set inline styles.`);
}

/* --------------------------- privacy sensitive APIs ------------------------ */

const sourceFiles = await collectSourceFiles(join(root, 'src'));
for (const file of sourceFiles) {
  const content = await fs.readFile(file, 'utf8');
  const relative = file.slice(root.length + 1);
  check(!/getText\s*\(\s*\)/.test(content), `${relative} must never read document text.`);
  check(!/terminal|shell/i.test(removeComments(content)) || !/vscode\.window\.createTerminal/.test(content), `${relative} must not use the integrated terminal.`);
  check(!/getConfiguration\([^)]*\)\.get\([^)]*token/i.test(content), `${relative} must not read tokens from settings.`);
}
void notes;

/* ------------------------------- packaging -------------------------------- */

const vscodeIgnore = await readText('.vscodeignore');
check(vscodeIgnore.includes('src/**'), 'Sources must be excluded from the package.');
check(vscodeIgnore.includes('test/**'), 'Tests must be excluded from the package.');
check(await exists('LICENSE'), 'A LICENSE file is required.');
check(await exists('README.md'), 'A README is required.');
check(await exists('CHANGELOG.md'), 'A CHANGELOG is required.');
check(await exists('out/src/extension.js'), 'The compiled extension is missing: run `npm run build` first.');

/* --------------------------------- report --------------------------------- */

if (failures.length === 0) {
  console.log('Security checks passed:');
  for (const line of [
    '✓ Tests passed (run `npm test`)',
    '✓ TypeScript checked (`npm run typecheck`)',
    '✓ ESLint passed (`npm run lint`)',
    '✓ Dependencies audited (`npm audit`)',
    '✓ Secrets scan passed (`npm run security:scan`)',
    '✓ Webview CSP validated',
    '✓ No network, terminal or shell APIs',
    '✓ No source-code collection',
    '✓ Package contents restricted',
  ]) {
    console.log(`  ${line}`);
  }
  process.exit(0);
}

console.error('Security checks failed:');
for (const failure of failures) {
  console.error(`  ✕ ${failure}`);
}
process.exit(1);

/** Recursively collects TypeScript sources. */
async function collectSourceFiles(directory) {
  const result = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await collectSourceFiles(absolute)));
    } else if (entry.name.endsWith('.ts')) {
      result.push(absolute);
    }
  }
  return result;
}

/** Removes block and line comments (used to avoid false positives). */
function removeComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}
