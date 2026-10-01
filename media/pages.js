/*
 * Dev Wrapped — page renderers.
 *
 * One function per page. Every renderer receives the current payload and a
 * small `actions` object (navigate, export, pause/resume, select a year,
 * control the retrospective) and returns a DOM node. No global state is kept
 * here: the shell owns the state and calls `render` again after every update.
 */
(function () {
  'use strict';

  const Ui = globalThis.CodeWrappedUi;
  const Charts = globalThis.CodeWrappedCharts;
  const Format = globalThis.CodeWrappedFormat;

  /* --------------------------------- helpers -------------------------------- */

  function weekendLabels(payload) {
    if (payload.week && payload.week.weekdays && payload.week.weekdays.length === 7) {
      return payload.week.weekdays.map(function (day) {
        return day.label;
      });
    }
    return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  }

  function languageSlices(slices) {
    return (slices || []).map(function (slice, index) {
      return {
        label: slice.label,
        detail: Format.duration(slice.ms) + ' · ' + Format.percent(slice.share, 0),
        share: slice.share,
        leader: index === 0,
      };
    });
  }

  function projectSlices(slices) {
    return (slices || []).map(function (slice, index) {
      return {
        label: slice.name,
        detail: Format.duration(slice.ms) + ' · ' + Format.plural(slice.sessions || 0, 'session'),
        share: slice.share,
        leader: index === 0,
      };
    });
  }

  function chartPanel(title, node, note) {
    return Ui.panel(title, node, note);
  }

  function periodHeaderActions(period, actions) {
    const buttons = [
      Ui.button('Refresh', actions.refresh, false, 'Rebuild the statistics'),
      Ui.button('Export JSON', function () {
        actions.export('json');
      }, false, 'Export a re-importable backup'),
    ];
    if (period.id === 'today') {
      buttons.unshift(Ui.button('Open wrapped', function () {
        actions.navigate('wrapped');
      }, false, 'Open the retrospective'));
    }
    return buttons;
  }

  /** Shared layout for Today / Week / Month. */
  function periodPage(payload, period, actions, extra) {
    const node = Ui.el('div', {}, [
      Ui.header(period.title, period.subtitle, periodHeaderActions(period, actions)),
      Ui.metrics(period.cards),
      Ui.grid(
        [
          chartPanel('Active time', Charts.trend(period.trend), period.comparison.available ? undefined : 'A baseline is needed before a trend can be compared.'),
          chartPanel('By hour of day', Charts.hourly(period.hourly)),
          chartPanel('By day of the week', Charts.weekdays(period.weekdays)),
        ],
        'cw-grid-half'
      ),
      Ui.grid(
        [
          chartPanel(
            'Languages',
            Ui.el('div', {}, [Charts.donut(period.languages, { centreLabel: Format.integer(period.languageCount) }), Ui.barList(languageSlices(period.languages))]),
            'Time is attributed to the language of the active editor.'
          ),
          chartPanel('Projects', Ui.barList(projectSlices(period.projects)), 'Folder names only — locations are never stored.'),
        ],
        'cw-grid-half'
      ),
      Ui.comparisonCard(period.comparison),
      Ui.section('Insights', Ui.insights(period.insights)),
      extra || null,
      Ui.section('Sessions', Ui.sessionList(period.sessions), Format.plural(period.sessions.length, 'session') + ' shown.'),
    ]);
    return node;
  }

  /* ---------------------------------- pages -------------------------------- */

  function overview(payload, actions) {
    const today = payload.today;
    const streaks = payload.insights.streaks;
    const recent = (payload.sessions.views || []).slice(0, 6);
    const yearHeatmap = payload.calendar ? payload.calendar.heatmap : null;

    return Ui.el('div', {}, [
      Ui.header('Code Wrapped', 'Your coding activity, measured locally and never sent anywhere.', [
        Ui.statusChip(payload.status),
        Ui.button('Refresh', actions.refresh, false, 'Rebuild the statistics'),
        Ui.button('Export', function () {
          actions.export('');
        }, false, 'Export data'),
      ]),
      Ui.metrics(
        [
          { id: 'today', label: 'Active today', value: Format.duration(today.totalMs), sub: today.cards[0] ? today.cards[0].sub : '' },
          { id: 'week', label: 'This week', value: Format.duration(payload.week.totalMs), sub: payload.week.cards[0] ? payload.week.cards[0].sub : '' },
          { id: 'month', label: 'This month', value: Format.duration(payload.month.totalMs), sub: payload.month.cards[0] ? payload.month.cards[0].sub : '' },
          { id: 'year', label: String(payload.year) + ' so far', value: Format.duration(payload.yearView.totalMs), sub: payload.yearView.cards[0] ? payload.yearView.cards[0].sub : '' },
          { id: 'streak', label: 'Current streak', value: Format.plural(streaks.current, 'day'), sub: 'Minimum ' + Format.integer(streaks.minimumActiveTimeMinutes) + ' min per day', tone: 'muted' },
          { id: 'sessions', label: 'Sessions this week', value: Format.integer((payload.week.sessions || []).length), sub: 'Recorded with a ' + Format.integer(payload.settings.inactivityTimeout) + ' min idle timeout', tone: 'muted' },
        ]
      ),
      Ui.grid(
        [
          chartPanel('Last 14 days', Charts.bars(lastDays(payload, 14), { ariaLabel: 'Active time of the last 14 days', height: 130 })),
          chartPanel(String(payload.year) + ' at a glance', yearHeatmap ? Charts.heatmap(yearHeatmap) : Ui.emptyState('No calendar yet', 'Activity will appear here.')),
        ],
        'cw-grid-half'
      ),
      Ui.grid(
        [
          chartPanel('Most active languages this year', Ui.barList(languageSlices(payload.yearView.languages))),
          chartPanel('Most active projects this year', Ui.barList(projectSlices(payload.yearView.projects))),
        ],
        'cw-grid-half'
      ),
      Ui.section('Recent sessions', Ui.sessionList(recent)),
      Ui.section('Insights', Ui.insights((payload.insights.insights || []).slice(0, 4))),
    ]);
  }

  function lastDays(payload, count) {
    const days = payload.week.daily.concat(payload.month.daily || []);
    const seen = {};
    const unique = [];
    days.forEach(function (day) {
      if (!seen[day.date]) {
        seen[day.date] = true;
        unique.push(day);
      }
    });
    return unique.slice(-count).map(function (day) {
      return { label: Format.dayShort(day.date), value: day.ms };
    });
  }

  function today(payload, actions) {
    return periodPage(payload, payload.today, actions, null);
  }

  function week(payload, actions) {
    return periodPage(payload, payload.week, actions, null);
  }

  function month(payload, actions) {
    const calendar = payload.monthCalendar;
    const grid = calendar
      ? chartPanel(calendar.label, Charts.monthGrid(calendar, { weekdayLabels: weekendLabels(payload) }), Format.duration(calendar.ms) + ' · ' + Format.plural(calendar.activeDays, 'active day'))
      : null;
    return periodPage(payload, payload.month, actions, Ui.grid([grid], 'cw-grid-half'));
  }

  function year(payload, actions) {
    const view = payload.yearView;
    return Ui.el('div', {}, [
      Ui.header(String(view.year), 'The yearly retrospective of recorded activity.', [
        Ui.button('Select year', function () {
          actions.openYearPicker();
        }, false, 'Choose another year'),
        Ui.button('Open wrapped', function () {
          actions.navigate('wrapped');
        }, true, 'Open the retrospective'),
      ]),
      Ui.metrics(view.cards),
      Ui.grid(
        [
          chartPanel('Active time per month', Charts.trend(view.trend)),
          chartPanel('Activity calendar', Charts.heatmap(view.heatmap), 'Each square is a day; darker squares had more active time.'),
        ],
        'cw-grid-half'
      ),
      Ui.grid(
        [
          chartPanel('By hour of day', Charts.hourly(view.hourly)),
          chartPanel('By day of the week', Charts.weekdays(view.weekdays)),
        ],
        'cw-grid-half'
      ),
      Ui.grid(
        [
          chartPanel('Languages', Charts.donut(view.languages, { centreLabel: Format.integer((view.languages || []).length) })),
          chartPanel('Projects', Ui.barList(projectSlices(view.projects))),
        ],
        'cw-grid-half'
      ),
      Ui.comparisonCard(view.comparison),
      Ui.section('Records', Ui.records(view.records)),
      Ui.section('Insights', Ui.insights(view.insights)),
      Ui.section('Sessions', Ui.sessionList((view.sessions || []).slice(0, 40))),
    ]);
  }

  function activity(payload, actions) {
    const view = payload.activity;
    return Ui.el('div', {}, [
      Ui.header('Activity', 'A chronological view of the recorded sessions.', periodHeaderActions(payload.today, actions)),
      Ui.metrics([
        { id: 'sessions', label: 'Sessions', value: Format.integer(view.totals.sessions), sub: 'In ' + String(payload.year) },
        { id: 'active-days', label: 'Active days', value: Format.integer(view.totals.activeDays), sub: Format.plural(view.days.length, 'day') + ' in the year' },
        { id: 'average', label: 'Average session', value: Format.duration(view.totals.averageSessionMs) },
        { id: 'longest', label: 'Longest session', value: Format.duration(view.totals.longestSessionMs), sub: view.totals.longestSessionDate || '', tone: 'muted' },
      ]),
      Ui.section('Timeline', Ui.timeline(view.timeline)),
      Ui.section(
        'Days',
        Ui.list(
          (view.days || []).map(function (day) {
            return {
              primary: Format.dayLong(day.date),
              secondary: (day.ms > 0 ? Format.duration(day.ms) : 'no activity') + (day.sessions ? ' · ' + Format.plural(day.sessions, 'session') : ''),
            };
          })
        ),
        'Newest day first; only days with recorded activity are listed in the timeline.'
      ),
    ]);
  }

  function languages(payload, actions) {
    const view = payload.languages;
    return Ui.el('div', {}, [
      Ui.header('Languages', view.range + ' · ' + Format.duration(view.totalMs) + ' of active time', periodHeaderActions(payload.today, actions)),
      Ui.grid(
        [
          chartPanel('Language mix', Charts.donut(view.slices, { centreLabel: Format.integer(view.languages) })),
          chartPanel('Most active languages', Ui.barList(languageSlices(view.slices)), view.note),
        ],
        'cw-grid-half'
      ),
      chartPanel('Active time over the year', Charts.trend(view.trend)),
      Ui.metrics([
        { id: 'languages', label: 'Languages used', value: Format.integer(view.languages) },
        { id: 'files', label: 'Documents edited', value: Format.integer(view.filesTouched), sub: 'Counts only — file names are never read', tone: 'muted' },
      ]),
      Ui.section(
        'Sessions by language',
        Ui.list(
          (view.slices || []).map(function (slice) {
            return { primary: slice.label, secondary: Format.duration(slice.ms) + ' · ' + Format.plural(slice.sessions || 0, 'session') };
          })
        )
      ),
    ]);
  }

  function projects(payload, actions) {
    const view = payload.projects;
    return Ui.el('div', {}, [
      Ui.header('Projects', view.range + ' · ' + Format.duration(view.totalMs) + ' of active time', periodHeaderActions(payload.today, actions)),
      chartPanel('Most active projects', Ui.barList(projectSlices(view.slices)), view.note),
      chartPanel('Active time over the year', Charts.trend(view.trend)),
      Ui.metrics([
        { id: 'projects', label: 'Projects tracked', value: Format.integer(view.projects) },
        { id: 'sessions', label: 'Sessions with a project', value: Format.integer(view.sessions) },
      ]),
      Ui.section(
        'Project details',
        Ui.list(
          (view.slices || []).map(function (slice) {
            return {
              primary: slice.name,
              secondary:
                Format.duration(slice.ms) +
                ' · ' +
                Format.percent(slice.share, 0) +
                (slice.lastActive ? ' · last active ' + Format.dateFromTs(slice.lastActive) : ''),
            };
          })
        ),
        'Projects are identified by a salted hash; only the folder name is shown.'
      ),
    ]);
  }

  function sessions(payload, actions) {
    const view = payload.sessions;
    const state = { project: '', language: '', minimum: 0 };
    const container = Ui.el('div', {});

    function renderList() {
      Ui.clear(container);
      const filtered = (view.views || []).filter(function (session) {
        if (state.project && session.project !== state.project) {
          return false;
        }
        if (state.language && session.language !== state.language) {
          return false;
        }
        if (state.minimum > 0 && session.durationMs < state.minimum) {
          return false;
        }
        return true;
      });
      const total = filtered.reduce(function (sum, session) {
        return sum + session.durationMs;
      }, 0);
      container.appendChild(
        Ui.section(
          'Sessions',
          Ui.sessionList(filtered),
          Format.plural(filtered.length, 'session') + ' · ' + Format.duration(total) + ' of active time.'
        )
      );
    }

    const filters = Ui.el('div', { class: 'cw-filters' }, [
      Ui.select(
        [{ value: '', label: 'All projects' }].concat(
          (view.filters.projects || []).map(function (project) {
            return { value: project.id, label: project.name };
          })
        ),
        state.project,
        function (value) {
          state.project = value;
          renderList();
        },
        'Filter by project'
      ),
      Ui.select(
        [{ value: '', label: 'All languages' }].concat(
          (view.filters.languages || []).map(function (language) {
            return { value: language.id, label: language.label };
          })
        ),
        state.language,
        function (value) {
          state.language = value;
          renderList();
        },
        'Filter by language'
      ),
      Ui.select(
        [
          { value: '0', label: 'Any length' },
          { value: '900000', label: '15 minutes or more' },
          { value: '1800000', label: '30 minutes or more' },
          { value: '3600000', label: '1 hour or more' },
        ],
        String(state.minimum),
        function (value) {
          state.minimum = Number(value) || 0;
          renderList();
        },
        'Filter by duration'
      ),
    ]);

    renderList();

    return Ui.el('div', {}, [
      Ui.header('Sessions', view.range + ' · ' + Format.plural(view.total, 'session'), periodHeaderActions(payload.today, actions)),
      Ui.metrics([
        { id: 'total', label: 'Sessions', value: Format.integer(view.total), sub: 'Raw sessions are kept for ' + Format.integer(payload.settings.sessionRetentionDays) + ' days' },
        { id: 'average', label: 'Average', value: Format.duration(view.averageMs) },
        { id: 'longest', label: 'Longest', value: Format.duration(view.longestMs) },
      ]),
      Ui.card([filters, container]),
      view.filters.known ? null : Ui.emptyState('No sessions recorded', 'Sessions appear once tracking records activity.'),
    ]);
  }

  function calendar(payload, actions) {
    const view = payload.calendar;
    return Ui.el('div', {}, [
      Ui.header('Calendar', String(view.year) + ' · ' + Format.duration(view.totalMs) + ' · ' + Format.plural(view.activeDays, 'active day'), [
        Ui.select(
          (view.years || [view.year]).map(function (year) {
            return { value: String(year), label: String(year) };
          }),
          String(view.year),
          function (value) {
            actions.selectYear(Number(value));
          },
          'Select a year'
        ),
        Ui.button('Export wrapped', function () {
          actions.export('wrapped');
        }, false, 'Export the retrospective'),
      ]),
      chartPanel('Activity by day', Charts.heatmap(view.heatmap), 'Each column is a week; darker squares mean more active time.'),
      Ui.metrics([
        { id: 'total', label: 'Active time', value: Format.duration(view.totalMs) },
        { id: 'days', label: 'Active days', value: Format.integer(view.activeDays) },
        { id: 'best-day', label: 'Busiest day', value: view.bestDay ? Format.duration(view.bestDay.ms) : '—', sub: view.bestDay ? view.bestDay.label : '' },
        { id: 'best-week', label: 'Busiest week', value: Format.duration(view.bestWeekMs) },
      ]),
      Ui.grid(
        (view.months || []).map(function (month) {
          return chartPanel(
            month.label,
            Charts.monthGrid(month, { weekdayLabels: weekendLabels(payload) }),
            Format.duration(month.ms) + ' · ' + Format.plural(month.activeDays, 'active day')
          );
        })
      ),
      chartPanel('Monthly totals', Ui.barList((view.monthly || []).map(function (month) {
        return { label: month.label, detail: Format.duration(month.ms), share: month.share, leader: false };
      }))),
    ]);
  }

  function insights(payload, actions) {
    const view = payload.insights;
    const streaks = view.streaks;
    return Ui.el('div', {}, [
      Ui.header('Insights', 'Observations about the recorded activity. No scores, no judgements.', periodHeaderActions(payload.today, actions)),
      Ui.metrics([
        { id: 'current', label: 'Current streak', value: Format.plural(streaks.current, 'day'), sub: 'Minimum ' + Format.integer(streaks.minimumActiveTimeMinutes) + ' min/day' },
        { id: 'longest', label: 'Longest streak', value: Format.plural(streaks.longest, 'day'), sub: streaks.longestStart && streaks.longestEnd ? streaks.longestStart + ' → ' + streaks.longestEnd : '' },
        { id: 'consistency', label: 'Consistency', value: Format.percent(view.consistency.ratio, 0), sub: view.consistency.label, tone: 'muted' },
        { id: 'qualifying', label: 'Days above the minimum', value: Format.integer(streaks.qualifyingDays), tone: 'muted' },
      ]),
      Ui.section('Insights', Ui.insights(view.insights)),
      Ui.grid(
        [
          chartPanel('Rhythm', Charts.hourly((payload.week.hourly || []).map(function (bucket) { return bucket; })), view.rhythm.note),
          chartPanel('Records', Ui.records(view.records) || Ui.emptyState('No records yet', 'Records appear after a few active days.')),
        ],
        'cw-grid-half'
      ),
      Ui.section(
        'Rhythm details',
        Ui.list([
          { primary: 'Most active hour', secondary: view.rhythm.bestHour ? view.rhythm.bestHour.label + ' · ' + Format.duration(view.rhythm.bestHour.ms) : '—' },
          { primary: 'Most active day of the week', secondary: view.rhythm.busiestWeekday ? view.rhythm.busiestWeekday.label + ' · ' + Format.duration(view.rhythm.busiestWeekday.ms) : '—' },
          { primary: 'Hours with no recorded activity', secondary: String((view.rhythm.quietestHours || []).length) },
        ])
      ),
    ]);
  }

  function privacy(payload, actions) {
    return Ui.el('div', {}, [
      Ui.header('Privacy', 'What Dev Wrapped records, where it lives and what never leaves this machine.', [
        Ui.button(payload.status.tracking.paused ? 'Resume tracking' : 'Pause tracking', function () {
          if (payload.status.tracking.paused) {
            actions.resume();
          } else {
            actions.pause();
          }
        }, false, 'Toggle tracking'),
        Ui.button('Open settings', actions.openSettings, false, 'Open the extension settings'),
        Ui.button('Export data', function () {
          actions.export('');
        }, false, 'Export a backup'),
        Ui.button('Reset statistics', actions.resetStatistics, false, 'Delete all statistics'),
      ]),
      Ui.privacyPanel(payload.privacy),
    ]);
  }

  function wrapped(payload, actions) {
    const view = payload.wrapped;
    const index = actions.getWrappedSlide();
    if (!view.available || !view.slides || view.slides.length === 0) {
      return Ui.el('div', {}, [
        Ui.header('Wrapped ' + view.year, 'The yearly retrospective.', []),
        Ui.emptyState('No retrospective yet', view.message || 'Record some activity first.'),
      ]);
    }
    const slide = view.slides[Math.max(0, Math.min(view.slides.length - 1, index))];
    actions.setWrappedSlide(view.slides.indexOf(slide));

    return Ui.el('div', {}, [
      Ui.header('Wrapped ' + view.year, 'A few minutes of your year in code.', [
        Ui.button('Export HTML', function () {
          actions.export('wrapped');
        }, false, 'Export a standalone page'),
        Ui.button('Previous year', function () {
          actions.selectYear(view.year - 1);
        }, false, 'Show the previous year'),
      ]),
      Ui.wrappedSlide(slide),
      Ui.progress(view.slides.length, index),
      Ui.wrappedControls(
        function () {
          actions.setWrappedSlide((index - 1 + view.slides.length) % view.slides.length);
        },
        function () {
          actions.setWrappedSlide((index + 1) % view.slides.length);
        },
        function () {
          actions.export('wrapped');
        }
      ),
      Ui.section(
        'All slides',
        Ui.list(
          view.slides.map(function (item, position) {
            return { primary: item.kicker + ' — ' + item.title, secondary: position === index ? 'current' : '' };
          })
        ),
        'Use the arrow keys or the space bar to move between slides.'
      ),
    ]);
  }

  globalThis.CodeWrappedPages = {
    overview: overview,
    today: today,
    week: week,
    month: month,
    year: year,
    activity: activity,
    languages: languages,
    projects: projects,
    sessions: sessions,
    calendar: calendar,
    insights: insights,
    privacy: privacy,
    wrapped: wrapped,
  };
})();
