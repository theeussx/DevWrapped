/*
 * Dev Wrapped — presentation components.
 *
 * Every component is a plain function that returns a DOM node built with
 * `document.createElement` and `textContent`. User controlled strings (project
 * names, language labels, dates) are therefore never interpreted as markup.
 */
(function () {
  'use strict';

  const Format = globalThis.CodeWrappedFormat;
  const Charts = globalThis.CodeWrappedCharts;

  /* ---------------------------------- base --------------------------------- */

  /** Creates an element: `el('div', { class: 'x', title: 'y' }, [children])`. */
  function el(tag, attributes, children) {
    const node = document.createElement(tag);
    if (attributes) {
      Object.keys(attributes).forEach(function (key) {
        const value = attributes[key];
        if (value === undefined || value === null) {
          return;
        }
        if (key === 'text') {
          node.textContent = String(value);
          return;
        }
        if (key === 'class') {
          node.className = String(value);
          return;
        }
        if (key.indexOf('data-') === 0) {
          node.setAttribute(key, String(value));
          return;
        }
        node.setAttribute(key, String(value));
      });
    }
    appendAll(node, children);
    return node;
  }

  function appendAll(node, children) {
    if (!children) {
      return;
    }
    const list = Array.isArray(children) ? children : [children];
    list.forEach(function (child) {
      if (child === null || child === undefined || child === false) {
        return;
      }
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
  }

  function clear(node) {
    while (node.firstChild) {
      node.removeChild(node.firstChild);
    }
    return node;
  }

  /* --------------------------------- states -------------------------------- */

  function emptyState(title, message) {
    return el('div', { class: 'cw-state' }, [
      el('div', { class: 'cw-state-title', text: title }),
      el('div', { text: message || '' }),
    ]);
  }

  function errorState(message) {
    return el('div', { class: 'cw-state cw-state-error' }, [
      el('div', { class: 'cw-state-title', text: 'Something went wrong' }),
      el('div', { text: message || 'The statistics could not be loaded.' }),
    ]);
  }

  function loadingState(message) {
    return el('div', { class: 'cw-state' }, [
      el('div', { class: 'cw-state-title', text: 'Loading…' }),
      el('div', { text: message || 'Reading your local statistics.' }),
    ]);
  }

  /* --------------------------------- layout -------------------------------- */

  function header(title, subtitle, actions) {
    return el('header', { class: 'cw-header' }, [
      el('div', {}, [
        el('h1', { class: 'cw-title', text: title }),
        subtitle ? el('p', { class: 'cw-subtitle', text: subtitle }) : null,
      ]),
      actions && actions.length ? el('div', { class: 'cw-header-actions' }, actions) : null,
    ]);
  }

  function section(title, children, note) {
    return el('section', { class: 'cw-section' }, [
      title ? el('h2', { class: 'cw-section-title', text: title }) : null,
      children,
      note ? el('p', { class: 'cw-section-note', text: note }) : null,
    ]);
  }

  function card(children, extraClass) {
    return el('div', { class: 'cw-card' + (extraClass ? ' ' + extraClass : '') }, children);
  }

  function grid(children, extraClass) {
    return el('div', { class: 'cw-grid ' + (extraClass || 'cw-grid-cards') }, children);
  }

  /** A block with a title above a chart or list. */
  function panel(title, body, note) {
    return card([el('h2', { class: 'cw-section-title', text: title }), body, note ? el('p', { class: 'cw-section-note', text: note }) : null]);
  }

  /* --------------------------------- metrics ------------------------------- */

  function metricCard(metric) {
    return el('div', { class: 'cw-card ' + Format.toneClass(metric.tone) }, [
      el('div', { class: 'cw-metric-label', text: metric.label }),
      el('div', { class: 'cw-metric-value', text: metric.value }),
      metric.sub ? el('div', { class: 'cw-metric-sub', text: metric.sub }) : null,
      metric.hint ? el('div', { class: 'cw-section-note', text: metric.hint }) : null,
    ]);
  }

  function metrics(cards) {
    return grid((cards || []).map(metricCard));
  }

  function comparisonCard(view) {
    if (!view) {
      return null;
    }
    let body;
    if (view.available) {
      body = [
        el('div', { class: 'cw-comparison-values' }, [
          el('div', {}, [
            el('div', { class: 'cw-comparison-value', text: Format.duration(view.currentMs) }),
            el('div', { class: 'cw-comparison-caption', text: view.currentLabel }),
          ]),
          el('div', {}, [
            el('div', { class: 'cw-comparison-value', text: Format.duration(view.previousMs) }),
            el('div', { class: 'cw-comparison-caption', text: view.previousLabel }),
          ]),
        ]),
        el('p', { class: 'cw-section-note', text: describeComparison(view) }),
      ];
    } else {
      body = el('p', { class: 'cw-section-note', text: view.message || 'No baseline to compare with yet.' });
    }
    return card([el('h2', { class: 'cw-section-title', text: view.title }), body]);
  }

  function describeComparison(view) {
    const delta = Number(view.deltaMs) || 0;
    if (delta === 0) {
      return 'The same amount of active time as in ' + String(view.previousLabel || '').toLowerCase() + '.';
    }
    return (
      Format.duration(Math.abs(delta)) +
      (delta > 0 ? ' more' : ' less') +
      ' than ' +
      String(view.previousLabel || 'the previous period').toLowerCase() +
      '.'
    );
  }

  /* ---------------------------------- lists -------------------------------- */

  function list(items) {
    if (!items || items.length === 0) {
      return null;
    }
    return el(
      'ul',
      { class: 'cw-list' },
      items.map(function (item) {
        return el('li', {}, [
          el('span', { class: 'cw-list-primary', text: item.primary }),
          item.secondary ? el('span', { class: 'cw-list-meta', text: item.secondary }) : null,
        ]);
      })
    );
  }

  function barList(entries) {
    if (!entries || entries.length === 0) {
      return emptyState('Nothing recorded yet', 'This chart fills as activity is recorded.');
    }
    return el(
      'div',
      {},
      entries.map(function (entry) {
        const width = Math.max(2, Math.min(100, Math.round((Number(entry.share) || 0) * 100)));
        return el('div', { class: 'cw-bar-row' }, [
          el('span', { text: entry.label }),
          el('div', { class: 'cw-bar-track' }, [
            el('div', {
              class: 'cw-bar-fill' + (entry.leader ? ' cw-bar-fill-leader' : '') + ' cw-w-' + width,
            }),
          ]),
          el('span', { class: 'cw-list-meta', text: entry.detail || '' }),
        ]);
      })
    );
  }

  /**
   * Applies bar widths after a tree was inserted.
   *
   * Inline styles are forbidden by the webview policy, so a bar carries a
   * width class (`cw-w-1` … `cw-w-100`) instead.
   */
  function applyBarWidths(root) {
    const bars = root.querySelectorAll('[data-width]');
    for (let index = 0; index < bars.length; index += 1) {
      const bar = bars[index];
      const width = Math.max(1, Math.min(100, Math.round(Number(bar.getAttribute('data-width')) || 0)));
      bar.className = bar.className.replace(/\s*cw-w-\d+/g, '') + ' cw-w-' + width;
    }
  }

  function sessionList(sessions, options) {
    const list = sessions || [];
    if (list.length === 0) {
      return emptyState('No sessions to show', 'Sessions appear here once activity is recorded.');
    }
    const showDay = !options || options.showDay !== false;
    return el(
      'div',
      {},
      list.map(function (session) {
        const title = session.languageLabel || 'Coding';
        const meta = [];
        if (session.projectName) {
          meta.push(session.projectName);
        }
        if (showDay) {
          meta.push(Format.relativeDay(session.dayKey));
        }
        meta.push(Format.range(session.start, session.end));
        return el('div', { class: 'cw-session' + (session.live ? ' cw-session-live' : '') }, [
          el('span', { class: 'cw-session-duration', text: Format.duration(session.durationMs) }),
          el('div', {}, [
            el('div', { class: 'cw-list-primary', text: title }),
            el('div', { class: 'cw-session-meta', text: meta.join(' · ') }),
          ]),
          session.live ? el('span', { class: 'cw-chip' }, [el('span', { class: 'cw-chip-dot' }), 'in progress']) : null,
        ]);
      })
    );
  }

  function timeline(events) {
    if (!events || events.length === 0) {
      return emptyState('No activity recorded', 'The timeline fills as you code.');
    }
    return el(
      'ul',
      { class: 'cw-timeline' },
      events.map(function (event) {
        return el('li', { class: 'cw-timeline-item' + (event.kind === 'day' ? ' cw-timeline-day' : '') }, [
          el('span', { class: 'cw-timeline-time', text: event.time }),
          el('span', { class: 'cw-list-primary', text: event.title }),
          event.detail ? el('div', { class: 'cw-timeline-detail', text: event.detail }) : null,
        ]);
      })
    );
  }

  function insights(views) {
    if (!views || views.length === 0) {
      return emptyState('No insights yet', 'Insights are generated once there is enough activity.');
    }
    return el(
      'div',
      {},
      views.map(function (insight) {
        return el('div', { class: 'cw-insight' }, [
          el('div', { class: 'cw-insight-icon', text: Format.iconLetter(insight.icon) }),
          el('div', {}, [
            el('div', { class: 'cw-insight-title', text: insight.title }),
            el('div', { class: 'cw-insight-body', text: insight.body }),
          ]),
        ]);
      })
    );
  }

  function records(views) {
    if (!views || views.length === 0) {
      return null;
    }
    return list(
      views.map(function (record) {
        return { primary: record.label + ': ' + record.value, secondary: record.detail || '' };
      })
    );
  }

  function privacyPanel(payload) {
    const storage = payload.storage || {};
    const stored = payload.stored || {};
    const tracking = payload.tracking || {};
    const node = el('div', {}, [
      grid([
        metricCard({ label: 'Data file', value: storage.size || '—', sub: storage.dataFile || '', tone: 'muted' }),
        metricCard({
          label: 'Stored',
          value: Format.integer(stored.days) + ' days',
          sub: Format.plural(stored.sessions || 0, 'session') + ' · ' + Format.plural(stored.projects || 0, 'project'),
          tone: 'muted',
        }),
        metricCard({
          label: 'Network requests',
          value: String(payload.network && payload.network.requests ? payload.network.requests : 0),
          sub: 'Dev Wrapped never connects to the internet',
          tone: 'positive',
        }),
        metricCard({
          label: 'Tracking',
          value: tracking.paused ? 'Paused' : 'Active',
          sub:
            'Idle timeout ' +
            Format.integer(tracking.idleTimeoutMinutes) +
            ' min · streak minimum ' +
            Format.integer(tracking.minimumActiveTimeMinutes) +
            ' min',
          tone: tracking.paused ? 'muted' : 'positive',
        }),
      ]),
      el('div', { class: 'cw-grid cw-grid-half' }, [
        panel('What Dev Wrapped records', bulletList(payload.collected)),
        panel('What is never recorded', bulletList(payload.neverCollected)),
      ]),
      panel('How your data is protected', bulletList(payload.safety)),
      panel(
        'Your local database',
        el('div', {}, [
          el('div', { class: 'cw-section-note', text: 'Folder' }),
          el('div', { class: 'cw-code', text: storage.directory || '—' }),
          el('div', { class: 'cw-section-note', text: 'Database file' }),
          el('div', { class: 'cw-code', text: storage.dataFile || '—' }),
          el('div', { class: 'cw-section-note', text: 'Backup file' }),
          el('div', { class: 'cw-code', text: storage.backupFile || '—' }),
        ])
      ),
      panel('Frequently asked', (payload.facts || []).map(function (fact) {
        return el('div', { class: 'cw-insight' }, [
          el('div', { class: 'cw-insight-icon', text: '?' }),
          el('div', {}, [
            el('div', { class: 'cw-fact-question', text: fact.question }),
            el('div', { class: 'cw-insight-body', text: fact.answer }),
          ]),
        ]);
      })),
      el('p', { class: 'cw-section-note', text: payload.networkStatement || '' }),
      el('p', { class: 'cw-section-note', text: 'First stored day: ' + (stored.firstDay || '—') + ' · most recent: ' + (stored.lastDay || '—') + ' · raw sessions kept for ' + Format.integer(stored.retentionDays || 0) + ' days.' }),
    ]);
    return node;
  }

  function bulletList(items) {
    return el(
      'ul',
      { class: 'cw-privacy-list' },
      (items || []).map(function (item) {
        return el('li', { text: item });
      })
    );
  }

  /* --------------------------------- wrapped ------------------------------- */

  function wrappedSlide(slide) {
    return el('div', { class: 'cw-wrapped' }, [
      el('div', { class: 'cw-slide-kicker', text: slide.kicker }),
      el('h1', { class: 'cw-slide-title', text: slide.title }),
      el('div', { class: 'cw-slide-value', text: slide.value }),
      el('div', { class: 'cw-slide-unit', text: slide.unit }),
      el('p', { class: 'cw-slide-caption', text: slide.caption }),
      slide.bars && slide.bars.length
        ? el(
            'div',
            { class: 'cw-slide-bars' },
            slide.bars.map(function (bar) {
              return el('div', { class: 'cw-bar-row' }, [
                el('span', { text: bar.label }),
                el('div', { class: 'cw-bar-track' }, [
                  el('div', { class: 'cw-bar-fill' + (bar.leader ? ' cw-bar-fill-leader' : ''), 'data-width': Math.round((bar.share || 0) * 100) }),
                ]),
                el('span', { class: 'cw-list-meta', text: bar.detail }),
              ]);
            })
          )
        : null,
      el('p', { class: 'cw-slide-footnote', text: slide.footnote }),
    ]);
  }

  function wrappedControls(onPrevious, onNext, onExport) {
    return el('div', { class: 'cw-wrapped-controls' }, [
      button('Previous', onPrevious, false, 'Previous slide'),
      button('Next', onNext, true, 'Next slide'),
      button('Export this retrospective', onExport, false, 'Export as HTML'),
    ]);
  }

  function progress(count, index) {
    const dots = [];
    for (let position = 0; position < count; position += 1) {
      dots.push(el('span', { class: 'cw-dot' + (position === index ? ' cw-dot-active' : '') }));
    }
    return el('div', { class: 'cw-wrapped-progress' }, dots);
  }

  /* --------------------------------- controls ------------------------------ */

  function button(label, onClick, primary, title) {
    const node = el('button', { class: 'cw-button' + (primary ? ' cw-button-primary' : ''), type: 'button', title: title || label }, [label]);
    node.addEventListener('click', function (event) {
      event.preventDefault();
      onClick();
    });
    return node;
  }

  function select(options, selected, onChange, title) {
    const node = el('select', { class: 'cw-select', title: title || '' }, []);
    options.forEach(function (option) {
      const item = el('option', { value: String(option.value), text: option.label });
      if (String(option.value) === String(selected)) {
        item.selected = true;
      }
      node.appendChild(item);
    });
    node.addEventListener('change', function () {
      onChange(node.value);
    });
    return node;
  }

  function statusChip(status) {
    const paused = status && status.tracking && status.tracking.paused;
    return el('span', { class: 'cw-chip' + (paused ? ' cw-chip-paused' : '') }, [
      el('span', { class: 'cw-chip-dot' }),
      Format.trackingStatus(status),
    ]);
  }

  /** Small legend for the language donut and the language lists. */
  function languageLegend(slices) {
    if (!slices || slices.length === 0) {
      return null;
    }
    return el(
      'div',
      { class: 'cw-legend' },
      slices.slice(0, 8).map(function (slice, index) {
        return el('span', { class: 'cw-legend-item' }, [
          el('span', { class: 'cw-legend-swatch cw-swatch-' + ((index % 8) + 1) }),
          slice.label + ' · ' + Format.percent(slice.share, 0),
        ]);
      })
    );
  }

  globalThis.CodeWrappedUi = {
    el: el,
    clear: clear,
    emptyState: emptyState,
    errorState: errorState,
    loadingState: loadingState,
    header: header,
    section: section,
    card: card,
    grid: grid,
    panel: panel,
    metricCard: metricCard,
    metrics: metrics,
    comparisonCard: comparisonCard,
    list: list,
    barList: barList,
    applyBarWidths: applyBarWidths,
    sessionList: sessionList,
    timeline: timeline,
    insights: insights,
    records: records,
    privacyPanel: privacyPanel,
    wrappedSlide: wrappedSlide,
    wrappedControls: wrappedControls,
    progress: progress,
    button: button,
    select: select,
    statusChip: statusChip,
    languageLegend: languageLegend,
    charts: Charts,
  };
})();
