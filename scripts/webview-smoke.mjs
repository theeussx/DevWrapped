#!/usr/bin/env node
/**
 * Webview render smoke test.
 *
 * The dashboard is plain browser JavaScript: it is not bundled and it is not
 * type checked, so a typo in `media/pages.js` would only be visible when a
 * user opens the panel. This script closes that gap. It builds a realistic
 * dashboard payload with the real analytics code (`out/src/**`), loads the
 * shipped webview assets in a tiny DOM shim and renders all thirteen pages and
 * all eight Wrapped slides twice: once with a year of data and once against an
 * empty database (the state every fresh install sees).
 *
 * It fails when a renderer throws, returns nothing, or renders text containing
 * `undefined`, `NaN`, `Invalid Date` or `[object Object]` — the signature of a
 * payload field that was renamed or never produced.
 *
 * Run with `npm run test:webview` (requires `npm run build` first).
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const DAY = 86_400_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;

/* --------------------------------- DOM shim -------------------------------- */

class ClassList {
  constructor(node) {
    this.node = node;
  }
  add(...names) {
    for (const name of names) {
      this.node.classes.add(name);
    }
  }
  remove(...names) {
    for (const name of names) {
      this.node.classes.delete(name);
    }
  }
  contains(name) {
    return this.node.classes.has(name);
  }
  toggle(name) {
    if (this.node.classes.has(name)) {
      this.node.classes.delete(name);
    } else {
      this.node.classes.add(name);
    }
  }
}

function matches(node, selector) {
  if (selector.startsWith('[')) {
    return node.getAttribute(selector.slice(1, -1).split('=')[0]) !== null;
  }
  if (selector.startsWith('.')) {
    return node.classList.contains(selector.slice(1));
  }
  if (selector.startsWith('#')) {
    return node.getAttribute('id') === selector.slice(1);
  }
  return node.tagName === selector.toUpperCase();
}

class Element {
  constructor(tag, namespace = null) {
    this.tagName = String(tag).toUpperCase();
    this.namespaceURI = namespace;
    this.classes = new Set();
    this.attributes = new Map();
    this.listeners = new Map();
    this.childNodes = [];
    this.text = '';
    this.style = { setProperty() {}, removeProperty() {} };
    this.dataset = {};
    this.classList = new ClassList(this);
    this.parentNode = null;
  }
  get className() {
    return [...this.classes].join(' ');
  }
  set className(value) {
    this.classes = new Set(String(value).split(/\s+/).filter(Boolean));
  }
  get children() {
    return this.childNodes.filter((child) => child instanceof Element);
  }
  appendChild(child) {
    if (child === null || child === undefined) {
      throw new Error(`appendChild(undefined) on <${this.tagName.toLowerCase()}>`);
    }
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  append(...nodes) {
    for (const node of nodes) {
      this.appendChild(node);
    }
  }
  removeChild(child) {
    this.childNodes = this.childNodes.filter((node) => node !== child);
    child.parentNode = null;
    return child;
  }
  remove() {
    if (this.parentNode) {
      this.parentNode.removeChild(this);
    }
  }
  replaceChildren(...nodes) {
    this.childNodes = [];
    this.append(...nodes);
  }
  setAttribute(name, value) {
    if (value === null || value === undefined) {
      return;
    }
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  set textContent(value) {
    this.text = String(value);
    this.childNodes = [];
  }
  get textContent() {
    if (this.text) {
      return this.text;
    }
    return this.childNodes.map((child) => child.textContent ?? '').join('');
  }
  set innerHTML(_value) {
    throw new Error('innerHTML is forbidden in the webview');
  }
  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }
  removeEventListener() {}
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  querySelectorAll(selector) {
    const found = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (matches(child, selector)) {
          found.push(child);
        }
        walk(child);
      }
    };
    walk(this);
    return found;
  }
  focus() {}
}

class TextNode {
  constructor(text) {
    this.nodeType = 3;
    this.textContent = String(text);
  }
}

