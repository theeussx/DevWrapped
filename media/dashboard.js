/*
 * Dev Wrapped — webview shell.
 *
 * Owns the navigation, the message bridge with the extension host, the
 * persisted UI state and the error/loading states. The page renderers in
 * `pages.js` are pure functions of the payload, so re-rendering is simply a
 * matter of calling them again.
 */
(function () {
  'use strict';

  const Ui = globalThis.CodeWrappedUi;
  const Pages = globalThis.CodeWrappedPages;
  const Format = globalThis.CodeWrappedFormat;

  const PAGE_LABELS = {
    overview: 'Overview',
    today: 'Today',
    week: 'Week',
    month: 'Month',
    year: 'Year',
    activity: 'Activity',
    languages: 'Languages',
    projects: 'Projects',
    sessions: 'Sessions',
    calendar: 'Calendar',
    insights: 'Insights',
    privacy: 'Privacy',
    wrapped: 'Wrapped',
  };

  const YEAR_PAGES = { year: true, languages: true, projects: true, sessions: true, calendar: true, insights: true, wrapped: true };

  /* ------------------------------ VS Code bridge ---------------------------- */

  let vscode = null;
  try {
    if (typeof acquireVsCodeApi === 'function') {
      vscode = acquireVsCodeApi();
    }
  } catch (error) {
    vscode = null;
  }

  let restored = null;
  try {
    restored = vscode && vscode.getState ? vscode.getState() : null;
  } catch (error) {
    restored = null;
  }

  const state = {
    page: restored && typeof restored.page === 'string' ? restored.page : 'overview',
    wrappedSlide: restored && typeof restored.wrappedSlide === 'number' ? restored.wrappedSlide : 0,
  };

  function persist() {
    try {
      if (vscode && vscode.setState) {
        vscode.setState({ page: state.page, wrappedSlide: state.wrappedSlide });
      }
    } catch (error) {
      /* state persistence is optional */
    }
  }

  function post(message) {
    try {
      if (vscode && vscode.postMessage) {
        vscode.postMessage(message);
      }
    } catch (error) {
      showToast('Could not talk to the extension host.', 'error');
    }
  }

  /* --------------------------------- state --------------------------------- */

  let payload = null;
  let toastTimer = null;
  let root = document.getElementById('app');
  let menu = null;

  const actions = {
    navigate: function (page) {
      if (!PAGE_LABELS[page]) {
        return;
      }
      state.page = page;
      if (page !== 'wrapped') {
        state.wrappedSlide = 0;
      }
      persist();
      post({ type: 'navigate', page: page });
      render();
    },
    refresh: function () {
      post({ type: 'refresh' });
    },
    export: function (format) {
      if (!format) {
        openExportMenu();
        return;
      }
      closeMenu();
      post({ type: 'export', format: format });
    },
    pause: function () {
      post({ type: 'pauseTracking' });
    },
    resume: function () {
      post({ type: 'resumeTracking' });
    },
    openSettings: function () {
      post({ type: 'openSettings' });
    },
    openPrivacy: function () {
      post({ type: 'openPrivacy' });
    },
    resetStatistics: function () {
      post({ type: 'resetStatistics' });
    },
    selectYear: function (year) {
      if (!isFinite(year)) {
        return;
      }
      closeMenu();
      post({ type: 'selectYear', year: Math.round(year) });
    },
    setWrappedSlide: function (index) {
      const count = payload && payload.wrapped && payload.wrapped.slides ? payload.wrapped.slides.length : 0;
      if (count <= 0) {
        return;
      }
      state.wrappedSlide = ((index % count) + count) % count;
      persist();
      render();
    },
    getWrappedSlide: function () {
      return state.wrappedSlide;
    },
    openYearPicker: function () {
      openYearMenu();
    },
  };

  /* --------------------------------- render -------------------------------- */

  function render() {
    root = document.getElementById('app');
    if (!root) {
      return;
    }
    Ui.clear(root);
    root.setAttribute('data-state', payload ? 'ready' : 'loading');

    if (!payload) {
      root.appendChild(Ui.loadingState('Waiting for the extension host…'));
      return;
    }

    const renderer = Pages[state.page] || Pages.overview;
    let content;
    try {
      content = renderer(payload, actions);
    } catch (error) {
      content = Ui.errorState('This page could not be rendered. ' + (error && error.message ? error.message : ''));
    }

    const nav = buildNav();
    const container = Ui.el('main', { class: 'cw-content' }, [content, menu ? menu : null]);
    root.appendChild(Ui.el('div', { class: 'cw-app' }, [nav, container]));
    Ui.applyBarWidths(root);
  }

  function buildNav() {
    const items = (payload.pages || Object.keys(PAGE_LABELS)).map(function (page) {
      const button = Ui.el('button', {
        class: 'cw-nav-button',
        type: 'button',
        'aria-current': state.page === page ? 'page' : null,
        text: PAGE_LABELS[page] || page,
      });
      button.addEventListener('click', function () {
        actions.navigate(page);
      });
      return Ui.el('li', {}, [button]);
    });

    const footer = Ui.el('div', { class: 'cw-nav-footer' }, [
      Ui.statusChip(payload.status),
      Ui.el('div', { text: 'Version ' + (payload.version || '1.0.0') }),
      Ui.el('div', { text: 'Local data only' }),
    ]);

    return Ui.el('nav', { class: 'cw-nav', 'aria-label': 'Dashboard pages' }, [
      Ui.el('div', { class: 'cw-brand' }, [
        Ui.el('span', { class: 'cw-brand-title', text: 'Code Wrapped' }),
        Ui.el('span', { class: 'cw-brand-version', text: 'v' + (payload.version || '') }),
      ]),
      Ui.el('ul', { class: 'cw-nav-list' }, items),
      yearSelector(),
      footer,
    ]);
  }

  function yearSelector() {
    if (!YEAR_PAGES[state.page]) {
      return null;
    }
    const years = payload.availableYears && payload.availableYears.length ? payload.availableYears : [payload.year];
    return Ui.el('div', { class: 'cw-nav-footer' }, [
      Ui.el('div', { text: 'Showing ' + String(payload.year) }),
      Ui.select(
        years.map(function (year) {
          return { value: String(year), label: String(year) };
        }),
        String(payload.year),
        function (value) {
          actions.selectYear(Number(value));
        },
        'Select the year to display'
      ),
    ]);
  }

  /* ---------------------------------- menus -------------------------------- */

  function closeMenu() {
    menu = null;
  }

  function exportMenu() {
    const options = [
      { format: 'json', label: 'JSON backup', detail: 'Everything, re-importable' },
      { format: 'csv', label: 'CSV files', detail: 'Daily, sessions, languages, projects' },
      { format: 'wrapped', label: 'Code Wrapped HTML', detail: 'Standalone retrospective page' },
    ];
    const buttons = options.map(function (option) {
      return Ui.button(
        option.label + ' — ' + option.detail,
        function () {
          actions.export(option.format);
        },
        false,
        option.detail
      );
    });
    return Ui.card([Ui.el('h2', { class: 'cw-section-title', text: 'Export' }), Ui.el('div', { class: 'cw-filters' }, buttons)]);
  }

  function openExportMenu() {
    menu = exportMenu();
    render();
  }

  function openYearMenu() {
    const years = payload && payload.availableYears ? payload.availableYears : [];
    const buttons = years.map(function (year) {
      return Ui.button(
        String(year),
        function () {
          actions.selectYear(year);
        },
        year === (payload && payload.year),
        'Show ' + year
      );
    });
    if (buttons.length === 0) {
      buttons.push(Ui.el('span', { text: 'No years recorded yet.', class: 'cw-section-note' }));
    }
    menu = Ui.card([Ui.el('h2', { class: 'cw-section-title', text: 'Choose a year' }), Ui.el('div', { class: 'cw-filters' }, buttons)]);
    render();
  }

  /* ---------------------------------- toast --------------------------------- */

  function showToast(text, tone) {
    const existing = document.querySelector('.cw-toast');
    if (existing && existing.parentNode) {
      existing.parentNode.removeChild(existing);
    }
    const node = Ui.el('div', { class: 'cw-toast' + (tone && tone !== 'info' ? ' cw-toast-' + tone : ''), text: text });
    document.body.appendChild(node);
    if (toastTimer) {
      clearTimeout(toastTimer);
    }
    toastTimer = setTimeout(function () {
      if (node.parentNode) {
        node.parentNode.removeChild(node);
      }
    }, 4000);
  }

  /* -------------------------------- messages ------------------------------- */

  window.addEventListener('message', function (event) {
    const message = event.data;
    if (!message || typeof message !== 'object') {
      return;
    }
    if (message.type === 'payload') {
      payload = message.payload;
      if (payload.availableYears && payload.availableYears.indexOf(payload.year) === -1) {
        payload.availableYears.unshift(payload.year);
      }
      render();
      return;
    }
    if (message.type === 'navigate') {
      if (PAGE_LABELS[message.page]) {
        state.page = message.page;
        persist();
        render();
      }
      return;
    }
    if (message.type === 'toast') {
      showToast(String(message.text || ''), message.tone);
    }
  });

  /* -------------------------------- keyboard ------------------------------- */

  window.addEventListener('keydown', function (event) {
    if (state.page !== 'wrapped') {
      return;
    }
    if (event.key === 'ArrowRight' || event.key === ' ') {
      event.preventDefault();
      actions.setWrappedSlide(state.wrappedSlide + 1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      actions.setWrappedSlide(state.wrappedSlide - 1);
    } else if (event.key === 'Escape') {
      actions.navigate('overview');
    }
  });

  /* ---------------------------------- boot --------------------------------- */

  post({ type: 'ready' });

  // If the host never answers (for example while it is still starting up), the
  // webview tells the user instead of spinning forever.
  setTimeout(function () {
    if (payload) {
      return;
    }
    const boot = document.querySelector('.cw-boot');
    if (boot) {
      Ui.clear(boot);
      boot.appendChild(Ui.el('div', { class: 'cw-boot-text', text: 'Still waiting for the extension host…' }));
      boot.appendChild(Ui.button('Try again', function () {
        post({ type: 'ready' });
        post({ type: 'refresh' });
      }, false, 'Ask the extension host again'));
    }
  }, 8000);

  void Format;
})();
