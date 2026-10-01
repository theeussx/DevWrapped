# Dev Wrapped

**A Spotify Wrapped-style retrospective for your coding sessions — 100% local, no account, no telemetry.**

Dev Wrapped is a Visual Studio Code extension that quietly measures *when you were actually coding* and turns
that history into a dark, modern dashboard: today, this week, this month, this year, a GitHub-style heatmap
calendar, insights, comparisons and a shareable yearly retrospective.

It exists to answer questions like *"how much did I work on the API project this month?"* — **never**
*"how productive am I?"*. Dev Wrapped does not score you, rank you or grade your code. It only counts time,
editors, languages and projects, and it says "most active", not "best".

> **Dev Wrapped is not a productivity, quality or performance metric.** It is a mirror for your own habits.
> Please do not use it to evaluate yourself or anyone else.

---

## Table of contents

- [Highlights](#highlights)
- [Privacy by Design](#privacy-by-design)
- [Installation](#installation)
- [Quick start](#quick-start)
- [The dashboard](#the-dashboard)
- [Commands](#commands)
- [Settings](#settings)
- [How activity is measured](#how-activity-is-measured)
- [Data, storage and lifetime](#data-storage-and-lifetime)
- [Export, import and backups](#export-import-and-backups)
- [Security model](#security-model)
- [Architecture](#architecture)
- [Development](#development)
- [Testing and quality gates](#testing-and-quality-gates)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [Contributing](#contributing)
- [License](#license)

---

## Highlights

| | |
|---|---|
| ⏱️ **Real sessions, not uptime** | Activity is inferred from editor events (edit, create, save, editor switch, workspace switch) plus window focus. `VS Code is open` ≠ `you are coding`. |
| 🔌 **Offline by construction** | No HTTP client is imported anywhere in `src/`. The extension cannot talk to the internet, and neither can the webview. |
| 🧠 **Understandable analytics** | Daily / weekly / monthly / yearly totals, per-language and per-project breakdowns, session history, streaks, hourly and weekday distributions. |
| 🗓️ **Annual heatmap** | A GitHub-contribution-style calendar of the whole year, with the busiest day normalized to level 4. |
| 🎉 **Wrapped retrospective** | An eight-slide, year-in-review recap with a headline, records, trends and comparisons — exportable as a single self-contained HTML file. |
| 🧾 **Full data ownership** | Export JSON (backup), CSV (spreadsheet) or HTML (retrospective); import with validation, preview and an automatic safety copy. |
| 🔒 **Hardened webview** | Strict CSP, nonce'd scripts, `localResourceRoots` limited to `media/`, message allow-list, no `eval`, no remote resources, no CDN. |
| 🧪 **Tested** | Pure analytics, storage, tracking and security layers covered by a `node:test` suite that runs without VS Code. |

---

## Privacy by Design

Dev Wrapped is built so that the most private behaviour is also the default behaviour.
Every claim below is enforced by code, and the test suite verifies the important ones.

### What is collected

- **Timestamps** — when activity happened, to the second, stored as local day keys.
- **Durations** — how many milliseconds of activity belong to each editor tick and session.
- **Counts** — how many edits, file creates and saves happened, and how many different files were touched.
- **Language ids** — the identifier VS Code reports (`typescript`, `python`, …), sanitized to a safe alphabet.
- **Project labels** — an anonymized, salted hash of the workspace URI, plus the sanitized folder name.

### What is never collected

- ❌ Source code, file contents, diffs, selections or cursor positions.
- ❌ Full file paths, folder paths, or the name of any file you open.
- ❌ Terminal commands, task names, debug output, or process information.
- ❌ Passwords, tokens, API keys, environment variables or clipboard data.
- ❌ Git history, commit messages, branch names or repository remotes.
- ❌ Any identifier that could leave your machine: there is no account and no telemetry.

### The guarantees, and how they hold

1. **Local storage only.** Data lives in VS Code's own `globalStorage` folder for this extension
   (`…/User/globalStorage/theeussx.dev-wrapped/devwrapped-data.json`). Nothing is ever uploaded.
2. **No network code.** The ESLint configuration forbids importing `node:http`, `node:https`,
   `node:net`, `node:tls`, `node:dgram`, `node:child_process` or using global `fetch` anywhere in `src/`.
   `test/security.test.ts` fails the build if such an import appears.
3. **No remote webview resources.** The dashboard loads only files from `media/` through
   `webview.asWebviewUri()`, with `localResourceRoots` pinned to that folder. The Content Security Policy
   is `default-src 'none'` plus a per-load nonce for scripts; `connect-src`, `media-src`, `object-src`,
   `frame-src` and `worker-src` are all `'none'`.
4. **No dynamic code.** `eval`, `new Function` and `javascript:` URLs are banned by lint rules and by the
   security test, in both the extension host and the webview assets.
5. **Works with no account.** There is no sign-in, no sync, no cloud, no upsell. Ever.
6. **You are in control.** `Code Wrapped: Pause Tracking` stops collection immediately, resetting requires
   typing `RESET`, and importing requires an explicit confirmation with a safety copy written first.

### Data minimization by design

- Paths never reach the storage layer: `sanitizeProjectName()` keeps only the last folder segment, and
  project identity is a salted SHA-256 truncated to 16 hex characters. The salt lives in VS Code's
  `globalState`, not in the exported file.
- File-level counters are de-duplicated per document and per day, capped at 20 000 documents/day, and the
  tracker never needs to keep a file name to do it (it hashes identifiers too).
- Logs are written to a dedicated *Code Wrapped* output channel, only at the configured level, and every
  message is passed through `redactForLog()`, which strips paths and token-like strings.
- Untrusted workspaces are supported, because reading file contents is not something the extension does.

---

## Installation

### From the Marketplace (when published)

Search for **Dev Wrapped** in the Extensions view, or run:

```
code --install-extension theeussx.dev-wrapped
```

### From a VSIX

```bash
code --install-extension dev-wrapped-1.0.0.vsix
```

### From source

```bash
git clone https://github.com/theeussx/DevWrapped.git
cd DevWrapped
npm ci
npm run package     # produces dist/dev-wrapped-1.0.0.vsix
```

Or press **F5** in VS Code with this folder open to launch an Extension Development Host.

**Requirements:** VS Code 1.90+ and, to build from source, Node.js 20+.

---

## Quick start

1. Install the extension and open any workspace. Tracking starts automatically — there is nothing to configure.
2. Watch the status bar: it shows today's tracked activity (`$(graph) 1h 24m today`). Click it to open the dashboard.
3. Open the dashboard from the **Code Wrapped** Activity Bar icon, or with
   `Code Wrapped: Open Dashboard` from the Command Palette.
4. Explore **Today**, **Week**, **Month**, **Year**, **Activity**, **Languages**, **Projects**, **Sessions**,
   **Calendar**, **Insights** and **Privacy**.
5. When a year with data is complete, open **Wrapped** for the retrospective and use
   `Export Wrapped Retrospective` to save a self-contained HTML file.

To stop counting for a while, run `Code Wrapped: Pause Tracking` — the status bar makes the paused state
obvious, and `Code Wrapped: Resume Tracking` starts a fresh session.

---

## The dashboard

| Page | What it shows |
|---|---|
| **Overview** | Today's headline numbers, this week and this month at a glance, recent sessions, top languages and projects, current and longest streak. |
| **Today** | Hour-by-hour breakdown of the current day, session list and the day's records. |
| **Week** | The current week with a day-by-day comparison against the previous week, plus languages and projects for the period. |
| **Month** | Calendar view of the month (intensity per day), totals, comparison with the previous month. |
| **Year** | The full year: annual heatmap, month trend, records, weekly rhythm, languages, projects, and a comparison with the previous year. |
| **Activity** | A timeline of recent sessions with start, end, duration, language and project. |
| **Languages** | Time per language with bars, shares and an intensity legend. |
| **Projects** | Time per project, with the number of sessions and active days. |
| **Sessions** | The most recent sessions in detail (up to 300), grouped for scanning. |
| **Calendar** | Annual heatmap plus a month calendar with intensity levels 0–4. |
| **Insights** | Derived observations — busiest day, busiest hour, favourite language, longest session, streaks and simple period-over-period comparisons. |
| **Privacy** | Exactly what is stored, what is never stored, where the file lives and how to delete it. |
| **Wrapped** | The eight-slide yearly retrospective, with keyboard navigation (← / → / Space, Esc to leave). |

Every page has explicit **loading**, **empty** and **error** states, so a fresh install or a quiet week never
shows a broken layout.

---

## Commands

All commands live in the **Code Wrapped** category of the Command Palette.

| Command | Description |
|---|---|
| `Code Wrapped: Open Dashboard` | Opens the full dashboard in an editor tab. |
| `Code Wrapped: Show Today` | Opens the dashboard on the Today page. |
| `Code Wrapped: Show This Week` | Opens the dashboard on the Week page. |
| `Code Wrapped: Show This Month` | Opens the dashboard on the Month page. |
| `Code Wrapped: Show This Year` | Opens the dashboard on the Year page. |
| `Code Wrapped: Show Wrapped` | Opens the yearly retrospective. |
| `Code Wrapped: Pause Tracking` | Stops collecting activity until resumed. |
| `Code Wrapped: Resume Tracking` | Resumes collection; a new session starts. |
| `Code Wrapped: Export Data` | Exports JSON (full backup) or CSV (four spreadsheets). |
| `Code Wrapped: Export Wrapped Retrospective` | Exports the retrospective as a self-contained HTML file. |
| `Code Wrapped: Import Data` | Validates a JSON export, shows a preview, and imports after confirmation. |
| `Code Wrapped: Reset Statistics` | Deletes all stored statistics — requires typing `RESET`. |
| `Code Wrapped: Open Privacy Details` | Opens the Privacy page of the dashboard. |
| `Code Wrapped: Open Settings` | Opens the extension settings. |
| `Code Wrapped: Refresh` | Recomputes the dashboard from stored data. |
| `Code Wrapped: Show Diagnostics Log` | Shows the *Code Wrapped* output channel. |

---

## Settings

| Setting | Default | Description |
|---|---|---|
| `codeWrapped.inactivityTimeout` | `10` | Minutes without activity before the current session closes. Options: 5 / 10 / 15 / 30. |
| `codeWrapped.minimumActiveTime` | `10` | Minutes of activity needed for a day to count as *active* (drives streaks and active-day counts). Options: 10 / 30 / 60. |
| `codeWrapped.trackLanguages` | `true` | Record the VS Code language id of edited files. |
| `codeWrapped.trackProjects` | `true` | Record the anonymized project identifier and sanitized folder name. |
| `codeWrapped.enableNotifications` | `false` | Occasional notifications, e.g. when a new yearly retrospective is ready. |
| `codeWrapped.debugLogging` | `false` | Verbose diagnostics in the output channel. Never contains source code. |
| `codeWrapped.showStatusBar` | `true` | Show today's activity in the status bar. |
| `codeWrapped.sessionRetentionDays` | `1095` | Days of individual session detail retained (30–3650). Daily aggregates are always kept. |

---

## How activity is measured

Dev Wrapped subscribes to editor **metadata** events only:

- `onDidChangeTextDocument` (an edit happened — the text itself is never read),
- `onDidCreateFiles`, `onDidSaveTextDocument`,
- `onDidChangeActiveTextEditor` (editor switch),
- `onDidChangeWindowState` (focus / blur),
- `workspace.onDidChangeWorkspaceFolders` (workspace switch).

On each event the tracker records a tick with a timestamp. A 15-second timer flushes ticks into the current
session, with three rules that keep the numbers honest:

1. **Focus matters.** Ticks are only credited while a VS Code window is focused, so a forgotten window does
   not accumulate hours.
2. **Per-tick credit is capped** at 30 seconds, so a burst of events cannot inflate the total.
3. **The inactivity timeout wins.** A gap longer than `inactivityTimeout` ends the session, and a slice that
   would span such a gap is discarded instead of being counted as work.

Sessions shorter than one second are dropped, every session is clamped to 24 hours, and time is sliced at
hour boundaries and split at midnight so per-day, per-hour and per-language numbers always add up.
Time is attributed to each language and project proportionally to its share of the session.

---

## Data, storage and lifetime

- **Location:** VS Code `globalStorage` for `theeussx.dev-wrapped`:
  `devwrapped-data.json` (primary) plus `devwrapped-data.json.bak` (previous version).
- **Format:** a versioned JSON document (`schemaVersion`) with daily aggregates, sessions, project labels,
  counters and metadata. Unknown or unexpected fields are dropped on load.
- **Integrity:** writes are atomic — the new document is written to a temporary file, fsynced, and then
  renamed over the primary, after the previous primary has been moved to the backup. A crash never leaves a
  partially written file in place.
- **Recovery:** if the primary file is unreadable it is **quarantined** (renamed to
  `devwrapped-data.corrupt-<timestamp>.json`, never deleted) and the backup is used. If the backup is also
  unreadable, a fresh database is created; the damaged files remain on disk for inspection.
- **Retention:** individual sessions are pruned after `sessionRetentionDays` (default three years), while
  daily aggregates are permanent — so yearly charts never lose data.
- **Size limit:** the database is capped at 64 MB; writes beyond that are refused with a clear error instead
  of silently truncating history.
- **Reset:** `Code Wrapped: Reset Statistics` deletes stored statistics after a modal confirmation that
  requires typing `RESET`. Use `Export Data` first if you want to keep a copy.

---

## Export, import and backups

| Format | Contents |
|---|---|
| **JSON** | The complete database, including metadata. Ideal as a backup or for migrating machines. |
| **CSV** | A folder with `daily.csv`, `sessions.csv`, `languages.csv` and `projects.csv`. Cells are escaped, and values starting with `=`, `+`, `-` or `@` are neutralized so spreadsheet software cannot execute them. |
| **Wrapped HTML** | The yearly retrospective as one self-contained file: inline CSS, no scripts, no external references. |

Importing is deliberately careful:

1. The file must be a JSON export of Dev Wrapped, at most 64 MB.
2. It is parsed and validated against the schema; unknown top-level keys (including anything resembling
   credentials) are refused, invalid records are repaired or dropped, and the issues are reported.
3. You see a **preview** (date range, day/session/project counts, schema version) and must confirm.
4. Before anything is replaced, a safety copy of the current database is written
   (`before-import`); existing data is never silently overwritten.

---

## Security model

- **Validation at every boundary.** Every message from the webview is parsed by `parseWebviewMessage()`,
  which rebuilds a fresh object from an allow-list of message types and fields; extra properties are dropped
  and out-of-range values (such as years) are clamped or rejected.
- **Sanitization on output.** All values rendered as HTML are escaped; project names, language ids and file
  names are sanitized; CSV cells are injected-formula safe.
- **No path traversal.** Export file names are sanitized (`sanitizeFileName`) and confined to the folder the
  user picks.
- **Minimal dependencies.** The extension ships with **zero** runtime dependencies — only Node.js and the
  VS Code API. Build tooling is pinned in `package-lock.json`.
- **Supply-chain hygiene.** CI installs with `npm ci --ignore-scripts`, runs `npm audit --audit-level=high`,
  and a repository secret scan (`scripts/secret-scan.mjs`) blocks committed credentials, absolute paths and
  network calls in the source.
- **Least privilege.** No `child_process`, no shell, no network module, no `eval`; only the VS Code APIs
  needed to observe editor metadata and render the dashboard.

---

## Architecture

```
src/
├── extension.ts              activation, wiring, status bar, shutdown
├── types/                    shared contracts (statistics, config, dashboard, analytics, delta)
├── utils/                    time, formatting, ids, logging
├── tracking/                 ActivityTracker, SessionManager, IdleDetector, ProjectResolver
├── analytics/                daily/weekly/monthly/yearly/language/project statistics, periods,
│                             streaks, heatmap calendar, insights, wrapped slides, StatsService
├── storage/                  Database (atomic JSON), Storage, Exporter, Importer,
│                             WrappedExport, TransferService
├── security/                 Validation, Sanitization, Privacy
├── commands/                 the 16 registered commands
└── webview/                  Dashboard panel + sidebar provider, CSP, message parsing

media/                        dashboard.css + nonce'd scripts (charts, formatting, UI kit, pages)
```

The `utils`, `types`, `analytics` and `security` layers are pure TypeScript with no `vscode` import, which is
why the test suite can exercise them under plain Node.js. `StatsService.buildDashboardPayload()` is the single
entry point that turns stored data into the payload every page consumes, so host and webview can never
disagree about a number.

---

## Development

```bash
npm ci              # install the pinned toolchain
npm run build       # compile to out/
npm run watch       # compile on change
npm run typecheck   # tsc --noEmit
npm run lint        # eslint (type-aware, no `any`, no network imports)
npm test            # build + run the test suite
npm run package     # production build + VSIX in dist/
```

Press **F5** to run an Extension Development Host. `.vscode/launch.json` and `.vscode/tasks.json` are already
configured.

The dashboard is plain CSS/JavaScript (no bundler, no framework) so the shipped assets can be reviewed by
anyone. Strict rules apply: no inline styles in the webview, no remote resources, `let`/`const` only, and
every script is loaded with a per-load nonce.

---

## Testing and quality gates

| Gate | Command |
|---|---|
| Type check | `npm run typecheck` |
| Lint | `npm run lint` |
| Tests | `npm test` (89 tests: time, validation, analytics, storage, tracking, security, webview rendering and an end-to-end host run) |
| Secret scan | `npm run security:scan` |
| Security checklist | `npm run security:check` |
| Dependency audit | `npm run audit` |
| Everything | `npm run verify` |

The CI workflow (`.github/workflows/ci.yml`) runs the same gates on Linux, Windows and macOS with Node 20 and
22, and uploads the VSIX as an artifact. `.github/workflows/release.yml` publishes a tagged build to the
Marketplace only after every check passes.

---

## Troubleshooting

| Symptom | What to do |
|---|---|
| The dashboard is empty | Check the status bar: if it says *paused*, run `Code Wrapped: Resume Tracking`. Empty pages are expected on a fresh install. |
| Today's number seems too low | Confirm the window was focused while you worked, and review `codeWrapped.inactivityTimeout`. Idle time is intentionally not counted. |
| Numbers look higher than expected | Raise `codeWrapped.inactivityTimeout` to 15 or 30 minutes. |
| Data looks damaged | The corrupt file is preserved next to the primary database (`devwrapped-data.corrupt-*.json`); the extension recovers from the backup automatically. Keep it as evidence and limit `debugLogging`. |
| Import refuses a file | It must be a Dev Wrapped JSON export under 64 MB. The validation message names the problem field. |
| Something is off and you want details | Enable `codeWrapped.debugLogging`, then run `Code Wrapped: Show Diagnostics Log`. Logs never contain source code or full paths. |

---

## FAQ

**Does Dev Wrapped send anything to the internet?**
No. There is no HTTP client in the extension and no remote resource in the webview. The only files it writes
are the ones you export and its own local database.

**Can it read my code?**
No. It subscribes to document *change events* to know that an edit happened, but it never reads the text,
the file name or the path.

**Is this a productivity tracker?**
No. It counts time and activity, and deliberately avoids quality or productivity judgments. Use "most
active", never "best".

**Where do I delete everything?**
`Code Wrapped: Reset Statistics`, or delete the extension's `globalStorage` folder after uninstalling.

**Does it work in a remote/container/Codespace window?**
Yes. The extension runs where the workspace is, observes editor metadata only, and keeps its data local to
that environment.

---

## Contributing

Issues and pull requests are welcome. Please run `npm run verify` before opening a PR, keep the pure layers
free of `vscode` imports, keep dependencies at zero runtime and build-time-minimal, and never add network
access to `src/`.

## License

[MIT](LICENSE) © 2026 Dev Wrapped contributors.
