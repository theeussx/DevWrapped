/*
 * Dev Wrapped — chart primitives.
 *
 * Every chart is a small, dependency free SVG (or an HTML grid) built with
 * `createElementNS` / `createElement`, so nothing is ever parsed as HTML and
 * the strict Content Security Policy holds. Geometry lives in attributes,
 * colours in classes — no inline styles anywhere.
 */
(function () {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const DEFAULT_WIDTH = 640;

  function element(name, attributes) {
    const node = document.createElement(name);
    if (attributes) {
      Object.keys(attributes).forEach(function (key) {
        if (attributes[key] !== undefined && attributes[key] !== null) {
          node.setAttribute(key, String(attributes[key]));
        }
      });
    }
    return node;
  }

  function svgElement(name, attributes) {
    const node = document.createElementNS(SVG_NS, name);
    if (attributes) {
      Object.keys(attributes).forEach(function (key) {
        if (attributes[key] !== undefined && attributes[key] !== null) {
          node.setAttribute(key, String(attributes[key]));
        }
      });
    }
    return node;
  }

  function text(value) {
    return document.createTextNode(value === undefined || value === null ? '' : String(value));
  }

  /** Summarises a series for screen readers (the numbers are also listed below). */
  function describe(series) {
    if (!series.length) {
      return 'No data recorded.';
    }
    const max = series.reduce(function (best, point) {
      return point.value > best.value ? point : best;
    }, series[0]);
    return series.length + ' points; the highest is ' + max.label + '.';
  }

  /**
   * Vertical bar chart.
   *
   * `points` = [{ label, value }]. Used for the hourly, weekday, daily and
   * monthly distributions; the tallest bar is highlighted.
   */
  function bars(points, options) {
    const config = options || {};
    const width = config.width || DEFAULT_WIDTH;
    const height = config.height || 140;
    const items = points || [];
    const svg = svgElement('svg', {
      class: config.className || 'cw-chart',
      viewBox: '0 0 ' + width + ' ' + height,
      preserveAspectRatio: 'none',
      role: 'img',
      'aria-label': config.ariaLabel || describe(items),
    });
    if (items.length === 0) {
      svg.appendChild(svgElement('line', { class: 'cw-chart-grid', x1: 0, y1: height - 1, x2: width, y2: height - 1 }));
      return svg;
    }

    const labelSpace = config.hideLabels ? 4 : 16;
    const chartHeight = height - labelSpace;
    const max = items.reduce(function (best, point) {
      return Math.max(best, Number(point.value) || 0);
    }, 0);
    const slot = width / items.length;
    const barWidth = Math.max(2, Math.min(config.maxBarWidth || 26, slot * 0.72));
    const labelEvery = config.labelEvery || Math.ceil(items.length / 12);

    svg.appendChild(
      svgElement('line', { class: 'cw-chart-grid', x1: 0, y1: chartHeight, x2: width, y2: chartHeight })
    );

    items.forEach(function (point, index) {
      const value = Number(point.value) || 0;
      const ratio = max > 0 ? value / max : 0;
      const barHeight = ratio <= 0 ? 0 : Math.max(2, ratio * (chartHeight - 6));
      const x = index * slot + (slot - barWidth) / 2;
      const y = chartHeight - barHeight;
      const isLeader = value > 0 && value === max;
      if (barHeight > 0) {
        svg.appendChild(
          svgElement('rect', {
            class: 'cw-chart-bar' + (isLeader ? ' cw-chart-bar-leader' : ''),
            x: x,
            y: y,
            width: barWidth,
            height: barHeight,
            rx: 2,
          })
        );
      }
      if (!config.hideLabels && (index % labelEvery === 0 || index === items.length - 1)) {
        const label = svgElement('text', {
          class: 'cw-chart-label',
          x: index * slot + slot / 2,
          y: height - 4,
          'text-anchor': 'middle',
        });
        label.appendChild(text(point.label));
        svg.appendChild(label);
      }
    });

    return svg;
  }

  /** Bar chart for the 24 hour distribution. */
  function hourly(buckets) {
    const points = (buckets || []).map(function (bucket) {
      return { label: bucket.label, value: bucket.ms };
    });
    return bars(points, { ariaLabel: 'Activity per hour of the day', labelEvery: 4, height: 120 });
  }

  /** Bar chart for the weekday distribution (already ordered by the host). */
  function weekdays(buckets) {
    const points = (buckets || []).map(function (bucket) {
      return { label: bucket.label, value: bucket.ms };
    });
    return bars(points, { ariaLabel: 'Activity per day of the week', maxBarWidth: 44, height: 130 });
  }

  /** Trend chart: hours, days or months, depending on the page. */
  function trend(view) {
    const points = ((view && view.points) || []).map(function (point) {
      return { label: point.label, value: point.value };
    });
    const labelEvery = points.length > 20 ? Math.ceil(points.length / 10) : points.length > 10 ? 2 : 1;
    return bars(points, {
      ariaLabel: 'Activity over time',
      labelEvery: labelEvery,
      height: 150,
      maxBarWidth: view && view.granularity === 'month' ? 42 : 26,
    });
  }

  /** Donut chart with an HTML legend (language mix). */
  function donut(slices, options) {
    const config = options || {};
    const items = (slices || []).filter(function (slice) {
      return Number(slice.ms) > 0;
    });
    const wrapper = element('div');
    if (items.length === 0) {
      return wrapper;
    }
    const size = 148;
    const radius = size / 2 - 14;
    const thickness = 18;
    const centre = size / 2;
    const total = items.reduce(function (sum, slice) {
      return sum + (Number(slice.ms) || 0);
    }, 0);

    const svg = svgElement('svg', {
      class: 'cw-chart',
      viewBox: '0 0 ' + size + ' ' + size,
      role: 'img',
      'aria-label': describe(
        items.map(function (slice) {
          return { label: slice.label, value: slice.ms };
        })
      ),
    });

    let cursor = -Math.PI / 2;
    items.forEach(function (slice, index) {
      const share = total > 0 ? (Number(slice.ms) || 0) / total : 0;
      const sweep = share * Math.PI * 2;
      const end = cursor + sweep;
      const large = sweep > Math.PI ? 1 : 0;
      const x1 = centre + radius * Math.cos(cursor);
      const y1 = centre + radius * Math.sin(cursor);
      const x2 = centre + radius * Math.cos(end);
      const y2 = centre + radius * Math.sin(end);
      const x3 = centre + (radius - thickness) * Math.cos(end);
      const y3 = centre + (radius - thickness) * Math.sin(end);
      const x4 = centre + (radius - thickness) * Math.cos(cursor);
      const y4 = centre + (radius - thickness) * Math.sin(cursor);
      const path = svgElement('path', {
        class: 'cw-fill-' + ((index % 8) + 1),
        d: [
          'M', x1, y1,
          'A', radius, radius, 0, large, 1, x2, y2,
          'L', x3, y3,
          'A', radius - thickness, radius - thickness, 0, large, 0, x4, y4,
          'Z',
        ].join(' '),
        opacity: share > 0 ? 1 : 0,
      });
      svg.appendChild(path);
      cursor = end;
    });

    const centreLabel = svgElement('text', {
      class: 'cw-chart-label',
      x: centre,
      y: centre + 3,
      'text-anchor': 'middle',
    });
    centreLabel.appendChild(text(config.centreLabel || ''));
    svg.appendChild(centreLabel);

    wrapper.appendChild(svg);

    const legend = element('div', { class: 'cw-legend' });
    items.forEach(function (slice, index) {
      const item = element('span', { class: 'cw-legend-item' });
      item.appendChild(element('span', { class: 'cw-legend-swatch cw-swatch-' + ((index % 8) + 1) }));
      item.appendChild(text(slice.label + ' · ' + (slice.shareText || '')));
      legend.appendChild(item);
    });
    wrapper.appendChild(legend);
    return wrapper;
  }

  /**
   * Heat map (GitHub style): one column per week, one row per weekday.
   *
   * The view comes from the extension host with the level already computed
   * relative to the busiest day of the range.
   */
  function heatmap(view, options) {
    const config = options || {};
    const weeks = (view && view.weeks) || [];
    const wrapper = element('div', { class: 'cw-heatmap', role: 'img' });
    wrapper.setAttribute('aria-label', config.ariaLabel || 'Daily activity heat map');
    weeks.forEach(function (week) {
      const column = element('div', { class: 'cw-heatmap-week' });
      (week.days || []).forEach(function (day) {
        const classes = ['cw-heat-cell', 'cw-level-' + day.level];
        if (!day.inRange) {
          classes.push('cw-heat-out');
        }
        if (day.isToday) {
          classes.push('cw-heat-today');
        }
        const cell = element('div', { class: classes.join(' ') });
        cell.title = day.label + ' · ' + (day.ms > 0 ? describeMs(day.ms) : 'no activity');
        column.appendChild(cell);
      });
      wrapper.appendChild(column);
    });
    return wrapper;
  }

  /** One month as a grid of cells (used by the Month page and the Calendar page). */
  function monthGrid(view, options) {
    const config = options || {};
    const wrapper = element('div');
    const header = element('div', { class: 'cw-month-grid' });
    const labels = config.weekdayLabels || ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    labels.forEach(function (label) {
      const cell = element('div', { class: 'cw-month-head' });
      cell.appendChild(text(label));
      header.appendChild(cell);
    });
    wrapper.appendChild(header);

    const grid = element('div', { class: 'cw-month-grid' });
    const weeks = (view && view.weeks) || [];
    weeks.forEach(function (week) {
      (week.days || []).forEach(function (day) {
        const classes = ['cw-month-cell', 'cw-level-' + day.level];
        if (!day.inRange) {
          classes.push('cw-heat-out');
        }
        if (day.isToday) {
          classes.push('cw-heat-today');
        }
        const cell = element('div', { class: classes.join(' ') });
        cell.title = day.label + ' · ' + (day.ms > 0 ? describeMs(day.ms) : 'no activity');
        cell.appendChild(text(day.inRange ? String(Number(day.date.slice(8, 10))) : ''));
        grid.appendChild(cell);
      });
    });
    wrapper.appendChild(grid);
    return wrapper;
  }

  /** Small inline chart used inside cards. */
  function sparkline(points) {
    const items = (points || []).slice(-30);
    return bars(
      items.map(function (point) {
        return { label: '', value: point.value };
      }),
      { hideLabels: true, height: 34, maxBarWidth: 8, className: 'cw-chart', ariaLabel: 'Recent activity' }
    );
  }

  /** Local duration formatting (kept independent from the format module). */
  function describeMs(ms) {
    const value = Number(ms) || 0;
    const minutes = Math.round(value / 60000);
    if (minutes < 60) {
      return minutes + ' min';
    }
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest === 0 ? hours + ' h' : hours + ' h ' + rest + ' min';
  }

  globalThis.CodeWrappedCharts = {
    element: element,
    svgElement: svgElement,
    text: text,
    bars: bars,
    hourly: hourly,
    weekdays: weekdays,
    trend: trend,
    donut: donut,
    heatmap: heatmap,
    monthGrid: monthGrid,
    sparkline: sparkline,
    describeMs: describeMs,
  };
})();