function createDocument() {
  const body = new Element('body');
  return {
    body,
    documentElement: new Element('html'),
    createElement: (tag) => new Element(tag),
    createElementNS: (namespace, tag) => new Element(tag, namespace),
    createTextNode: (text) => new TextNode(text),
    createDocumentFragment: () => new Element('#fragment'),
    getElementById: (id) => body.querySelectorAll(`#${id}`)[0] ?? null,
    querySelector: (selector) => body.querySelector(selector),
    querySelectorAll: (selector) => body.querySelectorAll(selector),
    addEventListener() {},
  };
}

/* ------------------------------ fixture data ------------------------------- */

function dateKey(timestamp) {
  const date = new Date(timestamp);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function buildFixture(now) {
  const days = {};
  const sessions = [];
  const projects = {
    'p-devwrapped': { id: 'p-devwrapped', name: 'dev-wrapped', firstSeen: now - 400 * DAY, lastSeen: now },
    'p-api': { id: 'p-api', name: 'api-server', firstSeen: now - 300 * DAY, lastSeen: now },
  };
  let session = 0;
  for (let offset = 400; offset >= 0; offset -= 1) {
    if (offset % 7 === 3 || offset % 11 === 5) {
      continue;
    }
    const stamp = now - offset * DAY;
    const ms = Math.round((45 + ((offset * 37) % 200)) * MINUTE);
    const typescript = Math.round(ms * 0.6);
    const python = Math.round(ms * 0.25);
    const start = new Date(stamp);
    start.setHours(9 + (offset % 6), 5 + (offset % 40), 0, 0);
    const key = dateKey(stamp);
    days[key] = {
      date: key,
      activeTime: ms,
      sessions: 2,
      languages: { typescript, python, markdown: ms - typescript - python },
      projects: { 'p-devwrapped': Math.round(ms * 0.7), 'p-api': ms - Math.round(ms * 0.7) },
      filesModified: 6 + (offset % 9),
      filesSaved: 3 + (offset % 5),
      filesOpened: 4 + (offset % 4),
      firstActivity: start.getTime(),
      lastActivity: start.getTime() + ms + 25 * MINUTE,
      longestSession: Math.round(ms * 0.7),
      hourly: Array.from({ length: 24 }, (_, hour) => (hour >= 9 && hour <= 17 ? Math.round(ms / 9) : 0)),
    };
    session += 1;
    sessions.push({
      id: `s${session}`,
      startTime: start.getTime(),
      endTime: start.getTime() + Math.round(ms * 0.7),
      duration: Math.round(ms * 0.7),
      language: 'typescript',
      project: 'p-devwrapped',
      projectName: 'dev-wrapped',
    });
    session += 1;
    sessions.push({
      id: `s${session}`,
      startTime: start.getTime() + Math.round(ms * 0.7) + 5 * MINUTE,
      endTime: start.getTime() + ms + 25 * MINUTE,
      duration: ms - Math.round(ms * 0.7),
      language: 'python',
      project: 'p-api',
      projectName: 'api-server',
    });
  }
  return { days, sessions, projects };
}

function buildInputs(now) {
  const meta = {
    schemaVersion: 2,
    createdAt: now - 400 * DAY,
    updatedAt: now,
    retentionDays: 1095,
    privacySalt: 'fixture-salt',
    onboarded: true,
    lastWrappedYear: new Date(now).getFullYear() - 1,
  };
  const settings = {
    inactivityTimeout: 10,
    minimumActiveTime: 10,
    trackLanguages: true,
    trackProjects: true,
    enableNotifications: false,
    debugLogging: false,
    showStatusBar: true,
    sessionRetentionDays: 1095,
  };
  const tracking = {
    enabled: true,
    paused: false,
    sessionActive: true,
    sessionStart: now - 10 * MINUTE,
    sessionActiveTime: 10 * MINUTE,
    todayActiveTime: 2 * HOUR,
    idleTimeoutMinutes: 10,
    minimumActiveTimeMinutes: 10,
  };
  const status = { tracking, currentStreak: 3, version: '1.0.0' };
  const directory = join(homedir(), '.vscode', 'globalStorage');
  const storage = {
    directory,
    dataFile: join(directory, 'devwrapped-data.json'),
    backupFile: join(directory, 'devwrapped-data.json.bak'),
    bytes: 123_456,
  };
  return { meta, settings, status, storage };
}

/* -------------------------------- rendering -------------------------------- */

const BAD_TEXT = /undefined|NaN|Invalid Date|\[object Object\]/;

function collectText(node, out = []) {
  if (node === undefined || node === null) {
    return out;
  }
  if (node.text) {
    out.push(node.text);
  }
  for (const child of node.childNodes ?? []) {
    collectText(child, out);
  }
  return out;
}

function loadWebview() {
  const document = createDocument();
  const sandbox = {
    document,
    console,
    window: { addEventListener() {}, removeEventListener() {}, document },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false }),
    setTimeout: (fn) => fn(),
    clearTimeout() {},
    requestAnimationFrame: (fn) => fn(),
    cancelAnimationFrame() {},
    Intl,
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  for (const file of ['format.js', 'charts.js', 'ui.js', 'pages.js']) {
    const source = readFileSync(join(root, 'media', file), 'utf8');
    vm.runInContext(source, context, { filename: `media/${file}` });
  }
  return sandbox;
}

