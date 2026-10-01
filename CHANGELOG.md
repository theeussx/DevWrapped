# Changelog

All notable changes to **Dev Wrapped** are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-10-01

First public release: a local-only, privacy-first coding retrospective for Visual Studio Code.

### Added

- **Activity tracking**
  - Session detection based on editor events (edit, create, save, editor switch, window focus, workspace
    switch) — an open window is never counted as coding time.
  - Configurable inactivity timeout (5 / 10 / 15 / 30 minutes, default 10).
  - Per-tick credit cap, focus requirement, hour slicing and midnight splitting so totals always reconcile.
  - Pause and resume tracking at any time, with the state visible in the status bar.
- **Analytics**
  - Daily, weekly, monthly and yearly statistics with period-over-period comparisons.
  - Per-language and per-project breakdowns, session history and active-day counts.
  - Streaks with a configurable minimum active time (10 / 30 / 60 minutes).
  - Hourly and weekday distributions, records, and derived insights.
  - GitHub-style annual heatmap calendar with intensity levels 0–4, plus a month calendar.
- **Dashboard**
  - A dark, modern webview with thirteen pages: Overview, Today, Week, Month, Year, Activity, Languages,
    Projects, Sessions, Calendar, Insights, Privacy and Wrapped.
  - Reusable components: stat cards, comparisons, bar lists, timelines, session lists, records, panels and
    the Wrapped slide deck with keyboard navigation.
  - Explicit loading, empty and error states for every page.
- **Wrapped retrospective**
  - An eight-slide year in review with a headline, records, trends, languages, projects and comparisons.
  - Export to a single self-contained HTML file (inline CSS, no scripts, no external references).
- **Data ownership**
  - JSON export (full backup), CSV export (four spreadsheets with formula-injection protection) and
    HTML retrospective export.
  - Import with schema validation, a preview summary, explicit confirmation and an automatic
    `before-import` safety copy.
  - Reset statistics behind a modal that requires typing `RESET`.
- **Privacy and security**
  - Zero runtime dependencies; the extension works fully offline.
  - Strict webview Content Security Policy with nonce'd scripts, `localResourceRoots` limited to `media/`,
    and an allow-listed, validated message protocol.
  - No collection of source code, file contents, file paths, terminal commands, environment variables or
    credentials; project identity is a salted hash and language ids are sanitized.
  - Atomic writes, backup file, quarantine of corrupt data (never deleted) and a 64 MB size guard.
  - Log redaction, safe log levels (error / warn / info / debug) and a dedicated output channel.
- **Project infrastructure**
  - Strict TypeScript configuration (ES2022, `strict`, `noUncheckedIndexedAccess`) and type-aware ESLint
    rules that ban `any`, `eval`, `new Function`, `child_process`, network modules and `fetch`.
  - A `node:test` suite of 89 tests covering time handling, validation, analytics, storage, tracking,
    security invariants, webview rendering and a full run of the activated extension against an
    in-memory VS Code host.
  - Secret scanning and a security checklist script, dependency audit, CI on Linux/Windows/macOS with two
    Node versions, and a tag-triggered release workflow that publishes only after all checks pass.
  - Activity Bar container, status bar indicator, "Run Extension" launch configuration and VSIX packaging.

[1.0.0]: https://github.com/theeussx/DevWrapped/releases/tag/v1.0.0