const actions = {
  navigate() {},
  refresh() {},
  export() {},
  pause() {},
  resume() {},
  openSettings() {},
  openPrivacy() {},
  resetStatistics() {},
  selectYear() {},
  openYearPicker() {},
  setWrappedSlide() {},
  getWrappedSlide: () => 0,
};

const failures = [];

function renderAll(label, payload, webview) {
  const pages = webview.CodeWrappedPages;
  const ui = webview.CodeWrappedUi;
  if (!pages || !ui) {
    failures.push(`${label}: the webview globals were not registered`);
    return;
  }
  for (const [name, render] of Object.entries(pages)) {
    try {
      const node = render(payload, actions);
      if (!node) {
        throw new Error('renderer returned nothing');
      }
      ui.applyBarWidths(node);
      const suspicious = collectText(node).filter((text) => BAD_TEXT.test(text));
      if (suspicious.length > 0) {
        throw new Error(`suspicious text: ${suspicious.slice(0, 3).join(' | ')}`);
      }
      process.stdout.write(`  ok   ${label}/${name}\n`);
    } catch (error) {
      failures.push(`${label}/${name}: ${error.message}`);
      process.stdout.write(`  FAIL ${label}/${name}: ${error.message}\n`);
    }
  }
  const slides = payload.wrapped?.slides ?? [];
  for (const [index, slide] of slides.entries()) {
    try {
      const node = ui.wrappedSlide(slide, index, slides.length);
      const suspicious = collectText(node).filter((text) => BAD_TEXT.test(text));
      if (suspicious.length > 0) {
        throw new Error(`suspicious text: ${suspicious.slice(0, 3).join(' | ')}`);
      }
      process.stdout.write(`  ok   ${label}/slide-${index + 1}\n`);
    } catch (error) {
      failures.push(`${label}/slide-${index + 1}: ${error.message}`);
      process.stdout.write(`  FAIL ${label}/slide-${index + 1}: ${error.message}\n`);
    }
  }
}

/* ---------------------------------- main ----------------------------------- */

let buildDashboardPayload;
try {
  ({ buildDashboardPayload } = require(join(root, 'out', 'src', 'analytics', 'StatsService.js')));
} catch (error) {
  console.error('The compiled extension was not found. Run `npm run build` first.');
  console.error(error.message);
  process.exit(1);
}

const now = new Date('2026-10-01T18:30:00').getTime();
const fixture = buildFixture(now);
const { meta, settings, status, storage } = buildInputs(now);

const withData = buildDashboardPayload({
  data: { meta, days: fixture.days, sessions: fixture.sessions, projects: fixture.projects },
  settings,
  now,
  locale: 'en',
  weekStartsOn: 1,
  year: new Date(now).getFullYear(),
  version: '1.0.0',
  status,
  storage,
});

const empty = buildDashboardPayload({
  data: { meta, days: {}, sessions: [], projects: {} },
  settings,
  now,
  locale: 'en',
  weekStartsOn: 1,
  year: new Date(now).getFullYear(),
  version: '1.0.0',
  status,
  storage,
});

const webview = loadWebview();
renderAll('data', withData, webview);
renderAll('empty', empty, webview);

if (failures.length > 0) {
  console.error(`\nWebview smoke test failed with ${failures.length} problem(s).`);
  process.exit(1);
}
console.log('\nWebview smoke test passed: all pages and slides rendered.');
