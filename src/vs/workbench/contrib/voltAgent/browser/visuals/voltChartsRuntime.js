/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Volt ADK. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
//#endregion
export function voltChartsRuntime(win) {
    //#region Basics
    const doc = win.document;
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const VERSION = 1;
    const DRAW_MS = 460;
    const TWEEN_MS = 420;
    const FADE_MS = 200;
    const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)';
    const MAX_POINTS = 50_000;
    const DEFAULT_STRINGS = {
        emptyTitle: 'No data yet',
        emptyMessage: 'Values will appear here once there is something to show.',
        loading: 'Loading',
        all: 'All',
        fewer: 'fewer',
        more: 'more',
        showAll: 'Show all',
        showLess: 'Show less',
        zoomHint: 'Click to zoom in. Right click or Esc to zoom out.',
        open: 'Click to open',
        total: 'Total',
        other: 'Other',
        vsPrevious: 'vs previous',
        chart: 'Chart',
    };
    let uid = 0;
    const nextId = (prefix) => `vc-${prefix}-${(++uid).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    function h(tag, className, parent, text) {
        const node = doc.createElement(tag);
        if (className) {
            node.className = className;
        }
        if (text !== undefined) {
            node.textContent = text;
        }
        parent?.appendChild(node);
        return node;
    }
    function s(tag, attrs, parent) {
        const node = doc.createElementNS(SVG_NS, tag);
        if (attrs) {
            setAttrs(node, attrs);
        }
        parent?.appendChild(node);
        return node;
    }
    function setAttrs(node, attrs) {
        for (const key in attrs) {
            const value = attrs[key];
            if (value === undefined) {
                node.removeAttribute(key);
            }
            else {
                node.setAttribute(key, typeof value === 'number' ? num(value) : value);
            }
        }
    }
    /** Coordinates to two decimals: short path strings, no visible loss. */
    function num(value) {
        return String(Math.round(value * 100) / 100);
    }
    const clamp = (value, lo, hi) => value < lo ? lo : value > hi ? hi : value;
    const isNum = (value) => typeof value === 'number' && Number.isFinite(value);
    const lerp = (a, b, t) => a + (b - a) * t;
    const easeOut = (t) => 1 - Math.pow(1 - t, 3);
    function dpr() {
        return Math.max(1, Math.min(3, win.devicePixelRatio || 1));
    }
    /** A hairline's center on the device pixel grid, so 1px lines never blur across two pixels. */
    function crisp(value) {
        const ratio = dpr();
        return (Math.round(value * ratio - 0.5) + 0.5) / ratio;
    }
    function reducedMotion() {
        return !!win.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    }
    function isRecord(value) {
        return !!value && typeof value === 'object' && !Array.isArray(value);
    }
    function str(value, max = 200) {
        if (typeof value === 'number' && Number.isFinite(value)) {
            return String(value);
        }
        if (typeof value !== 'string') {
            return undefined;
        }
        const clean = value.replace(/\s+/g, ' ').trim();
        return clean ? clean.slice(0, max) : undefined;
    }
    /** Text width in px for a CSS font, measured on one shared canvas. */
    let measureContext;
    function textWidth(text, font) {
        if (measureContext === undefined) {
            measureContext = doc.createElement('canvas').getContext('2d');
        }
        if (!measureContext) {
            return text.length * 6.5;
        }
        measureContext.font = font;
        return measureContext.measureText(text).width;
    }
    /** The resolved monospace family (`--vc-mono` can hold var() chains a canvas cannot read). */
    function monoFamily(host) {
        const probe = doc.createElement('span');
        probe.style.cssText = 'position:absolute;visibility:hidden;font-family:var(--vc-mono)';
        host.appendChild(probe);
        const family = win.getComputedStyle(probe).fontFamily || 'monospace';
        probe.remove();
        return family;
    }
    function ellipsize(text, font, max) {
        if (max <= 0) {
            return '';
        }
        if (textWidth(text, font) <= max) {
            return text;
        }
        let lo = 0;
        let hi = text.length;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (textWidth(`${text.slice(0, mid)}…`, font) <= max) {
                lo = mid;
            }
            else {
                hi = mid - 1;
            }
        }
        return lo > 0 ? `${text.slice(0, lo).trimEnd()}…` : '';
    }
    /** Index of the value in a sorted array closest to `target`. */
    function nearestIndex(sorted, target) {
        const n = sorted.length;
        if (n === 0) {
            return -1;
        }
        let lo = 0;
        let hi = n - 1;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (sorted[mid] < target) {
                lo = mid + 1;
            }
            else {
                hi = mid;
            }
        }
        if (lo > 0 && Math.abs(sorted[lo - 1] - target) <= Math.abs(sorted[lo] - target)) {
            return lo - 1;
        }
        return lo;
    }
    const UNIT_KINDS = ['number', 'count', 'percent', 'ratio', 'usd', 'tokens', 'ms', 's', 'bytes'];
    const SAFE_AFFIX = /^[^<>{};]{0,12}$/;
    /** The unit an agent named, or one guessed from the words around the numbers. */
    function resolveUnit(value, hint, values) {
        if (typeof value === 'string') {
            const key = value.toLowerCase().trim();
            const alias = { '$': 'usd', dollars: 'usd', cost: 'usd', currency: 'usd', '%': 'percent', pct: 'percent', seconds: 's', sec: 's', milliseconds: 'ms', duration: 'ms', integer: 'count', int: 'count', bytes: 'bytes', size: 'bytes' };
            const kind = UNIT_KINDS.includes(key) ? key : alias[key];
            if (kind) {
                return { kind, prefix: '', suffix: '' };
            }
            if (SAFE_AFFIX.test(value)) {
                return { kind: 'custom', prefix: '', suffix: value.startsWith(' ') || value.length > 1 ? ` ${value.trim()}` : value };
            }
        }
        if (isRecord(value)) {
            const prefix = typeof value.prefix === 'string' && SAFE_AFFIX.test(value.prefix) ? value.prefix : '';
            const suffix = typeof value.suffix === 'string' && SAFE_AFFIX.test(value.suffix) ? value.suffix : '';
            const decimals = isNum(value.decimals) ? clamp(Math.round(value.decimals), 0, 6) : undefined;
            return { kind: 'custom', prefix, suffix, decimals };
        }
        const words = (hint ?? '').toLowerCase();
        let max = 0;
        for (const v of values ?? []) {
            max = Math.max(max, Math.abs(v));
        }
        if (/\bcost|spend|price|\$|usd|dollar|bill/.test(words)) {
            return { kind: 'usd', prefix: '', suffix: '' };
        }
        if (/token/.test(words)) {
            return { kind: 'tokens', prefix: '', suffix: '' };
        }
        if (/latency|duration|ttft|time to first|response time|\bms\b/.test(words)) {
            return { kind: 'ms', prefix: '', suffix: '' };
        }
        if (/percent|share|%|utili[sz]|\brate\b|ratio|coverage/.test(words)) {
            return { kind: max <= 1 && max > 0 ? 'ratio' : 'percent', prefix: '', suffix: '' };
        }
        if (/\bbytes?\b|memory|disk|\bsize\b/.test(words)) {
            return { kind: 'bytes', prefix: '', suffix: '' };
        }
        return { kind: 'number', prefix: '', suffix: '' };
    }
    const PERCENT_UNIT = { kind: 'percent', prefix: '', suffix: '' };
    let locale;
    const numberFormats = new Map();
    function numberFormat(min, max) {
        const key = `${min}:${max}`;
        let format = numberFormats.get(key);
        if (!format) {
            try {
                format = new Intl.NumberFormat(locale, { minimumFractionDigits: min, maximumFractionDigits: max });
            }
            catch {
                format = new Intl.NumberFormat(undefined, { minimumFractionDigits: min, maximumFractionDigits: max });
            }
            numberFormats.set(key, format);
        }
        return format;
    }
    /** Decimals for a number at `step` resolution (axis ticks): 2.5 → 1, 0.25 → 2, 50 → 0. */
    function stepDecimals(step) {
        if (!isNum(step) || step <= 0) {
            return 0;
        }
        let decimals = 0;
        while (decimals < 6 && Math.abs(Math.round(step * Math.pow(10, decimals)) - step * Math.pow(10, decimals)) > 1e-6) {
            decimals++;
        }
        return decimals;
    }
    const SCALES = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
    /** Three significant digits with a scale letter: 850K, 1.36M, 24M. Below 1,000 the number itself. */
    function compact(value) {
        const abs = Math.abs(value);
        for (const [size, letter] of SCALES) {
            if (abs >= size * 0.9995) {
                const scaled = value / size;
                const a = Math.abs(scaled);
                const digits = a >= 99.95 ? 0 : a >= 9.995 ? 1 : 2;
                return `${numberFormat(0, digits).format(Number(scaled.toFixed(digits)))}${letter}`;
            }
        }
        return small(value);
    }
    /** Numbers under 1,000: up to two decimals, three significant digits under 1. */
    function small(value) {
        const abs = Math.abs(value);
        if (abs === 0) {
            return '0';
        }
        if (abs < 1) {
            const digits = clamp(2 - Math.floor(Math.log10(abs)), 2, 6);
            return numberFormat(0, digits).format(Number(value.toPrecision(3)));
        }
        return numberFormat(0, abs >= 100 ? 1 : 2).format(value);
    }
    /** An axis label: every tick shares the decimals of the step, so labels line up. */
    function formatTick(value, step, unit) {
        const clean = Math.abs(value) < step * 1e-9 ? 0 : value;
        switch (unit.kind) {
            case 'percent':
                return `${numberFormat(0, stepDecimals(step)).format(clean)}%`;
            case 'ratio':
                return `${numberFormat(0, stepDecimals(step * 100)).format(clean * 100)}%`;
            case 'ms':
                return formatDuration(clean, true);
            case 's':
                return formatDuration(clean * 1000, true);
            case 'bytes':
                return formatBytes(clean, true);
            case 'usd':
                return `${clean < 0 ? '-' : ''}$${tickNumber(Math.abs(clean), step)}`;
            case 'custom':
                return `${unit.prefix}${unit.decimals !== undefined ? numberFormat(unit.decimals, unit.decimals).format(clean) : tickNumber(clean, step)}${unit.suffix}`;
            default:
                return tickNumber(clean, step);
        }
    }
    function tickNumber(value, step) {
        const abs = Math.max(Math.abs(value), step);
        for (const [size, letter] of SCALES) {
            if (abs >= size) {
                return `${numberFormat(0, stepDecimals(step / size)).format(value / size)}${letter}`;
            }
        }
        return numberFormat(0, stepDecimals(step)).format(value);
    }
    /** A value read on its own (tooltips, headlines): `$18.42`, `2.1M tokens`, `42 ms`, `51.2%`. */
    function formatValue(value, unit, long = false) {
        if (!isNum(value)) {
            return '—';
        }
        switch (unit.kind) {
            case 'usd': {
                const abs = Math.abs(value);
                const sign = value < 0 ? '-' : '';
                if (abs === 0) {
                    return '$0.00';
                }
                if (abs < 0.0001) {
                    return `${sign}<$0.0001`;
                }
                if (abs < 1) {
                    return `${sign}$${numberFormat(2, clamp(2 - Math.floor(Math.log10(abs)), 2, 4)).format(Number(abs.toPrecision(2)))}`;
                }
                if (abs < 10_000) {
                    return `${sign}$${numberFormat(2, 2).format(abs)}`;
                }
                return `${sign}$${compact(abs)}`;
            }
            case 'percent':
                return formatPercent(value);
            case 'ratio':
                return formatPercent(value * 100);
            case 'tokens':
                return long ? `${compact(value)} tokens` : compact(value);
            case 'count':
                return Math.abs(value) < 10_000 ? numberFormat(0, Number.isInteger(value) ? 0 : 1).format(value) : compact(value);
            case 'ms':
                return formatDuration(value, false);
            case 's':
                return formatDuration(value * 1000, false);
            case 'bytes':
                return formatBytes(value, false);
            case 'custom':
                return `${unit.prefix}${unit.decimals !== undefined ? numberFormat(unit.decimals, unit.decimals).format(value) : (Math.abs(value) < 10_000 ? small(value) : compact(value))}${unit.suffix}`;
            default:
                return Math.abs(value) < 10_000 ? small(value) : compact(value);
        }
    }
    function formatPercent(value) {
        const abs = Math.abs(value);
        if (abs > 0 && abs < 0.1) {
            return value < 0 ? '>-0.1%' : '<0.1%';
        }
        return `${numberFormat(0, abs < 10 ? 1 : 0).format(value)}%`;
    }
    function formatDuration(ms, tick) {
        const abs = Math.abs(ms);
        const sign = ms < 0 ? '-' : '';
        if (abs === 0) {
            return tick ? '0' : '0 ms';
        }
        if (abs < 1) {
            return `${sign}${numberFormat(0, 2).format(abs)} ms`;
        }
        if (abs < 1000) {
            return `${sign}${numberFormat(0, 0).format(abs)} ms`;
        }
        if (abs < 60_000) {
            return `${sign}${numberFormat(0, abs < 10_000 ? 1 : 0).format(abs / 1000)}s`;
        }
        if (abs < 3_600_000) {
            const minutes = Math.floor(abs / 60_000);
            const seconds = Math.round((abs % 60_000) / 1000);
            return tick || seconds === 0 ? `${sign}${minutes}m` : `${sign}${minutes}m ${String(seconds).padStart(2, '0')}s`;
        }
        const hours = Math.floor(abs / 3_600_000);
        const minutes = Math.round((abs % 3_600_000) / 60_000);
        return tick || minutes === 0 ? `${sign}${hours}h` : `${sign}${hours}h ${minutes}m`;
    }
    function formatBytes(bytes, tick) {
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let value = Math.abs(bytes);
        let index = 0;
        while (value >= 1024 && index < units.length - 1) {
            value /= 1024;
            index++;
        }
        const digits = index === 0 || value >= 100 || (tick && Number.isInteger(value)) ? 0 : 1;
        return `${bytes < 0 ? '-' : ''}${numberFormat(0, digits).format(value)} ${units[index]}`;
    }
    /** `↑ 12.4%`, or percentage points for percent units, where a relative change misleads. */
    function formatDelta(current, previous, unit) {
        if (!isNum(current) || !isNum(previous)) {
            return undefined;
        }
        if (unit.kind === 'percent' || unit.kind === 'ratio') {
            const points = (current - previous) * (unit.kind === 'ratio' ? 100 : 1);
            const direction = Math.abs(points) < 0.05 ? 0 : points > 0 ? 1 : -1;
            return { text: `${direction > 0 ? '↑' : direction < 0 ? '↓' : '→'} ${numberFormat(0, 1).format(Math.abs(points))} pts`, direction };
        }
        if (previous === 0) {
            return current === 0 ? { text: '→ 0%', direction: 0 } : undefined;
        }
        const change = ((current - previous) / Math.abs(previous)) * 100;
        const direction = Math.abs(change) < 0.05 ? 0 : change > 0 ? 1 : -1;
        const abs = Math.abs(change);
        return { text: `${direction > 0 ? '↑' : direction < 0 ? '↓' : '→'} ${numberFormat(0, abs >= 100 ? 0 : 1).format(abs)}%`, direction };
    }
    const MINUTE = 60_000;
    const HOUR = 60 * MINUTE;
    const DAY = 24 * HOUR;
    function timeZoneOf(value) {
        if (typeof value === 'string' && value.trim()) {
            const name = value.trim();
            if (/^(utc|gmt|z)$/i.test(name)) {
                return { utc: true, name: 'UTC' };
            }
            try {
                new Intl.DateTimeFormat(undefined, { timeZone: name });
                return { utc: false, name };
            }
            catch {
                // unknown zone: the reader's own
            }
        }
        return { utc: false, name: undefined };
    }
    /** Epoch ms from a number (ms or seconds) or a date string. Date-only strings are midnights in the chart's zone. */
    function parseTime(value, zone) {
        if (isNum(value)) {
            return Math.abs(value) >= 1e11 ? value : value * 1000;
        }
        if (typeof value !== 'string') {
            return undefined;
        }
        const text = value.trim();
        const dateOnly = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(text);
        if (dateOnly) {
            const year = Number(dateOnly[1]);
            const month = Number(dateOnly[2]) - 1;
            const day = dateOnly[3] ? Number(dateOnly[3]) : 1;
            return zone.utc ? Date.UTC(year, month, day) : new Date(year, month, day).getTime();
        }
        if (/^\d{4}$/.test(text)) {
            return zone.utc ? Date.UTC(Number(text), 0, 1) : new Date(Number(text), 0, 1).getTime();
        }
        if (!/^\d{4}-\d{2}-\d{2}[T ]\d/.test(text) && !/^[A-Za-z]{3,9},? /.test(text)) {
            return undefined;
        }
        const parsed = Date.parse(zone.utc && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(text) ? `${text.replace(' ', 'T')}Z` : text);
        return Number.isFinite(parsed) ? parsed : undefined;
    }
    function looksLikeTime(value) {
        return typeof value === 'string' && /^\d{4}-\d{2}(-\d{2})?([T ]\d{2}:\d{2}.*)?$/.test(value.trim());
    }
    function parts(t, zone) {
        const date = new Date(t);
        return zone.utc
            ? { y: date.getUTCFullYear(), m: date.getUTCMonth(), d: date.getUTCDate(), hh: date.getUTCHours(), mm: date.getUTCMinutes(), wd: date.getUTCDay() }
            : { y: date.getFullYear(), m: date.getMonth(), d: date.getDate(), hh: date.getHours(), mm: date.getMinutes(), wd: date.getDay() };
    }
    function makeTime(zone, y, m, d = 1, hh = 0, mm = 0) {
        return zone.utc ? Date.UTC(y, m, d, hh, mm) : new Date(y, m, d, hh, mm).getTime();
    }
    function addStep(t, step, count, zone) {
        if (isNum(step)) {
            return t + step * count;
        }
        const p = parts(t, zone);
        switch (step) {
            case 'minute': return t + count * MINUTE;
            case 'hour': return t + count * HOUR;
            case 'day': return makeTime(zone, p.y, p.m, p.d + count, p.hh, p.mm);
            case 'week': return makeTime(zone, p.y, p.m, p.d + count * 7, p.hh, p.mm);
            case 'month': return makeTime(zone, p.y, p.m + count, p.d, p.hh, p.mm);
            case 'year': return makeTime(zone, p.y + count, p.m, p.d, p.hh, p.mm);
        }
        return t;
    }
    /** The spacing of the data: the median gap, read as minutes, hours, days, weeks, months or years. */
    function grainOf(xs) {
        if (xs.length < 2) {
            return 'day';
        }
        const gaps = [];
        for (let index = 1; index < xs.length && gaps.length < 2000; index++) {
            const gap = xs[index] - xs[index - 1];
            if (gap > 0) {
                gaps.push(gap);
            }
        }
        gaps.sort((a, b) => a - b);
        const median = gaps[gaps.length >> 1] ?? DAY;
        if (median < 50 * MINUTE) {
            return 'minute';
        }
        if (median < 20 * HOUR) {
            return 'hour';
        }
        if (median < 5 * DAY) {
            return 'day';
        }
        if (median < 25 * DAY) {
            return 'week';
        }
        if (median < 300 * DAY) {
            return 'month';
        }
        return 'year';
    }
    const dateFormats = new Map();
    function dateFormat(options, zone) {
        const key = `${zone.name ?? ''}|${JSON.stringify(options)}`;
        let format = dateFormats.get(key);
        if (!format) {
            try {
                format = new Intl.DateTimeFormat(locale, { ...options, timeZone: zone.name });
            }
            catch {
                format = new Intl.DateTimeFormat(undefined, options);
            }
            dateFormats.set(key, format);
        }
        return format;
    }
    function formatTimePoint(t, grain, zone) {
        const sameYear = parts(t, zone).y === parts(Date.now(), zone).y;
        switch (grain) {
            case 'minute':
            case 'hour':
                return dateFormat({ month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(sameYear ? {} : { year: 'numeric' }) }, zone).format(t);
            case 'day':
                return dateFormat({ weekday: 'short', month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) }, zone).format(t);
            case 'week':
                return `Week of ${dateFormat({ month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) }, zone).format(t)}`;
            case 'month':
                return dateFormat({ month: 'long', year: 'numeric' }, zone).format(t);
            case 'year':
                return dateFormat({ year: 'numeric' }, zone).format(t);
        }
    }
    const TIME_INTERVALS = [
        { unit: 'minute', count: 1, ms: MINUTE },
        { unit: 'minute', count: 5, ms: 5 * MINUTE },
        { unit: 'minute', count: 15, ms: 15 * MINUTE },
        { unit: 'minute', count: 30, ms: 30 * MINUTE },
        { unit: 'hour', count: 1, ms: HOUR },
        { unit: 'hour', count: 3, ms: 3 * HOUR },
        { unit: 'hour', count: 6, ms: 6 * HOUR },
        { unit: 'hour', count: 12, ms: 12 * HOUR },
        { unit: 'day', count: 1, ms: DAY },
        { unit: 'day', count: 2, ms: 2 * DAY },
        { unit: 'day', count: 7, ms: 7 * DAY },
        { unit: 'day', count: 14, ms: 14 * DAY },
        { unit: 'month', count: 1, ms: 30 * DAY },
        { unit: 'month', count: 3, ms: 91 * DAY },
        { unit: 'month', count: 6, ms: 182 * DAY },
        { unit: 'year', count: 1, ms: 365 * DAY },
        { unit: 'year', count: 2, ms: 730 * DAY },
        { unit: 'year', count: 5, ms: 1826 * DAY },
        { unit: 'year', count: 10, ms: 3652 * DAY },
    ];
    /**
     * Calendar-aligned ticks between `lo` and `hi`, at most `maxCount`: midnights, month starts,
     * and day steps counted from the first day shown (Jul 6, Jul 20, Aug 3...).
     */
    function timeTicks(lo, hi, maxCount, zone) {
        const span = Math.max(1, hi - lo);
        const interval = TIME_INTERVALS.find(candidate => span / candidate.ms <= maxCount) ?? TIME_INTERVALS[TIME_INTERVALS.length - 1];
        const values = [];
        const p = parts(lo, zone);
        let t;
        switch (interval.unit) {
            case 'minute':
            case 'hour': {
                const size = interval.unit === 'minute' ? interval.count : interval.count * 60;
                const minutes = p.hh * 60 + p.mm;
                const first = Math.ceil(minutes / size) * size;
                t = makeTime(zone, p.y, p.m, p.d, 0, first);
                for (; t <= hi && values.length < 500; t += size * MINUTE) {
                    values.push(t);
                }
                break;
            }
            case 'day': {
                t = makeTime(zone, p.y, p.m, p.d);
                if (t < lo) {
                    t = makeTime(zone, p.y, p.m, p.d + 1);
                }
                while (t <= hi && values.length < 500) {
                    values.push(t);
                    const q = parts(t, zone);
                    t = makeTime(zone, q.y, q.m, q.d + interval.count);
                }
                break;
            }
            case 'month': {
                let month = Math.ceil((p.m + (p.d > 1 || p.hh > 0 ? 1 : 0)) / interval.count) * interval.count;
                for (t = makeTime(zone, p.y, month); t <= hi && values.length < 500; month += interval.count, t = makeTime(zone, p.y, month)) {
                    if (t >= lo) {
                        values.push(t);
                    }
                }
                break;
            }
            case 'year': {
                let year = Math.ceil((p.y + (p.m > 0 || p.d > 1 ? 1 : 0)) / interval.count) * interval.count;
                for (t = makeTime(zone, year, 0); t <= hi && values.length < 500; year += interval.count, t = makeTime(zone, year, 0)) {
                    values.push(t);
                }
                break;
            }
        }
        const spansYears = parts(lo, zone).y !== parts(hi, zone).y;
        return values.map((value, index) => {
            const q = parts(value, zone);
            let label;
            if (interval.unit === 'minute' || interval.unit === 'hour') {
                label = q.hh === 0 && q.mm === 0
                    ? dateFormat({ month: 'short', day: 'numeric' }, zone).format(value)
                    : dateFormat({ hour: 'numeric', ...(q.mm ? { minute: '2-digit' } : {}) }, zone).format(value);
            }
            else if (interval.unit === 'day') {
                label = dateFormat({ month: 'short', day: 'numeric' }, zone).format(value);
            }
            else if (interval.unit === 'month') {
                label = q.m === 0 || (index === 0 && spansYears)
                    ? dateFormat({ month: 'short', year: 'numeric' }, zone).format(value)
                    : dateFormat({ month: 'short' }, zone).format(value);
            }
            else {
                label = String(q.y);
            }
            return { value, label };
        });
    }
    const RANGE_LENGTHS = { '1H': HOUR, '6H': 6 * HOUR, '1D': DAY, '24H': DAY, '7D': 7 * DAY, '1W': 7 * DAY, '14D': 14 * DAY, '30D': 30 * DAY, '1M': 30 * DAY, '90D': 90 * DAY, '3M': 90 * DAY, '6M': 182 * DAY, '1Y': 365 * DAY };
    function rangeNoun(key) {
        switch (key) {
            case '1H': return 'hour';
            case '6H': return '6 hours';
            case '1D':
            case '24H': return 'day';
            case '7D':
            case '1W': return '7 days';
            case '14D': return '14 days';
            case '30D':
            case '1M': return '30 days';
            case '90D':
            case '3M': return '3 months';
            case '6M': return '6 months';
            case '1Y': return 'year';
        }
        return 'period';
    }
    /** 1, 2, 2.5 or 5 times a power of ten, so tick labels stay round. Counts never get 2.5. */
    function niceStep(raw, integer) {
        if (!(raw > 0) || !Number.isFinite(raw)) {
            return 1;
        }
        const power = Math.pow(10, Math.floor(Math.log10(raw)));
        for (const factor of [1, 2, 2.5, 5, 10]) {
            if (integer && factor === 2.5 && power < 10) {
                continue;
            }
            if (raw <= factor * power * (1 + 1e-9)) {
                return integer ? Math.max(1, factor * power) : factor * power;
            }
        }
        return 10 * power;
    }
    /** Round ticks covering [min, max], about `count` of them; a fixed end stays where the spec put it. */
    function niceScale(min, max, count, integer, fixedLo, fixedHi) {
        let lo = min;
        let hi = max;
        if (!(hi > lo)) {
            if (lo === 0) {
                hi = 1;
            }
            else {
                const pad = Math.abs(lo) * 0.1 || 1;
                lo -= pad;
                hi += pad;
            }
        }
        const step = niceStep((hi - lo) / Math.max(1, count), integer);
        const decimals = stepDecimals(step);
        const niceLo = fixedLo ?? Math.floor(lo / step + 1e-9) * step;
        const niceHi = fixedHi ?? Math.ceil(hi / step - 1e-9) * step;
        const values = [];
        const first = Math.ceil(niceLo / step - 1e-9) * step;
        for (let value = first; value <= niceHi + step * 1e-6 && values.length < 50; value += step) {
            values.push(Number(value.toFixed(decimals)));
        }
        return { lo: niceLo, hi: niceHi > niceLo ? niceHi : niceLo + step, step, values };
    }
    /**
     * Monotone cubic (Fritsch-Carlson) through the points: as smooth as a hand-drawn curve, but it
     * never overshoots, so a quiet day never dips below zero and a peak is never taller than it was.
     */
    function monotonePath(points, move) {
        const n = points.length;
        if (n === 0) {
            return '';
        }
        const start = `${move ? 'M' : 'L'}${num(points[0][0])},${num(points[0][1])}`;
        if (n === 1) {
            return start;
        }
        if (n === 2) {
            return `${start}L${num(points[1][0])},${num(points[1][1])}`;
        }
        const dx = [];
        const slopes = [];
        for (let index = 0; index < n - 1; index++) {
            dx.push(points[index + 1][0] - points[index][0]);
            slopes.push((points[index + 1][1] - points[index][1]) / (dx[index] || 1));
        }
        const tangents = [slopes[0]];
        for (let index = 1; index < n - 1; index++) {
            tangents.push(slopes[index - 1] * slopes[index] <= 0 ? 0 : (slopes[index - 1] + slopes[index]) / 2);
        }
        tangents.push(slopes[n - 2]);
        for (let index = 0; index < n - 1; index++) {
            if (slopes[index] === 0) {
                tangents[index] = 0;
                tangents[index + 1] = 0;
                continue;
            }
            const a = tangents[index] / slopes[index];
            const b = tangents[index + 1] / slopes[index];
            const sum = a * a + b * b;
            if (sum > 9) {
                const t = 3 / Math.sqrt(sum);
                tangents[index] = t * a * slopes[index];
                tangents[index + 1] = t * b * slopes[index];
            }
        }
        let d = start;
        for (let index = 0; index < n - 1; index++) {
            const [x0, y0] = points[index];
            const [x1, y1] = points[index + 1];
            const third = dx[index] / 3;
            d += `C${num(x0 + third)},${num(y0 + tangents[index] * third)} ${num(x1 - third)},${num(y1 - tangents[index + 1] * third)} ${num(x1)},${num(y1)}`;
        }
        return d;
    }
    function linearPath(points, move) {
        let d = '';
        points.forEach((point, index) => {
            d += `${index === 0 && move ? 'M' : 'L'}${num(point[0])},${num(point[1])}`;
        });
        return d;
    }
    function stepPath(points, move) {
        let d = '';
        points.forEach((point, index) => {
            if (index === 0) {
                d += `${move ? 'M' : 'L'}${num(point[0])},${num(point[1])}`;
            }
            else {
                const mid = (points[index - 1][0] + point[0]) / 2;
                d += `H${num(mid)}V${num(point[1])}H${num(point[0])}`;
            }
        });
        return d;
    }
    function curvePath(points, curve, move) {
        return curve === 'step' ? stepPath(points, move) : curve === 'linear' ? linearPath(points, move) : monotonePath(points, move);
    }
    /** Runs of finite points; a gap (missing bucket) breaks the line. */
    function runs(points) {
        const out = [];
        let run = [];
        for (const point of points) {
            if (Number.isFinite(point[1])) {
                run.push(point);
            }
            else if (run.length) {
                out.push(run);
                run = [];
            }
        }
        if (run.length) {
            out.push(run);
        }
        return out;
    }
    /** Area between `top` and `bottom` (same x), each run closed on its own. */
    function areaPath(top, bottom, curve) {
        let d = '';
        let start = -1;
        const flush = (end) => {
            if (start < 0) {
                return;
            }
            const upper = top.slice(start, end);
            const lower = bottom.slice(start, end).reverse();
            if (upper.length > 1) {
                d += `${curvePath(upper, curve, true)}${curvePath(lower, curve, false)}Z`;
            }
            start = -1;
        };
        for (let index = 0; index < top.length; index++) {
            const ok = Number.isFinite(top[index][1]) && Number.isFinite(bottom[index][1]);
            if (ok && start < 0) {
                start = index;
            }
            else if (!ok) {
                flush(index);
            }
        }
        flush(top.length);
        return d;
    }
    /** A bar with rounded far corners (top for positive values, bottom for negative). */
    function barPath(x, y0, y1, width, radius) {
        const top = Math.min(y0, y1);
        const bottom = Math.max(y0, y1);
        const height = bottom - top;
        if (height <= 0.01 || width <= 0) {
            return '';
        }
        const r = Math.min(radius, width / 2, height);
        if (y1 <= y0) {
            return `M${num(x)},${num(bottom)}V${num(top + r)}Q${num(x)},${num(top)} ${num(x + r)},${num(top)}H${num(x + width - r)}Q${num(x + width)},${num(top)} ${num(x + width)},${num(top + r)}V${num(bottom)}Z`;
        }
        return `M${num(x)},${num(top)}V${num(bottom - r)}Q${num(x)},${num(bottom)} ${num(x + r)},${num(bottom)}H${num(x + width - r)}Q${num(x + width)},${num(bottom)} ${num(x + width)},${num(bottom - r)}V${num(top)}Z`;
    }
    /**
     * Picks which points to draw when there are more than pixels: per pixel column the first,
     * lowest, highest and last (M4). Every spike and dip survives; gaps stay gaps.
     */
    function m4(px, ys) {
        const out = [];
        let column = Number.NaN;
        let first = -1;
        let low = -1;
        let high = -1;
        let last = -1;
        const flush = () => {
            if (first < 0) {
                return;
            }
            const keep = [first, low, high, last].filter((value, index, all) => all.indexOf(value) === index).sort((a, b) => a - b);
            out.push(...keep);
            first = -1;
        };
        for (let index = 0; index < px.length; index++) {
            if (!Number.isFinite(ys[index])) {
                flush();
                out.push(index);
                column = Number.NaN;
                continue;
            }
            const col = Math.floor(px[index]);
            if (col !== column || first < 0) {
                flush();
                column = col;
                first = low = high = last = index;
            }
            else {
                last = index;
                if (ys[index] < ys[low]) {
                    low = index;
                }
                if (ys[index] > ys[high]) {
                    high = index;
                }
            }
        }
        flush();
        return out;
    }
    //#endregion
    //#region Color
    const PALETTE = [1, 2, 3, 4, 5, 6, 7, 8].map(index => `var(--vc-c${index})`);
    const NAMED_COLORS = {
        accent: 'var(--vc-accent)', primary: 'var(--vc-accent)', blue: 'var(--vc-blue)', green: 'var(--vc-green)', orange: 'var(--vc-orange)',
        purple: 'var(--vc-purple)', yellow: 'var(--vc-yellow)', red: 'var(--vc-red)', pink: 'var(--vc-pink)', teal: 'var(--vc-teal)', cyan: 'var(--vc-teal)',
        gray: 'var(--vc-other)', grey: 'var(--vc-other)', muted: 'var(--vc-other)', other: 'var(--vc-other)', foreground: 'var(--vc-fg)',
        success: 'var(--vc-good)', good: 'var(--vc-good)', error: 'var(--vc-bad)', bad: 'var(--vc-bad)', warning: 'var(--vc-yellow)',
    };
    const OTHER_NAME = /^(other|others|rest|remaining|misc|everything else|unknown)\b/i;
    /** A CSS color the agent may pass through, or undefined. Anything that could break out of a property is refused. */
    function cssColor(value) {
        if (isNum(value) && value >= 1 && value <= 8) {
            return PALETTE[Math.round(value) - 1];
        }
        if (typeof value !== 'string') {
            return undefined;
        }
        const text = value.trim();
        const lower = text.toLowerCase();
        if (NAMED_COLORS[lower]) {
            return NAMED_COLORS[lower];
        }
        const chart = /^(?:chart-?|c)([1-8])$/.exec(lower);
        if (chart) {
            return PALETTE[Number(chart[1]) - 1];
        }
        if (/^--[a-z0-9-]+$/i.test(text)) {
            return `var(${text})`;
        }
        if (/[;{}<>\\]/.test(text) || text.length > 120) {
            return undefined;
        }
        if (/^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix|var)\(.*\))$/i.test(text)) {
            return text;
        }
        return /^[a-z]{3,20}$/i.test(text) ? text : undefined;
    }
    function seriesColor(value, index, name) {
        return cssColor(value) ?? (name && OTHER_NAME.test(name) ? 'var(--vc-other)' : PALETTE[index % PALETTE.length]);
    }
    /** One hue from faint to the theme accent, for heatmaps: steps so neighbouring cells read apart. */
    function heatColor(t, steps = 10) {
        const q = Math.round(clamp(t, 0, 1) * (steps - 1)) / (steps - 1);
        return `color-mix(in oklab, var(--vc-accent) ${Math.round(8 + q * 92)}%, var(--vc-heat-low))`;
    }
    const SPECTRUM = ['var(--vc-cold)', 'var(--vc-teal)', 'var(--vc-green)', 'var(--vc-yellow)', 'var(--vc-orange)', 'var(--vc-red)'];
    /** Cold to hot across the theme's own hues, for treemaps and ranked bars (churn, errors, latency). */
    function spectrumColor(t) {
        const value = clamp(t, 0, 1) * (SPECTRUM.length - 1);
        const index = Math.min(SPECTRUM.length - 2, Math.floor(value));
        const f = Math.round((value - index) * 100);
        return f <= 0 ? SPECTRUM[index] : `color-mix(in oklab, ${SPECTRUM[index + 1]} ${f}%, ${SPECTRUM[index]})`;
    }
    /** Light or dark, read from the theme classes the workbench and webviews set. */
    function isLightTheme(element) {
        const workbench = element.closest('.monaco-workbench');
        if (workbench) {
            return workbench.classList.contains('vs') || workbench.classList.contains('hc-light');
        }
        const body = element.ownerDocument.body;
        if (body?.classList.contains('vscode-light') || body?.classList.contains('vscode-high-contrast-light')) {
            return true;
        }
        if (body?.classList.contains('vscode-dark') || body?.classList.contains('vscode-high-contrast')) {
            return false;
        }
        const scheme = element.ownerDocument.documentElement.style.colorScheme || win.getComputedStyle(element.ownerDocument.documentElement).colorScheme;
        if (scheme === 'light') {
            return true;
        }
        if (scheme === 'dark') {
            return false;
        }
        return !!win.matchMedia?.('(prefers-color-scheme: light)').matches;
    }
    /**
     * Critically-damped-ish springs for the hover cursor and tooltip: they settle in ~200ms with
     * no visible overshoot, and run only while something moves.
     */
    class Springs {
        constructor(apply, stiffness = 620, dampingRatio = 0.9) {
            this.apply = apply;
            this.stiffness = stiffness;
            this.dampingRatio = dampingRatio;
            this.items = new Map();
            this.frame = 0;
            this.last = 0;
        }
        set(key, target, jump = false) {
            const spring = this.items.get(key);
            if (!spring || jump || reducedMotion()) {
                this.items.set(key, { value: target, velocity: 0, target });
            }
            else {
                spring.target = target;
            }
            this.kick();
        }
        get(key) {
            return this.items.get(key)?.value ?? 0;
        }
        kick() {
            if (!this.frame) {
                this.last = win.performance.now();
                this.frame = win.requestAnimationFrame(now => this.tick(now));
            }
        }
        tick(now) {
            const dt = Math.min(0.034, Math.max(0.001, (now - this.last) / 1000));
            this.last = now;
            const damping = 2 * Math.sqrt(this.stiffness) * this.dampingRatio;
            let moving = false;
            for (const spring of this.items.values()) {
                for (let sub = 0; sub < 2; sub++) {
                    const h2 = dt / 2;
                    const force = -this.stiffness * (spring.value - spring.target) - damping * spring.velocity;
                    spring.velocity += force * h2;
                    spring.value += spring.velocity * h2;
                }
                if (Math.abs(spring.value - spring.target) < 0.05 && Math.abs(spring.velocity) < 0.5) {
                    spring.value = spring.target;
                    spring.velocity = 0;
                }
                else {
                    moving = true;
                }
            }
            this.apply();
            this.frame = moving ? win.requestAnimationFrame(next => this.tick(next)) : 0;
        }
        dispose() {
            if (this.frame) {
                win.cancelAnimationFrame(this.frame);
                this.frame = 0;
            }
        }
    }
    /** Calls `frame` with an eased 0..1 for `ms`, then 1. With reduced motion, only 1. */
    function tween(ms, frame, done) {
        if (ms <= 0 || reducedMotion()) {
            frame(1);
            done?.();
            return { cancel: () => { } };
        }
        let handle = 0;
        const start = win.performance.now();
        const step = (now) => {
            const t = Math.min(1, (now - start) / ms);
            frame(easeOut(t));
            if (t < 1) {
                handle = win.requestAnimationFrame(step);
            }
            else {
                handle = 0;
                done?.();
            }
        };
        handle = win.requestAnimationFrame(step);
        return { cancel: () => handle && win.cancelAnimationFrame(handle) };
    }
    //#endregion
    //#region Styles
    const CSS = `
.vc-root{
	--vc-fg:var(--foreground,var(--vscode-foreground,#cccccc));
	--vc-muted:var(--muted-foreground,var(--vscode-descriptionForeground,color-mix(in srgb,var(--vc-fg) 62%,transparent)));
	--vc-bg:var(--background,var(--volt-agent-window-bg-base,var(--vscode-editor-background,#1e1e1e)));
	--vc-surface:var(--popover,var(--vscode-editorHoverWidget-background,var(--vscode-editorWidget-background,var(--vc-bg))));
	--vc-hair:color-mix(in srgb,var(--vc-fg) 10%,transparent);
	--vc-grid:color-mix(in srgb,var(--vc-fg) 6%,transparent);
	--vc-zero:color-mix(in srgb,var(--vc-fg) 18%,transparent);
	--vc-focus:var(--ring,var(--vscode-focusBorder,var(--vc-accent)));
	--vc-mono:var(--font-mono,var(--volt-code-font,var(--vscode-editor-font-family,ui-monospace,Menlo,monospace)));
	--vc-accent:var(--chart-1,var(--vscode-textLink-foreground,var(--vscode-charts-blue,#3794ff)));
	--vc-blue:var(--vscode-terminal-ansiBrightBlue,var(--vscode-charts-blue,#3b8eea));
	--vc-green:var(--vscode-terminal-ansiGreen,var(--vscode-charts-green,#23d18b));
	--vc-orange:var(--vscode-charts-orange,#d18616);
	--vc-purple:var(--vscode-terminal-ansiMagenta,var(--vscode-charts-purple,#b180d7));
	--vc-yellow:var(--vscode-terminal-ansiYellow,var(--vscode-charts-yellow,#cca700));
	--vc-red:var(--vscode-terminal-ansiRed,var(--vscode-charts-red,#f14c4c));
	--vc-teal:var(--vscode-terminal-ansiCyan,#29b8db);
	--vc-pink:var(--vscode-terminal-ansiBrightMagenta,#d670d6);
	--vc-good:var(--success,var(--vscode-charts-green,#23d18b));
	--vc-bad:var(--destructive,var(--vscode-charts-red,#f14c4c));
	--vc-other:color-mix(in srgb,var(--vc-fg) 30%,var(--vc-bg));
	--vc-cold:color-mix(in oklab,var(--vc-blue) 55%,var(--vc-bg));
	--vc-heat-low:color-mix(in srgb,var(--vc-fg) 5%,var(--vc-bg));
	--vc-c1:var(--vc-accent);
	--vc-c2:var(--chart-2,var(--vc-orange));
	--vc-c3:var(--chart-3,var(--vc-green));
	--vc-c4:var(--chart-4,var(--vc-purple));
	--vc-c5:var(--chart-5,var(--vc-yellow));
	--vc-c6:var(--chart-6,var(--vc-teal));
	--vc-c7:var(--chart-7,var(--vc-pink));
	--vc-c8:var(--chart-8,var(--vc-red));
	--vc-seg-track:color-mix(in srgb,var(--vc-fg) 7%,transparent);
	--vc-seg-on:color-mix(in srgb,var(--vc-fg) 16%,var(--vc-bg));
	--vc-tip-bg:var(--vc-surface);
	--vc-tip-border:color-mix(in srgb,var(--vc-fg) 13%,transparent);
	--vc-shadow:0 10px 28px -8px rgba(0,0,0,.5),0 2px 8px -2px rgba(0,0,0,.3);
	position:relative;color:var(--vc-fg);font-size:13px;line-height:1.45;-webkit-font-smoothing:antialiased;min-width:0;
}
.vc-root.vc-light{--vc-seg-on:var(--vc-bg);--vc-seg-track:color-mix(in srgb,var(--vc-fg) 8%,transparent);--vc-shadow:0 10px 28px -8px rgba(0,0,0,.18),0 2px 8px -2px rgba(0,0,0,.1);--vc-grid:color-mix(in srgb,var(--vc-fg) 7%,transparent);}
.vc-root *{box-sizing:border-box}
.vc-root button{font:inherit}
.vc-visual-head{margin:0 0 18px}
.vc-visual-title{font-size:15px;line-height:21px;font-weight:600;letter-spacing:-.01em;margin:0}
.vc-visual-subtitle{color:var(--vc-muted);margin:2px 0 0}
.vc-blocks{display:flex;flex-direction:column;gap:34px}
.vc-block{min-width:0;position:relative}
.vc-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:28px 32px}
.vc-head{margin:0 0 12px}
.vc-title{font-size:14px;line-height:20px;font-weight:600;letter-spacing:-.005em;margin:0}
.vc-subtitle{color:var(--vc-muted);line-height:18px;margin:2px 0 0}
.vc-note{color:var(--vc-muted);font-size:12px;margin-top:10px}
.vc-top{display:flex;align-items:flex-end;justify-content:space-between;gap:12px 16px;flex-wrap:wrap;margin:0 0 14px}
.vc-top:empty{display:none}
.vc-metric{min-width:0}
.vc-metric-value{font-size:30px;line-height:34px;font-weight:600;letter-spacing:-.025em;font-variant-numeric:tabular-nums;white-space:nowrap}
.vc-metric-label{font-size:12px;color:var(--vc-muted);margin-top:3px}
.vc-delta{font-size:12px;color:var(--vc-muted);margin-top:5px;font-variant-numeric:tabular-nums}
.vc-delta b{font-weight:600;color:var(--vc-fg)}
.vc-delta.vc-good b{color:var(--vc-good)}
.vc-delta.vc-bad b{color:var(--vc-bad)}
.vc-controls{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.vc-seg{position:relative;display:inline-flex;padding:2px;border-radius:8px;background:var(--vc-seg-track);isolation:isolate}
.vc-seg-pill{position:absolute;top:2px;bottom:2px;left:0;width:0;border-radius:6px;background:var(--vc-seg-on);box-shadow:0 0 0 .5px var(--vc-hair),0 1px 2px rgba(0,0,0,.14);transition:transform 280ms ${EASE_OUT},width 280ms ${EASE_OUT};z-index:-1}
.vc-seg button{appearance:none;border:0;background:none;color:var(--vc-muted);font-size:12px;font-weight:500;line-height:18px;padding:2px 9px;border-radius:6px;cursor:pointer;font-variant-numeric:tabular-nums;white-space:nowrap;transition:color 160ms}
.vc-seg button:hover{color:var(--vc-fg)}
.vc-seg button[aria-pressed=true]{color:var(--vc-fg)}
.vc-seg button:focus-visible{outline:1px solid var(--vc-focus);outline-offset:-1px}
.vc-legend{display:flex;flex-wrap:wrap;gap:2px 14px;margin:0 0 10px}
.vc-legend-item{appearance:none;border:0;background:none;padding:2px 0;display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:18px;color:var(--vc-fg);cursor:pointer;border-radius:4px;transition:opacity 160ms}
.vc-legend-item.vc-off{opacity:.42}
.vc-legend-item.vc-off .vc-swatch{background:transparent!important;box-shadow:inset 0 0 0 1.5px currentColor}
.vc-legend-item:focus-visible{outline:1px solid var(--vc-focus);outline-offset:2px}
.vc-swatch{width:9px;height:9px;border-radius:2.5px;flex:none}
.vc-swatch.vc-dash{height:2px;width:12px;border-radius:1px;background:repeating-linear-gradient(90deg,currentColor 0 4px,transparent 4px 7px)!important}
.vc-plot{position:relative;width:100%;user-select:none;-webkit-user-select:none;outline:none;border-radius:6px;touch-action:pan-y}
.vc-plot:focus-visible{box-shadow:0 0 0 1px var(--vc-focus)}
.vc-svg{display:block;overflow:visible}
.vc-grid line{stroke:var(--vc-grid);shape-rendering:crispEdges}
.vc-grid line.vc-zero{stroke:var(--vc-zero)}
.vc-tick{transition:opacity ${TWEEN_MS}ms ease}
.vc-axis text,.vc-tick text{fill:var(--vc-muted);font-size:11px;font-variant-numeric:tabular-nums}
.vc-s{transition:opacity 180ms ease}
.vc-dim .vc-s:not(.vc-on){opacity:.18}
.vc-line{fill:none;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}
.vc-line.vc-dashed{stroke-dasharray:3 4;stroke-width:1.5}
.vc-line.vc-ref{stroke-dasharray:3 4;stroke-width:1.25;opacity:.75}
.vc-band{stroke:var(--vc-bg);stroke-width:1;stroke-linejoin:round}
.vc-dot{stroke:var(--vc-bg);stroke-width:1.5}
.vc-scatter{stroke:var(--vc-bg);stroke-width:1;fill-opacity:.78;transition:opacity 160ms}
.vc-anno line{stroke:color-mix(in srgb,var(--vc-fg) 55%,transparent);stroke-width:1;shape-rendering:crispEdges}
.vc-rule line{stroke:color-mix(in srgb,var(--vc-fg) 40%,transparent);stroke-dasharray:2 3;stroke-width:1}
.vc-anno text,.vc-rule text,.vc-callout text,.vc-mark text{font-size:11px;font-weight:600;fill:var(--vc-fg);paint-order:stroke;stroke:var(--vc-bg);stroke-width:3px;stroke-linejoin:round}
.vc-callout circle,.vc-mark circle{stroke:var(--vc-bg);stroke-width:1.5}
.vc-end text{font-size:12px;fill:var(--vc-muted);font-variant-numeric:tabular-nums}
.vc-end text tspan.vc-end-value{fill:var(--vc-fg);font-weight:500}
.vc-cursor{pointer-events:none;opacity:0;transition:opacity 140ms ease}
.vc-cursor.vc-shown{opacity:1}
.vc-crosshair{stroke:color-mix(in srgb,var(--vc-fg) 30%,transparent);stroke-width:1;shape-rendering:crispEdges}
.vc-band-hover{fill:color-mix(in srgb,var(--vc-fg) 6%,transparent)}
.vc-knob{stroke:var(--vc-bg);stroke-width:2}
.vc-knob-halo{opacity:.16}
.vc-hit{fill:transparent}
.vc-hit.vc-link{cursor:pointer}
.vc-tip{position:absolute;left:0;top:0;z-index:3;pointer-events:none;min-width:128px;max-width:min(280px,calc(100% - 8px));padding:8px 10px 9px;border-radius:10px;background:var(--vc-tip-bg);border:.5px solid var(--vc-tip-border);box-shadow:var(--vc-shadow);font-size:12px;line-height:17px;opacity:0;transition:opacity 120ms ease;will-change:transform,opacity}
.vc-tip.vc-shown{opacity:1}
.vc-tip-title{color:var(--vc-muted);font-size:11px;line-height:15px;margin:0 0 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vc-tip-hero{font-size:17px;line-height:22px;font-weight:600;letter-spacing:-.01em;font-variant-numeric:tabular-nums}
.vc-tip-sub{color:var(--vc-fg);margin:1px 0 0}
.vc-tip-row{display:flex;align-items:center;gap:7px;min-height:18px}
.vc-tip-name{flex:1;min-width:0;color:var(--vc-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vc-tip-value{font-variant-numeric:tabular-nums;font-weight:500;white-space:nowrap}
.vc-tip-row.vc-strong .vc-tip-name{color:var(--vc-fg)}
.vc-tip-row.vc-strong .vc-tip-value{font-weight:600}
.vc-tip-meta{margin-top:5px;padding-top:5px;border-top:.5px solid var(--vc-hair)}
.vc-tip-hint{margin-top:5px;color:var(--vc-muted);font-size:11px}
.vc-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.vc-empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:3px;pointer-events:none;padding:0 16px}
.vc-empty-title{font-size:13px;font-weight:500}
.vc-empty-message{font-size:12px;color:var(--vc-muted);max-width:300px}
.vc-loading .vc-skel{animation:vc-pulse 1.5s ease-in-out infinite}
.vc-skel-bar{background:color-mix(in srgb,var(--vc-fg) 8%,transparent);border-radius:6px}
@keyframes vc-pulse{0%,100%{opacity:.5}50%{opacity:1}}
.vc-fade-in{animation:vc-fade ${FADE_MS}ms ease both}
@keyframes vc-fade{from{opacity:0}to{opacity:1}}
.vc-stats{overflow:hidden;border-top:1px solid var(--vc-hair);border-bottom:1px solid var(--vc-hair)}
.vc-stats-inner{display:flex;flex-wrap:wrap;margin-left:-17px}
.vc-stat{flex:1 1 150px;min-width:0;padding:14px 16px 13px;border-left:1px solid var(--vc-hair);margin-bottom:-1px;border-bottom:1px solid var(--vc-hair)}
.vc-stat-value{font-size:26px;line-height:32px;font-weight:600;letter-spacing:-.025em;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vc-stat-label{color:var(--vc-muted);font-size:12.5px;line-height:17px;margin-top:2px}
.vc-stat-delta{font-size:11.5px;font-weight:500;margin-top:4px;color:var(--vc-muted);font-variant-numeric:tabular-nums}
.vc-stat-delta.vc-good{color:var(--vc-good)}
.vc-stat-delta.vc-bad{color:var(--vc-bad)}
.vc-stat-trend{display:block;margin-top:8px;overflow:visible}
.vc-heat-cell{transition:opacity 140ms}
.vc-heat-hover{fill:none;stroke:var(--vc-fg);stroke-width:1.5;pointer-events:none;transition:opacity 120ms}
.vc-heat-key{display:flex;align-items:center;gap:6px;color:var(--vc-muted);font-size:12px;margin-top:10px}
.vc-heat-key span.vc-heat-step{width:12px;height:12px;border-radius:2.5px}
.vc-tree-crumbs{display:flex;align-items:center;gap:4px;font-size:12px;color:var(--vc-muted);margin:0 0 8px;min-height:18px;font-family:var(--vc-mono)}
.vc-tree-crumbs button{appearance:none;border:0;background:none;padding:0;color:var(--vc-muted);cursor:pointer;font:inherit}
.vc-tree-crumbs button:hover{color:var(--vc-fg)}
.vc-tree-crumbs .vc-current{color:var(--vc-fg)}
.vc-tile{stroke:var(--vc-bg);stroke-width:1;transition:opacity 160ms}
.vc-tile-label{font-size:11px;fill:var(--vc-tile-ink,#fff);pointer-events:none;font-family:var(--vc-mono)}
.vc-group-label{font-size:11px;fill:var(--vc-fg);pointer-events:none;font-family:var(--vc-mono);font-weight:600}
.vc-group-sub{font-weight:400;fill:var(--vc-muted)}
.vc-tile-hover{fill:none;stroke:var(--vc-fg);stroke-width:1.5;pointer-events:none}
.vc-tree-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:10px;font-size:12px;color:var(--vc-muted)}
.vc-ramp{display:flex;align-items:center;gap:8px;font-variant-numeric:tabular-nums}
.vc-ramp i{display:block;width:120px;height:6px;border-radius:3px}
.vc-ranked{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(64px,1fr) auto;align-items:center;gap:0 14px}
.vc-ranked-row{display:contents;cursor:default}
.vc-ranked-row>*{padding:4px 0;transition:background-color 120ms}
.vc-ranked-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
.vc-ranked.vc-mono .vc-ranked-label{font-family:var(--vc-mono);font-size:12px}
.vc-ranked-label .vc-dir{color:var(--vc-muted)}
.vc-ranked-bar{height:100%;display:flex;align-items:center}
.vc-ranked-bar i{display:block;height:7px;border-radius:3.5px;transform-origin:left center;transition:transform 520ms ${EASE_OUT}}
.vc-ranked-value{text-align:right;font-variant-numeric:tabular-nums;font-size:12px;color:var(--vc-muted);white-space:nowrap}
.vc-ranked-row:hover .vc-ranked-label,.vc-ranked-row.vc-active .vc-ranked-label{color:var(--vc-fg)}
.vc-ranked-row.vc-link{cursor:pointer}
.vc-ranked-row.vc-link:hover .vc-ranked-label{text-decoration:underline;text-underline-offset:2px}
.vc-ranked-row:focus-visible .vc-ranked-label{outline:1px solid var(--vc-focus);outline-offset:1px;border-radius:2px}
.vc-more{appearance:none;border:0;background:none;color:var(--vc-muted);font-size:12px;padding:6px 0 0;cursor:pointer}
.vc-more:hover{color:var(--vc-fg)}
.vc-donut{display:flex;align-items:center;gap:20px 28px;flex-wrap:wrap}
.vc-donut svg{flex:none;overflow:visible}
.vc-arc{transition:transform 220ms ${EASE_OUT},opacity 160ms;cursor:default}
.vc-donut-list{flex:1;min-width:180px;display:flex;flex-direction:column;gap:3px}
.vc-donut-item{display:flex;align-items:center;gap:8px;font-size:13px;line-height:20px;padding:1px 6px;margin:0 -6px;border-radius:5px;cursor:default}
.vc-donut-item.vc-active{background:color-mix(in srgb,var(--vc-fg) 6%,transparent)}
.vc-donut-item .vc-tip-name{color:var(--vc-fg)}
.vc-donut-center-value{font-size:20px;font-weight:600;letter-spacing:-.02em;fill:var(--vc-fg);font-variant-numeric:tabular-nums}
.vc-donut-center-label{font-size:11px;fill:var(--vc-muted)}
@media (prefers-reduced-motion:reduce){.vc-root *,.vc-root *::before{transition:none!important;animation:none!important}}
`;
    function ensureStyles(target) {
        if (target.getElementById('vc-styles')) {
            return;
        }
        const style = target.createElement('style');
        style.id = 'vc-styles';
        style.textContent = CSS;
        (target.head ?? target.documentElement).appendChild(style);
    }
    function safeHref(value) {
        const text = typeof value === 'string' ? value.trim() : '';
        return /^(volt:|https?:\/\/|file:\/\/|\/)/i.test(text) && text.length < 2048 && !/[\s<>"]/.test(text) ? text : undefined;
    }
    function detailRows(value) {
        if (!isRecord(value)) {
            return undefined;
        }
        const rows = [];
        for (const [key, raw] of Object.entries(value)) {
            const text = isNum(raw) ? (Math.abs(raw) < 10_000 ? small(raw) : compact(raw)) : str(raw, 80);
            const label = str(key, 40);
            if (label && text !== undefined) {
                rows.push([label, text]);
            }
            if (rows.length >= 8) {
                break;
            }
        }
        return rows.length ? rows : undefined;
    }
    function blockHead(parent, title, subtitle) {
        const titleText = str(title, 160);
        const subtitleText = str(subtitle, 300);
        if (!titleText && !subtitleText) {
            return;
        }
        const head = h('div', 'vc-head', parent);
        if (titleText) {
            h('div', 'vc-title', head, titleText).setAttribute('role', 'heading');
        }
        if (subtitleText) {
            h('div', 'vc-subtitle', head, subtitleText);
        }
    }
    /**
     * A small popover beside the hovered point. It glides on a spring rather than tracking raw
     * pointer pixels, flips to the other side near an edge, and never leaves its chart.
     */
    class Tip {
        constructor(parent) {
            this.width = 0;
            this.height = 0;
            this.shown = false;
            this.side = 1;
            this.element = h('div', 'vc-tip', parent);
            this.element.setAttribute('aria-hidden', 'true');
            this.springs = new Springs(() => {
                this.element.style.transform = `translate3d(${Math.round(this.springs.get('x'))}px,${Math.round(this.springs.get('y'))}px,0)`;
            }, 700, 0.95);
        }
        set(model) {
            const el = this.element;
            el.replaceChildren();
            if (model.title) {
                h('div', 'vc-tip-title', el, model.title);
            }
            if (model.hero) {
                h('div', 'vc-tip-hero', el, model.hero);
            }
            if (model.sub) {
                h('div', 'vc-tip-sub', el, model.sub);
            }
            const rows = model.rows ?? [];
            if (rows.length) {
                const list = h('div', model.hero ? 'vc-tip-meta' : '', el);
                for (const row of rows) {
                    const line = h('div', `vc-tip-row${row.strong ? ' vc-strong' : ''}`, list);
                    if (row.color) {
                        const swatch = h('span', `vc-swatch${row.dashed ? ' vc-dash' : ''}`, line);
                        swatch.style.background = row.color;
                        swatch.style.color = row.color;
                    }
                    h('span', 'vc-tip-name', line, row.name);
                    h('span', 'vc-tip-value', line, row.value);
                }
            }
            const meta = model.meta ?? [];
            if (meta.length) {
                const list = h('div', 'vc-tip-meta', el);
                for (const [name, value] of meta) {
                    const line = h('div', 'vc-tip-row', list);
                    h('span', 'vc-tip-name', line, name);
                    h('span', 'vc-tip-value', line, value);
                }
            }
            if (model.hint) {
                h('div', 'vc-tip-hint', el, model.hint);
            }
            this.width = el.offsetWidth;
            this.height = el.offsetHeight;
        }
        /** Beside (x, y), inside a `width` x `height` box, between `top` and `bottom`. */
        place(x, y, width, top, bottom, gap = 14) {
            const fitsRight = x + gap + this.width <= width - 2;
            const fitsLeft = x - gap - this.width >= 2;
            if (this.side === 1 && !fitsRight && fitsLeft) {
                this.side = -1;
            }
            else if (this.side === -1 && !fitsLeft && fitsRight) {
                this.side = 1;
            }
            else if (!this.shown) {
                this.side = fitsRight || !fitsLeft ? 1 : -1;
            }
            const left = clamp(this.side === 1 ? x + gap : x - gap - this.width, 2, Math.max(2, width - this.width - 2));
            const topEdge = clamp(y - this.height / 2, top, Math.max(top, bottom - this.height));
            const jump = !this.shown;
            this.springs.set('x', left, jump);
            this.springs.set('y', topEdge, jump);
        }
        show() {
            if (!this.shown) {
                this.shown = true;
                this.element.classList.add('vc-shown');
            }
        }
        hide() {
            this.shown = false;
            this.element.classList.remove('vc-shown');
        }
        dispose() {
            this.springs.dispose();
        }
    }
    /** A segmented control with a pill that slides to the selected option. */
    function segmented(parent, label, options, selected, onSelect) {
        const element = h('div', 'vc-seg', parent);
        element.setAttribute('role', 'group');
        element.setAttribute('aria-label', label);
        const pill = h('span', 'vc-seg-pill', element);
        const buttons = new Map();
        let current = selected;
        let placed = false;
        const position = () => {
            const button = buttons.get(current);
            if (!button || !button.offsetWidth) {
                return;
            }
            if (!placed) {
                pill.style.transition = 'none';
            }
            pill.style.width = `${button.offsetWidth}px`;
            pill.style.transform = `translateX(${button.offsetLeft - 2}px)`;
            if (!placed) {
                void pill.offsetWidth;
                pill.style.transition = '';
                placed = true;
            }
        };
        const select = (id) => {
            current = id;
            for (const [key, button] of buttons) {
                button.setAttribute('aria-pressed', String(key === id));
            }
            position();
        };
        for (const option of options) {
            const button = h('button', '', element, option.label);
            button.type = 'button';
            button.addEventListener('click', () => {
                if (current !== option.id) {
                    select(option.id);
                    onSelect(option.id);
                }
            });
            button.addEventListener('keydown', event => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
                    return;
                }
                event.preventDefault();
                const index = options.findIndex(item => item.id === current);
                const next = options[clamp(index + (event.key === 'ArrowLeft' ? -1 : 1), 0, options.length - 1)];
                if (next && next.id !== current) {
                    select(next.id);
                    onSelect(next.id);
                    buttons.get(next.id)?.focus();
                }
            });
            buttons.set(option.id, button);
        }
        select(selected);
        win.requestAnimationFrame(position);
        return { element, select, refresh: position };
    }
    class Legend {
        constructor(parent, items, handlers) {
            this.handlers = handlers;
            this.buttons = new Map();
            this.element = h('div', 'vc-legend', parent);
            for (const item of items) {
                const button = h('button', 'vc-legend-item', this.element);
                button.type = 'button';
                const swatch = h('span', `vc-swatch${item.dashed ? ' vc-dash' : ''}`, button);
                swatch.style.background = item.color;
                swatch.style.color = item.color;
                h('span', '', button, item.name);
                button.setAttribute('aria-pressed', 'true');
                button.addEventListener('pointerenter', () => this.handlers.hover(item.key));
                button.addEventListener('pointerleave', () => this.handlers.hover(undefined));
                button.addEventListener('focus', () => this.handlers.hover(item.key));
                button.addEventListener('blur', () => this.handlers.hover(undefined));
                button.addEventListener('click', () => this.handlers.toggle(item.key));
                this.buttons.set(item.key, button);
            }
        }
        setHidden(hidden) {
            for (const [key, button] of this.buttons) {
                const off = hidden.has(key);
                button.classList.toggle('vc-off', off);
                button.setAttribute('aria-pressed', String(!off));
            }
        }
    }
    /** The big number above a chart, its label, and the change against the previous period. */
    class MetricHeader {
        constructor(parent) {
            this.element = h('div', 'vc-metric', parent);
            this.value = h('div', 'vc-metric-value', this.element);
            this.label = h('div', 'vc-metric-label', this.element);
            this.delta = h('div', 'vc-delta', this.element);
        }
        set(value, unit, label, delta, deltaLabel, good, animate) {
            this.counting?.cancel();
            const from = this.shownValue;
            this.shownValue = value;
            if (animate && isNum(from) && isNum(value) && from !== value) {
                this.counting = tween(TWEEN_MS, t => this.value.textContent = formatValue(lerp(from, value, t), unit, false));
            }
            else {
                this.value.textContent = formatValue(value, unit, false);
            }
            this.label.textContent = label ?? '';
            this.label.style.display = label ? '' : 'none';
            this.delta.replaceChildren();
            this.delta.className = 'vc-delta';
            if (delta) {
                h('b', '', this.delta, delta.text);
                this.delta.append(` ${deltaLabel}`);
                if (good && delta.direction !== 0) {
                    this.delta.classList.add((delta.direction > 0) === (good === 'up') ? 'vc-good' : 'vc-bad');
                }
            }
            this.delta.style.display = delta ? '' : 'none';
        }
        dispose() {
            this.counting?.cancel();
        }
    }
    const CARTESIAN_TYPES = ['line', 'area', 'bar', 'stacked-area', 'stacked-bar', 'share', 'grouped-bar', 'scatter'];
    const STEP_NAMES = ['minute', 'hour', 'day', 'week', 'month', 'year'];
    function additive(unit) {
        return unit.kind === 'usd' || unit.kind === 'tokens' || unit.kind === 'count';
    }
    function parseHeadline(value, unit) {
        if (!value) {
            return undefined;
        }
        const spec = isRecord(value) ? value : {};
        const aggregate = ['sum', 'avg', 'last', 'max', 'min'].find(item => item === spec.aggregate)
            ?? (additive(unit) ? 'sum' : unit.kind === 'number' || unit.kind === 'custom' ? 'last' : 'avg');
        return {
            value: isNum(spec.value) ? spec.value : undefined,
            label: str(spec.label, 80),
            aggregate,
            compare: spec.compare !== false,
            good: spec.good === 'up' || spec.good === 'down' ? spec.good : undefined,
        };
    }
    /** Reads a line/area/bar spec into series of numeric points, collecting what an agent should fix. */
    function parseCartesian(spec, problems, where) {
        const type = CARTESIAN_TYPES.includes(spec.type) ? spec.type : 'line';
        const xSpec = isRecord(spec.x) ? spec.x : {};
        const ySpec = isRecord(spec.y) ? spec.y : {};
        const zone = timeZoneOf(xSpec.timeZone);
        const categories = Array.isArray(spec.categories) ? spec.categories.map(item => str(item, 80) ?? '').slice(0, 2000) : [];
        const rawMetrics = Array.isArray(spec.metrics) && spec.metrics.length
            ? spec.metrics.filter(isRecord).slice(0, 12)
            : [{ label: str(ySpec.label, 60) ?? str(spec.title, 60) ?? '', unit: ySpec.unit ?? spec.unit, series: spec.series, headline: spec.headline }];
        if (!rawMetrics.some(metric => Array.isArray(metric.series) && metric.series.length)) {
            problems.push(`${where}: give "series": [{ "name": "...", "data": [...] }] (or "metrics").`);
        }
        // What kind of x axis: explicit, categories, date strings, epoch numbers, or plain numbers.
        let sawString = false;
        let allTimeStrings = true;
        let sawNumber = false;
        let allEpochs = true;
        for (const metric of rawMetrics) {
            for (const series of Array.isArray(metric.series) ? metric.series : []) {
                const data = isRecord(series) && Array.isArray(series.data) ? series.data : [];
                for (let index = 0; index < Math.min(data.length, 400); index++) {
                    const datum = data[index];
                    const x = Array.isArray(datum) ? datum[0] : isRecord(datum) ? datum.x : undefined;
                    if (typeof x === 'string') {
                        sawString = true;
                        allTimeStrings &&= looksLikeTime(x);
                    }
                    else if (isNum(x)) {
                        sawNumber = true;
                        allEpochs &&= Math.abs(x) >= 1e11;
                    }
                }
            }
        }
        const declared = xSpec.type === 'time' || xSpec.type === 'category' || xSpec.type === 'number' ? xSpec.type : undefined;
        const startTime = xSpec.start !== undefined ? parseTime(xSpec.start, zone) : undefined;
        const xKind = declared
            ?? (categories.length ? 'category'
                : sawString ? (allTimeStrings ? 'time' : 'category')
                    : sawNumber ? (allEpochs ? 'time' : 'number')
                        : startTime !== undefined && (typeof xSpec.start === 'string' || STEP_NAMES.includes(xSpec.step)) ? 'time'
                            : categories.length ? 'category' : 'number');
        const step = isNum(xSpec.step) && xSpec.step > 0 ? xSpec.step : STEP_NAMES.includes(xSpec.step) ? xSpec.step : (xKind === 'time' ? 'day' : 1);
        const numericStart = isNum(xSpec.start) ? xSpec.start : 0;
        const categoryIndex = new Map(categories.map((label, index) => [label, index]));
        const implicitX = (index) => {
            if (xKind === 'time') {
                return addStep(startTime ?? 0, step, index, zone);
            }
            if (xKind === 'number') {
                return numericStart + index * (isNum(step) ? step : 1);
            }
            return index;
        };
        const readX = (raw, index) => {
            if (raw === undefined || raw === null) {
                return implicitX(index);
            }
            if (xKind === 'time') {
                return parseTime(raw, zone);
            }
            if (xKind === 'number') {
                return isNum(raw) ? raw : typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw)) ? Number(raw) : undefined;
            }
            const label = str(raw, 80) ?? String(index);
            let at = categoryIndex.get(label);
            if (at === undefined) {
                at = categories.length;
                categories.push(label);
                categoryIndex.set(label, at);
            }
            return at;
        };
        if (xKind === 'time' && !sawString && !sawNumber && startTime === undefined) {
            problems.push(`${where}: time charts need x values or "x": { "start": "2026-07-06", "step": "day" }.`);
        }
        let seriesIndex = 0;
        const metrics = rawMetrics.map((metric, metricIndex) => {
            const rawSeries = (Array.isArray(metric.series) ? metric.series : []).filter(isRecord).slice(0, 24);
            const allValues = [];
            const hintWords = [metric.label, ySpec.label, spec.title, spec.subtitle, ...rawSeries.map(series => series.name)].filter(item => typeof item === 'string').join(' ');
            const parsed = rawSeries.map((series, index) => {
                const name = str(series.name, 80) ?? `Series ${index + 1}`;
                const data = Array.isArray(series.data) ? series.data.slice(0, MAX_POINTS) : [];
                if (!Array.isArray(series.data)) {
                    problems.push(`${where}: series "${name}" has no "data" array.`);
                }
                const points = [];
                let badX = 0;
                data.forEach((datum, at) => {
                    let rawX;
                    let rawY;
                    let extra;
                    if (Array.isArray(datum)) {
                        rawX = datum[0];
                        rawY = datum[1];
                    }
                    else if (isRecord(datum)) {
                        rawX = datum.x;
                        rawY = datum.y ?? datum.value;
                        extra = datum;
                    }
                    else {
                        rawY = datum;
                    }
                    const x = readX(rawX, at);
                    if (x === undefined) {
                        badX++;
                        return;
                    }
                    const y = isNum(rawY) ? rawY : typeof rawY === 'string' && rawY.trim() !== '' && Number.isFinite(Number(rawY)) ? Number(rawY) : Number.NaN;
                    if (Number.isFinite(y)) {
                        allValues.push(y);
                    }
                    points.push({
                        x, y,
                        label: extra ? str(extra.label, 120) : undefined,
                        href: extra ? safeHref(extra.href) : undefined,
                        detail: extra ? detailRows(extra.detail) : undefined,
                        size: extra && isNum(extra.size) ? extra.size : undefined,
                    });
                });
                if (badX) {
                    problems.push(`${where}: series "${name}" has ${badX} x value(s) that are not ${xKind === 'time' ? 'dates (ISO strings or epoch ms)' : 'numbers'}.`);
                }
                if (series.data && Array.isArray(series.data) && series.data.length > MAX_POINTS) {
                    problems.push(`${where}: series "${name}" has more than ${MAX_POINTS} points; only the first ${MAX_POINTS} are drawn.`);
                }
                if (xKind !== 'category') {
                    points.sort((a, b) => a.x - b.x);
                }
                const color = seriesColor(series.color, seriesIndex++, name);
                if (series.color !== undefined && !cssColor(series.color)) {
                    problems.push(`${where}: series "${name}" color ${JSON.stringify(series.color)} is not a palette name or CSS color.`);
                }
                return { series, name, points, color };
            });
            const unit = resolveUnit(metric.unit ?? ySpec.unit ?? spec.unit, hintWords, allValues);
            const result = parsed.map(({ series, name, points, color }, index) => ({
                key: `${metricIndex}:${index}:${name}`,
                name,
                color,
                dashed: series.dashed === true || series.reference === true,
                reference: series.reference === true,
                unit: series.unit !== undefined ? resolveUnit(series.unit) : unit,
                hidden: series.hidden === true,
                points,
            }));
            return {
                id: str(metric.id, 40) ?? String(metricIndex),
                label: str(metric.label, 60) ?? `Metric ${metricIndex + 1}`,
                unit: type === 'share' ? PERCENT_UNIT : unit,
                series: result,
                headline: parseHeadline(metric.headline ?? spec.headline, type === 'share' ? PERCENT_UNIT : unit),
            };
        });
        const allX = [];
        for (const metric of metrics) {
            for (const series of metric.series) {
                for (const point of series.points) {
                    allX.push(point.x);
                }
            }
        }
        allX.sort((a, b) => a - b);
        const span = allX.length ? allX[allX.length - 1] - allX[0] : 0;
        let ranges = [];
        if (spec.ranges && xKind === 'time') {
            const wanted = Array.isArray(spec.ranges) ? spec.ranges.map(item => String(item).toUpperCase()) : ['1D', '7D', '30D', '3M', '1Y'];
            ranges = wanted.filter(key => RANGE_LENGTHS[key] !== undefined && RANGE_LENGTHS[key] < span * 0.98);
            if (ranges.length) {
                ranges.push('ALL');
            }
        }
        else if (spec.ranges) {
            problems.push(`${where}: "ranges" needs a time x axis.`);
        }
        const wantedRange = typeof spec.range === 'string' ? spec.range.toUpperCase() : 'ALL';
        const readXValue = (value) => readX(value, 0);
        const annotations = (Array.isArray(spec.annotations) ? spec.annotations : []).filter(isRecord).slice(0, 12).flatMap(item => {
            const x = readXValue(item.x);
            return x === undefined ? [] : [{ x, label: str(item.label, 60) }];
        });
        const callouts = (Array.isArray(spec.callouts) ? spec.callouts : []).filter(isRecord).slice(0, 12).flatMap(item => {
            const x = readXValue(item.x);
            const label = str(item.label, 60);
            return x === undefined || !isNum(item.y) || !label ? [] : [{ x, y: item.y, label }];
        });
        const rules = (Array.isArray(spec.rules) ? spec.rules : []).filter(isRecord).slice(0, 8).flatMap(item => isNum(item.y) ? [{ y: item.y, label: str(item.label, 60) }] : []);
        return {
            type,
            xKind,
            zone,
            grain: xKind === 'time' ? grainOf(allX.filter((value, index) => index === 0 || value !== allX[index - 1])) : 'day',
            categories,
            xUnit: resolveUnit(xSpec.unit, str(xSpec.label)),
            xLabel: str(xSpec.label, 60),
            yLabel: str(ySpec.label, 60),
            metrics,
            yMin: isNum(ySpec.min) ? ySpec.min : undefined,
            yMax: isNum(ySpec.max) ? ySpec.max : undefined,
            yZero: typeof ySpec.zero === 'boolean' ? ySpec.zero : undefined,
            annotations,
            rules,
            callouts,
            ranges,
            range: ranges.includes(wantedRange) ? wantedRange : (ranges.length ? 'ALL' : 'ALL'),
            endLabels: typeof spec.endLabels === 'boolean' ? spec.endLabels : undefined,
            highlight: spec.highlight === 'max' || spec.highlight === 'min' || spec.highlight === 'last' ? spec.highlight : 'none',
            curve: spec.curve === 'linear' || spec.curve === 'step' ? spec.curve : 'smooth',
            legend: typeof spec.legend === 'boolean' ? spec.legend : undefined,
            points: typeof spec.points === 'boolean' ? spec.points : undefined,
            height: isNum(spec.height) ? clamp(Math.round(spec.height), 100, 720) : 240,
            title: str(spec.title, 160),
            subtitle: str(spec.subtitle, 300),
            note: str(spec.note, 300),
            emptyTitle: isRecord(spec.empty) ? str(spec.empty.title, 80) : undefined,
            emptyMessage: isRecord(spec.empty) ? str(spec.empty.message, 200) : undefined,
        };
    }
    function linearScale(d0, d1, r0, r1) {
        const span = d1 - d0 || 1;
        const scale = ((value) => r0 + ((value - d0) / span) * (r1 - r0));
        scale.inv = (px) => d0 + ((px - r0) / ((r1 - r0) || 1)) * span;
        return scale;
    }
    class CartesianChart {
        constructor(parent, spec, ctx, problems, where, tooltip) {
            this.ctx = ctx;
            this.tooltip = tooltip;
            this.metricIndex = 0;
            this.range = 'ALL';
            this.hidden = new Set();
            this.width = 0;
            this.nodes = new Map();
            this.ticks = new Map();
            this.drawn = false;
            this.loading = false;
            // Cursor state.
            this.cursorIndex = -1;
            this.cursorShown = false;
            this.pointerFrame = 0;
            this.knobs = new Map();
            this.element = h('div', 'vc-block vc-cartesian', parent);
            this.top = h('div', 'vc-top');
            this.legendHost = h('div', '');
            this.plot = h('div', 'vc-plot');
            this.plot.tabIndex = 0;
            this.plot.setAttribute('role', 'group');
            this.plot.setAttribute('aria-roledescription', 'interactive chart');
            this.svg = s('svg', { class: 'vc-svg' }, this.plot);
            this.defs = s('defs', {}, this.svg);
            this.gridLayer = s('g', { class: 'vc-grid' }, this.svg);
            this.xAxisLayer = s('g', { class: 'vc-axis' }, this.svg);
            this.marksBack = s('g', {}, this.svg);
            this.seriesLayer = s('g', { class: 'vc-series' }, this.svg);
            this.marksFront = s('g', {}, this.svg);
            this.cursorLayer = s('g', { class: 'vc-cursor' }, this.svg);
            this.bandHover = s('rect', { class: 'vc-band-hover', x: 0, y: 0, width: 0, height: 0, rx: 4 }, this.cursorLayer);
            this.crosshair = s('line', { class: 'vc-crosshair', x1: 0, x2: 0, y1: 0, y2: 0 }, this.cursorLayer);
            this.halo = s('circle', { class: 'vc-knob-halo', r: 9 }, this.cursorLayer);
            this.knob = s('circle', { class: 'vc-knob', r: 4.5 }, this.cursorLayer);
            this.hit = s('rect', { class: 'vc-hit' }, this.svg);
            this.tip = new Tip(this.plot);
            this.live = h('div', 'vc-sr', this.plot);
            this.live.setAttribute('aria-live', 'polite');
            this.noteEl = h('div', 'vc-note');
            this.springs = new Springs(() => this.applyCursor());
            this.wire();
            this.setSpec(spec, problems, where);
        }
        setSpec(spec, problems, where) {
            const previous = this.model;
            this.model = { ...parseCartesian(spec, problems, where), tooltip: this.tooltip };
            if (!previous || previous.metrics.length !== this.model.metrics.length) {
                this.metricIndex = 0;
            }
            else {
                this.metricIndex = Math.min(this.metricIndex, this.model.metrics.length - 1);
            }
            this.range = previous && this.model.ranges.includes(this.range) ? this.range : this.model.range;
            this.hidden = new Set(this.model.metrics.flatMap(metric => metric.series.filter(series => series.hidden).map(series => series.key)));
            this.buildChrome();
            if (this.width) {
                this.draw(previous ? 'tween' : 'enter');
            }
        }
        get metric() {
            return this.model.metrics[this.metricIndex] ?? this.model.metrics[0];
        }
        get stacked() {
            const type = this.model.type;
            return type === 'stacked-area' || type === 'stacked-bar' || type === 'share';
        }
        get bars() {
            const type = this.model.type;
            return type === 'bar' || type === 'stacked-bar' || type === 'grouped-bar';
        }
        /** Title, metric header, switchers and legend: rebuilt when the spec or metric changes. */
        buildChrome() {
            const model = this.model;
            this.element.replaceChildren();
            blockHead(this.element, model.title, model.subtitle);
            this.top.replaceChildren();
            this.element.appendChild(this.top);
            this.header?.dispose();
            this.header = undefined;
            if (this.metric.headline) {
                this.header = new MetricHeader(this.top);
            }
            const controls = h('div', 'vc-controls');
            if (model.metrics.length > 1) {
                this.metricControl = segmented(controls, 'Metric', model.metrics.map((metric, index) => ({ id: String(index), label: metric.label })), String(this.metricIndex), id => this.selectMetric(Number(id)));
            }
            else {
                this.metricControl = undefined;
            }
            if (model.ranges.length) {
                this.rangeControl = segmented(controls, 'Range', model.ranges.map(key => ({ id: key, label: key === 'ALL' ? this.ctx.strings.all : key })), this.range, id => this.selectRange(id));
            }
            else {
                this.rangeControl = undefined;
            }
            if (controls.childElementCount) {
                this.top.appendChild(controls);
            }
            this.element.appendChild(this.legendHost);
            this.buildLegend();
            this.element.appendChild(this.plot);
            this.noteEl.textContent = model.note ?? '';
            if (model.note) {
                this.element.appendChild(this.noteEl);
            }
            this.plot.setAttribute('aria-label', this.describe());
        }
        buildLegend() {
            this.legendHost.replaceChildren();
            this.legend = undefined;
            const series = this.metric.series;
            const show = this.model.legend ?? series.length > 1;
            if (!show || !series.length) {
                return;
            }
            this.legend = new Legend(this.legendHost, series.map(item => ({ key: item.key, name: item.name, color: item.color, dashed: item.dashed })), {
                hover: key => this.setFocus(key),
                toggle: key => this.toggle(key),
            });
            this.legend.setHidden(this.hidden);
        }
        describe() {
            const model = this.model;
            const metric = this.metric;
            const kind = model.type === 'share' ? 'share chart' : this.bars ? 'bar chart' : model.type === 'scatter' ? 'scatter chart' : model.type.includes('area') ? 'area chart' : 'line chart';
            const names = metric.series.map(series => series.name).join(', ');
            return `${model.title ?? metric.label ?? this.ctx.strings.chart}. ${kind}${names ? `: ${names}` : ''}. Use arrow keys to read values.`;
        }
        selectMetric(index) {
            if (index === this.metricIndex) {
                return;
            }
            const before = this.metric.series.map(series => series.name).join('\u0000');
            this.metricIndex = index;
            const sameSeries = before === this.metric.series.map(series => series.name).join('\u0000');
            if (!sameSeries) {
                this.buildLegend();
            }
            if (this.metric.headline && !this.header) {
                this.buildChrome();
            }
            this.draw('tween');
        }
        selectRange(range) {
            this.range = range;
            this.draw('tween');
        }
        setFocus(key) {
            this.focusKey = key && !this.hidden.has(key) ? key : undefined;
            this.svg.classList.toggle('vc-dim', !!this.focusKey);
            for (const [nodeKey, node] of this.nodes) {
                node.group.classList.toggle('vc-on', nodeKey === this.focusKey);
            }
            if (this.cursorShown && this.focusKey) {
                this.primaryKey = this.focusKey;
                this.moveCursor(this.cursorIndex, false);
            }
        }
        toggle(key) {
            const visible = this.metric.series.filter(series => !series.reference && !this.hidden.has(series.key));
            if (!this.hidden.has(key) && visible.length <= 1 && visible[0]?.key === key) {
                return;
            }
            if (this.hidden.has(key)) {
                this.hidden.delete(key);
            }
            else {
                this.hidden.add(key);
            }
            this.legend?.setHidden(this.hidden);
            if (this.focusKey === key) {
                this.setFocus(undefined);
            }
            this.draw('tween');
        }
        layout(width) {
            if (width === this.width && this.drawn) {
                return;
            }
            const first = !this.width;
            this.width = width;
            this.metricControl?.refresh();
            this.rangeControl?.refresh();
            this.draw(first ? 'enter' : 'none');
        }
        setLoading(loading) {
            this.loading = loading;
            this.element.classList.toggle('vc-loading', loading);
            if (this.width) {
                this.draw('none');
            }
        }
        //#region Frames
        rangeBounds() {
            if (this.range === 'ALL' || this.model.xKind !== 'time') {
                return undefined;
            }
            const length = RANGE_LENGTHS[this.range];
            let max = -Infinity;
            for (const series of this.metric.series) {
                const last = series.points[series.points.length - 1];
                if (last && last.x > max) {
                    max = last.x;
                }
            }
            return Number.isFinite(max) ? { lo: max - length + 1, hi: max, length } : undefined;
        }
        /** The data to draw: in range, stacked or normalized, with the y scale it needs. */
        buildFrame(plotHeight) {
            const model = this.model;
            const metric = this.metric;
            const bounds = this.rangeBounds();
            const inRange = (x) => !bounds || (x >= bounds.lo && x <= bounds.hi);
            const stacked = this.stacked;
            const list = metric.series;
            let frames;
            if (stacked || this.bars) {
                const xsSet = new Set();
                for (const series of list) {
                    for (const point of series.points) {
                        if (inRange(point.x)) {
                            xsSet.add(point.x);
                        }
                    }
                }
                const xs = [...xsSet].sort((a, b) => a - b);
                const index = new Map(xs.map((x, at) => [x, at]));
                const base = xs.map(() => 0);
                const negBase = xs.map(() => 0);
                const totals = xs.map(() => 0);
                const values = list.map(series => {
                    const row = xs.map(() => Number.NaN);
                    const points = xs.map(() => undefined);
                    for (const point of series.points) {
                        const at = index.get(point.x);
                        if (at !== undefined) {
                            row[at] = Number.isFinite(row[at]) ? row[at] + (Number.isFinite(point.y) ? point.y : 0) : point.y;
                            points[at] = point;
                        }
                    }
                    return { row, points };
                });
                if (model.type === 'share') {
                    list.forEach((series, at) => {
                        if (!this.hidden.has(series.key) && !series.reference) {
                            values[at].row.forEach((value, k) => totals[k] += Number.isFinite(value) ? Math.max(0, value) : 0);
                        }
                    });
                }
                frames = list.map((series, at) => {
                    const visible = !this.hidden.has(series.key);
                    const { row, points } = values[at];
                    if (!stacked || series.reference) {
                        return { source: series, visible, xs, top: row, bot: xs.map(() => 0), raw: row, points };
                    }
                    const top = [];
                    const bot = [];
                    const raw = [];
                    row.forEach((value, k) => {
                        let v = Number.isFinite(value) ? value : 0;
                        if (model.type === 'share') {
                            v = totals[k] > 0 ? (Math.max(0, v) / totals[k]) * 100 : 0;
                        }
                        if (!visible) {
                            v = 0;
                        }
                        const from = v >= 0 ? base[k] : negBase[k];
                        bot.push(from);
                        top.push(from + v);
                        raw.push(model.type === 'share' ? v : value);
                        if (v >= 0) {
                            base[k] += v;
                        }
                        else {
                            negBase[k] += v;
                        }
                    });
                    return { source: series, visible, xs, top, bot, raw, points };
                });
            }
            else {
                frames = list.map(series => {
                    const points = series.points.filter(point => inRange(point.x));
                    const xs = points.map(point => point.x);
                    const ys = points.map(point => point.y);
                    return { source: series, visible: !this.hidden.has(series.key), xs, top: ys, bot: xs.map(() => 0), raw: ys, points };
                });
            }
            // The y scale: visible series, rules and callouts; zero when the chart type needs it.
            let min = Infinity;
            let max = -Infinity;
            const domainSet = new Set();
            for (const frame of frames) {
                if (!frame.visible) {
                    continue;
                }
                frame.xs.forEach((x, at) => {
                    const top = frame.top[at];
                    const bot = frame.bot[at];
                    if (Number.isFinite(top)) {
                        domainSet.add(x);
                        min = Math.min(min, top, stacked ? bot : top);
                        max = Math.max(max, top, stacked ? bot : top);
                    }
                });
            }
            const empty = !Number.isFinite(min);
            for (const rule of model.rules) {
                min = Math.min(min, rule.y);
                max = Math.max(max, rule.y);
            }
            for (const callout of model.callouts) {
                min = Math.min(min, callout.y);
                max = Math.max(max, callout.y);
            }
            if (!Number.isFinite(min)) {
                min = 0;
                max = 1;
            }
            const zero = model.yZero ?? (this.bars || stacked || model.type === 'area' || model.type === 'stacked-area' || (min >= 0 && (max - min) > 0.45 * max) || (max <= 0 && (max - min) > 0.45 * -min));
            if (zero) {
                min = Math.min(min, 0);
                max = Math.max(max, 0);
            }
            const count = clamp(Math.round(plotHeight / 52), 2, 6);
            const integer = metric.unit.kind === 'count' || metric.unit.kind === 'tokens';
            const share = model.type === 'share';
            const ticks = share
                ? niceScale(0, 100, count >= 4 ? 4 : 2, false, 0, 100)
                : niceScale(model.yMin ?? min, model.yMax ?? max, count, integer, model.yMin, model.yMax);
            const domain = [...domainSet].sort((a, b) => a - b);
            const allXs = frames.flatMap(frame => frame.xs);
            let x0 = Infinity;
            let x1 = -Infinity;
            for (const x of allXs) {
                x0 = Math.min(x0, x);
                x1 = Math.max(x1, x);
            }
            if (model.xKind === 'category') {
                x0 = 0;
                x1 = Math.max(0, model.categories.length - 1);
            }
            if (bounds) {
                x0 = Math.min(x0, bounds.lo);
            }
            if (!Number.isFinite(x0)) {
                x0 = 0;
                x1 = 1;
            }
            return { series: frames, domain, lo: ticks.lo, hi: ticks.hi, x0, x1, unit: metric.unit, empty, ticks };
        }
        /** Same series and the same x positions: the old frame can morph into the new one. */
        compatible(a, b) {
            if (!a || a.series.length !== b.series.length || a.empty || b.empty) {
                return false;
            }
            return a.series.every((series, index) => {
                const other = b.series[index];
                return series.source.key.split(':').slice(1).join(':') === other.source.key.split(':').slice(1).join(':')
                    && series.xs.length === other.xs.length
                    && series.xs.every((x, at) => x === other.xs[at]);
            }) && a.x0 === b.x0 && a.x1 === b.x1;
        }
        interpolate(a, b, t) {
            const mix = (from, to) => to.map((value, index) => {
                const start = from[index];
                return Number.isFinite(value) && Number.isFinite(start) ? lerp(start, value, t) : value;
            });
            return {
                ...b,
                series: b.series.map((series, index) => ({ ...series, top: mix(a.series[index].top, series.top), bot: mix(a.series[index].bot, series.bot) })),
                lo: lerp(a.lo, b.lo, t),
                hi: lerp(a.hi, b.hi, t),
            };
        }
        /** Everything at the baseline: what bars and stacks grow from on first draw. */
        flatten(frame) {
            const base = frame.lo <= 0 && frame.hi >= 0 ? 0 : frame.lo;
            return { ...frame, series: frame.series.map(series => ({ ...series, top: series.top.map(value => Number.isFinite(value) ? base : value), bot: series.bot.map(value => Number.isFinite(value) ? base : value) })) };
        }
        //#endregion
        //#region Drawing
        draw(mode) {
            if (!this.width) {
                return;
            }
            this.animation?.cancel();
            this.animation = undefined;
            const model = this.model;
            const narrow = this.width < 420;
            const height = narrow ? Math.max(150, Math.round(model.height * 0.82)) : model.height;
            this.plot.style.height = `${height}px`;
            setAttrs(this.svg, { width: this.width, height, viewBox: `0 0 ${this.width} ${height}` });
            this.renderEmpty(false);
            if (this.loading) {
                this.renderSkeleton(height);
                return;
            }
            const top = model.annotations.length ? 24 : 10;
            const bottom = 24;
            const frame = this.buildFrame(height - top - bottom);
            const box = this.computeBox(frame, height, top, bottom);
            this.box = box;
            const sx = this.xScale(frame, box);
            this.sx = sx;
            this.drawXAxis(frame, box, sx);
            this.setHeadline(mode !== 'none' && this.drawn);
            this.hit.setAttribute('class', 'vc-hit');
            setAttrs(this.hit, { x: box.left - 6, y: 0, width: Math.max(0, box.right - box.left + 12), height });
            const previous = this.shown;
            const morph = mode === 'tween' && this.compatible(previous, frame);
            const fade = mode === 'tween' && !morph && this.drawn;
            if (fade) {
                this.ghost();
            }
            const rebuild = !morph;
            if (rebuild) {
                this.buildSeriesNodes(frame);
            }
            this.planDownsampling(frame, box, sx);
            this.hideCursor();
            const finish = () => {
                this.shown = frame;
                this.renderStatic(frame, box, sx);
            };
            if (frame.empty) {
                this.renderFrame(frame, box, sx, frame.ticks, false);
                this.shown = frame;
                this.marksBack.replaceChildren();
                this.marksFront.replaceChildren();
                this.renderEmpty(true);
                this.drawn = true;
                return;
            }
            const enterGrow = mode === 'enter' && this.ctx.animate && (this.bars || this.stacked);
            const enterDraw = mode === 'enter' && this.ctx.animate && !enterGrow;
            this.marksBack.replaceChildren();
            this.marksFront.replaceChildren();
            if (morph || enterGrow) {
                const from = morph ? previous : this.flatten(frame);
                this.renderFrame(from, box, sx, frame.ticks, true);
                this.animation = tween(TWEEN_MS + (enterGrow ? 80 : 0), t => {
                    this.renderFrame(this.interpolate(from, frame, t), box, sx, frame.ticks, false);
                }, finish);
            }
            else {
                this.renderFrame(frame, box, sx, frame.ticks, false);
                if (enterDraw && !reducedMotion()) {
                    this.playDraw();
                }
                if (fade) {
                    this.seriesLayer.classList.remove('vc-fade-in');
                    void this.seriesLayer.getBoundingClientRect();
                    this.seriesLayer.classList.add('vc-fade-in');
                }
                finish();
            }
            this.drawn = true;
        }
        computeBox(frame, height, top, bottom) {
            const width = this.width;
            const compactAxis = width < 400;
            const font = `400 11px ${win.getComputedStyle(this.element).fontFamily || 'system-ui'}`;
            let labelWidth = 0;
            for (const value of frame.ticks.values) {
                labelWidth = Math.max(labelWidth, textWidth(formatTick(value, frame.ticks.step, frame.unit), font));
            }
            const left = compactAxis ? 0 : Math.ceil(labelWidth) + 10;
            let right = this.bars ? 2 : 6;
            const endLabels = this.endLabelsWanted();
            if (endLabels) {
                right = Math.ceil(Math.min(width * 0.3, this.endLabelWidth(frame) + 14));
            }
            return { width, height, left, right: Math.max(left + 20, width - right), top, bottom: height - bottom };
        }
        endLabelsWanted() {
            const visible = this.metric.series.filter(series => !this.hidden.has(series.key));
            if (this.width < 560 || visible.length < 2 || visible.length > 8 || this.model.type === 'scatter' || this.bars) {
                return false;
            }
            return this.model.endLabels ?? (this.model.type === 'share' || this.model.type === 'stacked-area');
        }
        endLabelWidth(frame) {
            const font = `500 12px ${win.getComputedStyle(this.element).fontFamily || 'system-ui'}`;
            let max = 0;
            for (const series of frame.series) {
                if (series.visible) {
                    max = Math.max(max, textWidth(`${series.source.name} ${this.endValue(series)}`, font));
                }
            }
            return max;
        }
        endValue(series) {
            for (let index = series.raw.length - 1; index >= 0; index--) {
                if (Number.isFinite(series.raw[index])) {
                    const value = series.raw[index];
                    return this.model.type === 'share' ? `${Math.round(value)}%` : formatValue(value, series.source.unit);
                }
            }
            return '';
        }
        xScale(frame, box) {
            let x0 = frame.x0;
            let x1 = frame.x1;
            if (this.bars || this.model.xKind === 'category' && this.bars) {
                const gap = this.typicalGap(frame);
                x0 -= gap / 2;
                x1 += gap / 2;
            }
            else if (x0 === x1) {
                x0 -= 1;
                x1 += 1;
            }
            return linearScale(x0, x1, box.left, box.right);
        }
        typicalGap(frame) {
            if (this.model.xKind === 'category') {
                return 1;
            }
            const xs = frame.domain.length > 1 ? frame.domain : frame.series[0]?.xs ?? [];
            let gap = Infinity;
            for (let index = 1; index < xs.length; index++) {
                const step = xs[index] - xs[index - 1];
                if (step > 0) {
                    gap = Math.min(gap, step);
                }
            }
            if (Number.isFinite(gap)) {
                return gap;
            }
            return this.model.xKind === 'time' ? ({ minute: MINUTE, hour: HOUR, day: DAY, week: 7 * DAY, month: 30 * DAY, year: 365 * DAY })[this.model.grain] : 1;
        }
        drawXAxis(frame, box, sx) {
            this.xAxisLayer.replaceChildren();
            const model = this.model;
            const font = `400 11px ${win.getComputedStyle(this.element).fontFamily || 'system-ui'}`;
            let ticks = [];
            const plotWidth = box.right - box.left;
            const lo = sx.inv(box.left);
            const hi = sx.inv(box.right);
            if (model.xKind === 'time') {
                ticks = timeTicks(Math.max(lo, frame.x0 - (this.bars ? this.typicalGap(frame) / 2 : 0)), Math.min(hi, frame.x1 + (this.bars ? this.typicalGap(frame) / 2 : 0)), Math.max(2, Math.floor(plotWidth / 76)), model.zone);
            }
            else if (model.xKind === 'category') {
                const labels = model.categories;
                let widest = 0;
                for (const label of labels) {
                    widest = Math.max(widest, textWidth(label, font));
                }
                const every = Math.max(1, Math.ceil(labels.length / Math.max(1, Math.floor(plotWidth / (widest + 14)))));
                for (let index = 0; index < labels.length; index += every) {
                    ticks.push({ value: index, label: labels[index] });
                }
            }
            else {
                const scale = niceScale(frame.x0, frame.x1, Math.max(2, Math.floor(plotWidth / 90)), false);
                ticks = scale.values.filter(value => value >= frame.x0 && value <= frame.x1).map(value => ({ value, label: formatTick(value, scale.step, model.xUnit) }));
            }
            let lastEnd = -Infinity;
            const y = box.bottom + 16;
            for (const tick of ticks) {
                const x = sx(tick.value);
                if (x < box.left - 1 || x > box.right + 1) {
                    continue;
                }
                const width = textWidth(tick.label, font);
                let anchor = 'middle';
                let start = x - width / 2;
                if (start < 0) {
                    anchor = 'start';
                    start = Math.max(0, box.left - 2);
                }
                else if (x + width / 2 > box.width) {
                    anchor = 'end';
                    start = box.width - width;
                }
                if (start < lastEnd + 12) {
                    continue;
                }
                lastEnd = start + width;
                const text = s('text', { x: anchor === 'start' ? start : anchor === 'end' ? box.width : x, y, 'text-anchor': anchor }, this.xAxisLayer);
                text.textContent = tick.label;
            }
        }
        buildSeriesNodes(frame) {
            this.seriesLayer.replaceChildren();
            this.defs.replaceChildren();
            this.nodes.clear();
            this.knobs.forEach(knob => knob.remove());
            this.knobs.clear();
            const type = this.model.type;
            const visibleCount = frame.series.filter(series => series.visible && !series.source.reference).length;
            frame.series.forEach((series, index) => {
                const source = series.source;
                const group = s('g', { class: 'vc-s' }, this.seriesLayer);
                group.classList.toggle('vc-on', source.key === this.focusKey);
                group.style.opacity = series.visible ? '' : '0';
                const nodes = { group };
                if (this.bars && !source.reference) {
                    nodes.bars = s('path', { class: 'vc-bar' }, group);
                    nodes.bars.style.fill = source.color;
                }
                else if (type === 'scatter') {
                    nodes.dots = s('g', {}, group);
                }
                else {
                    if (this.stacked && !source.reference) {
                        nodes.area = s('path', { class: 'vc-band' }, group);
                        nodes.area.style.fill = source.color;
                        nodes.area.style.fillOpacity = '0.9';
                    }
                    else if ((type === 'area' || (type === 'line' && visibleCount === 1)) && !source.reference) {
                        const id = nextId('fill');
                        const gradient = s('linearGradient', { id, x1: 0, x2: 0, y1: 0, y2: 1 }, this.defs);
                        const strength = type === 'area' ? (index === 0 ? 0.26 : 0.14) : 0.16;
                        const a = s('stop', { offset: '0%' }, gradient);
                        a.style.stopColor = source.color;
                        a.style.stopOpacity = String(strength);
                        const b = s('stop', { offset: '100%' }, gradient);
                        b.style.stopColor = source.color;
                        b.style.stopOpacity = '0';
                        nodes.area = s('path', { class: 'vc-area', fill: `url(#${id})` }, group);
                        nodes.gradient = id;
                    }
                    if (!this.stacked || source.reference) {
                        nodes.line = s('path', { class: `vc-line${source.reference ? ' vc-ref' : source.dashed ? ' vc-dashed' : ''}` }, group);
                        nodes.line.style.stroke = source.color;
                    }
                    nodes.dots = s('g', {}, group);
                }
                this.nodes.set(source.key, nodes);
                if (type !== 'scatter' && !this.bars) {
                    const knob = s('circle', { class: 'vc-knob', r: 3.25 }, this.cursorLayer);
                    knob.style.fill = source.color;
                    this.knobs.set(source.key, knob);
                }
            });
            // The primary knob draws over the others.
            this.cursorLayer.appendChild(this.halo);
            this.cursorLayer.appendChild(this.knob);
        }
        /** Which points each series draws: all of them, or M4-picked ones when they outnumber the pixels. */
        planDownsampling(frame, box, sx) {
            const columns = Math.max(1, box.right - box.left);
            frame.series.forEach(series => {
                const nodes = this.nodes.get(series.source.key);
                if (!nodes) {
                    return;
                }
                nodes.keep = series.xs.length > columns * 2 && !this.bars ? m4(series.xs.map(x => sx(x)), series.top) : undefined;
            });
        }
        /** Geometry for one frame (a tween calls this every animation frame). */
        renderFrame(frame, box, sx, ticks, enteringTicks) {
            const sy = linearScale(frame.lo, frame.hi, box.bottom, box.top);
            this.sy = sy;
            this.renderTicks(ticks, sy, box, enteringTicks);
            const type = this.model.type;
            const curve = this.model.curve;
            const baseline = sy(frame.lo <= 0 && frame.hi >= 0 ? 0 : frame.lo);
            const visibleBars = frame.series.filter(series => series.visible && !series.source.reference);
            const gap = this.typicalGap(frame);
            const slot = Math.abs(sx(gap) - sx(0));
            const groupWidth = Math.min(slot * (type === 'grouped-bar' ? 0.8 : 0.72), type === 'grouped-bar' ? 96 : 56);
            const barWidth = type === 'grouped-bar' ? groupWidth / Math.max(1, visibleBars.length) : groupWidth;
            const radius = Math.min(3, barWidth / 3);
            for (const series of frame.series) {
                const nodes = this.nodes.get(series.source.key);
                if (!nodes) {
                    continue;
                }
                nodes.group.style.opacity = series.visible ? '' : '0';
                const indices = nodes.keep;
                const pick = (values) => indices ? indices.map(index => values[index]) : values.slice();
                const xs = pick(series.xs);
                const tops = pick(series.top);
                const bots = pick(series.bot);
                const topPts = xs.map((x, index) => [sx(x), Number.isFinite(tops[index]) ? sy(tops[index]) : Number.NaN]);
                const effectiveCurve = indices || xs.length > (box.right - box.left) / 2 ? 'linear' : curve;
                if (nodes.bars) {
                    const order = visibleBars.indexOf(series);
                    let d = '';
                    xs.forEach((x, index) => {
                        const value = tops[index];
                        if (!Number.isFinite(value)) {
                            return;
                        }
                        const center = sx(x);
                        const left = type === 'grouped-bar' ? center - groupWidth / 2 + Math.max(0, order) * barWidth + 0.5 : center - barWidth / 2;
                        const y0 = this.stacked ? sy(bots[index]) : baseline;
                        d += barPath(left, y0, sy(value), type === 'grouped-bar' ? barWidth - 1 : barWidth, this.stacked && !this.isTopOfStack(frame, series, index) ? 0 : radius);
                    });
                    nodes.bars.setAttribute('d', d);
                }
                if (nodes.area) {
                    const botPts = this.stacked
                        ? xs.map((x, index) => [sx(x), Number.isFinite(bots[index]) ? sy(bots[index]) : Number.NaN])
                        : xs.map((x, index) => [sx(x), Number.isFinite(tops[index]) ? baseline : Number.NaN]);
                    nodes.area.setAttribute('d', areaPath(topPts, botPts, effectiveCurve));
                }
                if (nodes.line) {
                    nodes.line.setAttribute('d', runs(topPts).map(run => curvePath(run, effectiveCurve, true)).join(''));
                }
                if (nodes.dots) {
                    this.renderDots(nodes.dots, series, topPts, box, type === 'scatter');
                }
            }
        }
        isTopOfStack(frame, series, index) {
            const position = frame.series.indexOf(series);
            for (let next = position + 1; next < frame.series.length; next++) {
                const other = frame.series[next];
                if (other.visible && !other.source.reference && Math.abs(other.top[index] - other.bot[index]) > 1e-9) {
                    return false;
                }
            }
            return true;
        }
        renderDots(layer, series, points, box, scatter) {
            const show = scatter || this.model.points === true || (this.model.points !== false && points.length > 0 && (points.length <= Math.max(1, Math.min(14, (box.right - box.left) / 30)) || points.filter(point => Number.isFinite(point[1])).length === 1));
            if (!show) {
                if (layer.firstChild) {
                    layer.replaceChildren();
                }
                return;
            }
            let sizeMax = 0;
            if (scatter) {
                for (const point of series.points) {
                    sizeMax = Math.max(sizeMax, point?.size ?? 0);
                }
            }
            const circles = layer.children;
            let used = 0;
            points.forEach((point, index) => {
                if (!Number.isFinite(point[1])) {
                    return;
                }
                let circle = circles[used];
                if (!circle) {
                    circle = s('circle', { class: scatter ? 'vc-scatter' : 'vc-dot' }, layer);
                    circle.style.fill = series.source.color;
                }
                const size = scatter ? series.points[index]?.size : undefined;
                const r = scatter ? (sizeMax > 0 && isNum(size) ? 2.5 + 9 * Math.sqrt(Math.max(0, size) / sizeMax) : 3.5) : 2.75;
                setAttrs(circle, { cx: point[0], cy: point[1], r });
                used++;
            });
            while (circles.length > used) {
                circles[circles.length - 1].remove();
            }
        }
        /** Y gridlines and labels, keyed by value so a rescale slides them instead of redrawing. */
        renderTicks(ticks, sy, box, entering) {
            const compactAxis = this.width < 400;
            const unit = this.metric.unit;
            const keep = new Set(ticks.values);
            for (const [value, group] of this.ticks) {
                if (!keep.has(value)) {
                    if (!group.dataset.leaving) {
                        group.dataset.leaving = '1';
                        group.style.opacity = '0';
                        win.setTimeout(() => {
                            if (group.dataset.leaving) {
                                group.remove();
                                if (this.ticks.get(value) === group) {
                                    this.ticks.delete(value);
                                }
                            }
                        }, TWEEN_MS);
                    }
                    const y = sy(value);
                    group.setAttribute('transform', `translate(0,${num(crisp(y))})`);
                }
            }
            for (const value of ticks.values) {
                let group = this.ticks.get(value);
                const y = crisp(sy(value));
                const label = formatTick(value, ticks.step, unit);
                if (!group) {
                    group = s('g', { class: 'vc-tick' }, this.gridLayer);
                    s('line', {}, group);
                    s('text', {}, group);
                    this.ticks.set(value, group);
                    if (entering || (this.drawn && this.animation)) {
                        group.style.opacity = '0';
                        void group.getBoundingClientRect();
                        group.style.opacity = '';
                    }
                }
                delete group.dataset.leaving;
                group.style.opacity = '';
                group.setAttribute('transform', `translate(0,${num(y)})`);
                const line = group.firstChild;
                setAttrs(line, { x1: box.left, x2: box.right, y1: 0, y2: 0 });
                line.classList.toggle('vc-zero', value === 0);
                const text = group.lastChild;
                if (text.textContent !== label) {
                    text.textContent = label;
                }
                if (compactAxis) {
                    setAttrs(text, { x: box.left, y: -5, 'text-anchor': 'start', 'dominant-baseline': 'auto' });
                }
                else {
                    setAttrs(text, { x: box.left - 9, y: 0, 'text-anchor': 'end', 'dominant-baseline': 'central' });
                }
            }
        }
        playDraw() {
            for (const nodes of this.nodes.values()) {
                const line = nodes.line;
                if (line && !line.classList.contains('vc-dashed') && !line.classList.contains('vc-ref')) {
                    line.setAttribute('pathLength', '1');
                    line.style.strokeDasharray = '1 1';
                    line.style.strokeDashoffset = '1';
                    line.style.transition = 'none';
                    void line.getBoundingClientRect();
                    line.style.transition = `stroke-dashoffset ${DRAW_MS}ms ${EASE_OUT}`;
                    line.style.strokeDashoffset = '0';
                    win.setTimeout(() => {
                        line.removeAttribute('pathLength');
                        line.style.strokeDasharray = '';
                        line.style.strokeDashoffset = '';
                        line.style.transition = '';
                    }, DRAW_MS + 40);
                }
                else if (line) {
                    line.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: DRAW_MS, easing: 'ease-out' });
                }
                for (const other of [nodes.area, nodes.dots]) {
                    other?.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 380, delay: 140, easing: 'ease-out', fill: 'backwards' });
                }
            }
            this.marksFront.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 260, delay: DRAW_MS - 120, fill: 'backwards' });
        }
        /** A copy of the old series that fades out while the new ones fade in. */
        ghost() {
            const copy = this.seriesLayer.cloneNode(true);
            copy.removeAttribute('class');
            copy.style.pointerEvents = 'none';
            this.svg.insertBefore(copy, this.marksFront);
            const animation = copy.animate?.([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, easing: 'ease-out', fill: 'forwards' });
            if (animation) {
                animation.onfinish = () => copy.remove();
            }
            else {
                copy.remove();
            }
        }
        /** Annotations, rules, callouts, end labels and highlights: drawn once the geometry settles. */
        renderStatic(frame, box, sx) {
            const sy = linearScale(frame.lo, frame.hi, box.bottom, box.top);
            this.sy = sy;
            const back = this.marksBack;
            const front = this.marksFront;
            back.replaceChildren();
            front.replaceChildren();
            const font = `600 11px ${win.getComputedStyle(this.element).fontFamily || 'system-ui'}`;
            for (const rule of this.model.rules) {
                const y = crisp(sy(rule.y));
                const group = s('g', { class: 'vc-rule' }, back);
                s('line', { x1: box.left, x2: box.right, y1: y, y2: y }, group);
                if (rule.label) {
                    const text = s('text', { x: box.right, y: y - 5, 'text-anchor': 'end' }, group);
                    text.textContent = rule.label;
                }
            }
            for (const annotation of this.model.annotations) {
                const x = sx(annotation.x);
                if (x < box.left - 0.5 || x > box.right + 0.5) {
                    continue;
                }
                const group = s('g', { class: 'vc-anno' }, front);
                const lineX = crisp(x);
                s('line', { x1: lineX, x2: lineX, y1: box.top - 4, y2: box.bottom }, group);
                if (annotation.label) {
                    const width = textWidth(annotation.label, font);
                    const onLeft = x + 6 + width > box.width;
                    const text = s('text', { x: onLeft ? x - 6 : x + 6, y: box.top - 8, 'text-anchor': onLeft ? 'end' : 'start' }, group);
                    text.textContent = annotation.label;
                }
            }
            for (const callout of this.model.callouts) {
                const x = sx(callout.x);
                const y = sy(callout.y);
                const group = s('g', { class: 'vc-callout' }, front);
                const circle = s('circle', { cx: x, cy: y, r: 3.5 }, group);
                circle.style.fill = this.metric.series[0]?.color ?? 'var(--vc-accent)';
                const width = textWidth(callout.label, font);
                const onLeft = x + 10 + width > box.right;
                const text = s('text', { x: onLeft ? x - 10 : x + 10, y: clamp(y + 18, box.top + 10, box.bottom - 4), 'text-anchor': onLeft ? 'end' : 'start' }, group);
                text.textContent = callout.label;
            }
            this.renderHighlight(frame, box, sx, sy, front, font);
            if (this.endLabelsWanted()) {
                this.renderEndLabels(frame, box, sy, front);
            }
        }
        renderHighlight(frame, box, sx, sy, layer, font) {
            const kind = this.model.highlight;
            if (kind === 'none') {
                return;
            }
            const series = frame.series.find(item => item.visible && !item.source.reference);
            if (!series) {
                return;
            }
            let at = -1;
            series.top.forEach((value, index) => {
                if (!Number.isFinite(value)) {
                    return;
                }
                if (at < 0 || kind === 'last' || (kind === 'max' && value > series.top[at]) || (kind === 'min' && value < series.top[at])) {
                    at = index;
                }
            });
            if (at < 0) {
                return;
            }
            const x = sx(series.xs[at]);
            const y = sy(series.top[at]);
            const group = s('g', { class: 'vc-mark' }, layer);
            const circle = s('circle', { cx: x, cy: y, r: 3.5 }, group);
            circle.style.fill = series.source.color;
            const label = `${kind === 'max' ? 'Peak ' : kind === 'min' ? 'Low ' : ''}${formatValue(series.raw[at], series.source.unit)}`;
            const width = textWidth(label, font);
            const below = kind === 'min' || y - 12 < box.top;
            const text = s('text', { x: clamp(x, box.left + width / 2, box.right - width / 2), y: below ? y + 18 : y - 10, 'text-anchor': 'middle' }, group);
            text.textContent = label;
        }
        renderEndLabels(frame, box, sy, layer) {
            const group = s('g', { class: 'vc-end' }, layer);
            const font = `500 12px ${win.getComputedStyle(this.element).fontFamily || 'system-ui'}`;
            const items = [];
            for (const series of frame.series) {
                if (!series.visible || series.source.reference) {
                    continue;
                }
                let at = series.top.length - 1;
                while (at >= 0 && !Number.isFinite(series.top[at])) {
                    at--;
                }
                if (at < 0) {
                    continue;
                }
                const y = this.stacked ? sy((series.top[at] + series.bot[at]) / 2) : sy(series.top[at]);
                items.push({ y, name: series.source.name, value: this.endValue(series), color: series.source.color });
            }
            items.sort((a, b) => a.y - b.y);
            const gap = 16;
            for (let index = 1; index < items.length; index++) {
                items[index].y = Math.max(items[index].y, items[index - 1].y + gap);
            }
            const overflow = items.length ? items[items.length - 1].y - (box.bottom - 6) : 0;
            if (overflow > 0) {
                for (let index = items.length - 1; index >= 0; index--) {
                    items[index].y -= overflow;
                    if (index > 0 && items[index - 1].y > items[index].y - gap) {
                        items[index - 1].y = items[index].y - gap;
                    }
                }
            }
            const maxWidth = box.width - box.right - 10;
            for (const item of items) {
                const text = s('text', { x: box.right + 10, y: item.y, 'dominant-baseline': 'central' }, group);
                const valueWidth = textWidth(` ${item.value}`, font);
                const name = s('tspan', {}, text);
                name.textContent = ellipsize(item.name, font, maxWidth - valueWidth);
                const value = s('tspan', { class: 'vc-end-value' }, text);
                value.textContent = ` ${item.value}`;
            }
        }
        renderEmpty(show) {
            if (!show) {
                this.emptyEl?.remove();
                this.emptyEl = undefined;
                return;
            }
            const box = this.box;
            if (box) {
                const y = crisp(box.bottom);
                const baseline = s('line', { x1: box.left, x2: box.right, y1: y, y2: y, class: 'vc-zero' }, this.marksBack);
                baseline.style.stroke = 'var(--vc-zero)';
            }
            this.emptyEl = h('div', 'vc-empty', this.plot);
            h('div', 'vc-empty-title', this.emptyEl, this.model.emptyTitle ?? this.ctx.strings.emptyTitle);
            h('div', 'vc-empty-message', this.emptyEl, this.model.emptyMessage ?? this.ctx.strings.emptyMessage);
        }
        renderSkeleton(height) {
            this.seriesLayer.replaceChildren();
            this.marksBack.replaceChildren();
            this.marksFront.replaceChildren();
            this.xAxisLayer.replaceChildren();
            for (const group of this.ticks.values()) {
                group.remove();
            }
            this.ticks.clear();
            this.shown = undefined;
            this.hideCursor();
            const width = this.width;
            const skeleton = s('g', { class: 'vc-skel' }, this.seriesLayer);
            for (let index = 0; index < 4; index++) {
                const y = crisp(10 + ((height - 34) * index) / 3);
                const line = s('line', { x1: 0, x2: width, y1: y, y2: y }, skeleton);
                line.style.stroke = 'var(--vc-grid)';
            }
            const points = [];
            for (let index = 0; index <= 12; index++) {
                const x = (width * index) / 12;
                const wave = Math.sin(index * 0.9) * 0.18 + Math.sin(index * 0.37 + 1) * 0.12;
                points.push([x, (height - 34) * (0.55 - wave) + 10]);
            }
            const path = s('path', { d: monotonePath(points, true), class: 'vc-line' }, skeleton);
            path.style.stroke = 'color-mix(in srgb, var(--vc-fg) 14%, transparent)';
            if (this.header) {
                this.header.element.classList.add('vc-skel');
            }
        }
        setHeadline(animate) {
            const header = this.header;
            const headline = this.metric.headline;
            if (!header || !headline) {
                return;
            }
            header.element.classList.remove('vc-skel');
            const label = headline.label ?? this.metric.label;
            if (isNum(headline.value)) {
                header.set(headline.value, this.metric.unit, label, undefined, '', headline.good, animate);
                return;
            }
            const bounds = this.rangeBounds();
            const current = this.aggregate(headline, bounds ? (x) => x >= bounds.lo && x <= bounds.hi : () => true);
            let delta;
            if (headline.compare && bounds) {
                const previous = this.aggregate(headline, x => x >= bounds.lo - bounds.length && x < bounds.lo);
                if (isNum(previous) && isNum(current)) {
                    delta = formatDelta(current, previous, this.metric.unit);
                }
            }
            header.set(current, this.metric.unit, label, delta, `${this.ctx.strings.vsPrevious} ${rangeNoun(this.range)}`, headline.good, animate);
        }
        aggregate(headline, include) {
            const series = this.metric.series.filter(item => !item.reference && !this.hidden.has(item.key));
            const values = [];
            const lasts = [];
            for (const item of series) {
                let last;
                for (const point of item.points) {
                    if (include(point.x) && Number.isFinite(point.y)) {
                        values.push(point.y);
                        last = point.y;
                    }
                }
                if (last !== undefined) {
                    lasts.push(last);
                }
            }
            if (!values.length) {
                return undefined;
            }
            const sum = (list) => list.reduce((total, value) => total + value, 0);
            switch (headline.aggregate) {
                case 'sum': return sum(values);
                case 'avg': return sum(values) / values.length;
                case 'max': return Math.max(...values);
                case 'min': return Math.min(...values);
                case 'last': return this.stacked || additive(this.metric.unit) ? sum(lasts) : sum(lasts) / lasts.length;
            }
        }
        //#endregion
        //#region Interaction
        wire() {
            const plot = this.plot;
            plot.addEventListener('pointermove', event => {
                if (event.pointerType === 'touch' && event.buttons === 0) {
                    return;
                }
                const rect = this.svg.getBoundingClientRect();
                this.pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
                if (!this.pointerFrame) {
                    this.pointerFrame = win.requestAnimationFrame(() => {
                        this.pointerFrame = 0;
                        if (this.pointer) {
                            this.hoverAt(this.pointer.x, this.pointer.y);
                        }
                    });
                }
            });
            plot.addEventListener('pointerdown', event => {
                const rect = this.svg.getBoundingClientRect();
                this.hoverAt(event.clientX - rect.left, event.clientY - rect.top);
            });
            plot.addEventListener('pointerleave', () => {
                this.pointer = undefined;
                if (this.ownerDocumentActive() !== plot) {
                    this.hideCursor();
                }
            });
            plot.addEventListener('click', () => {
                const href = this.currentPoint()?.href;
                if (href) {
                    this.ctx.onOpen?.(href);
                }
            });
            plot.addEventListener('focus', () => {
                if (!this.cursorShown && this.shown && !this.shown.empty) {
                    this.moveCursor(this.cursorIndex >= 0 ? this.cursorIndex : this.shown.domain.length - 1, true);
                    this.announce();
                }
            });
            plot.addEventListener('blur', () => {
                if (!this.pointer) {
                    this.hideCursor();
                }
            });
            plot.addEventListener('keydown', event => this.onKey(event));
        }
        ownerDocumentActive() {
            return this.plot.ownerDocument.activeElement;
        }
        onKey(event) {
            const frame = this.shown;
            if (!frame || frame.empty || !frame.domain.length) {
                return;
            }
            const last = frame.domain.length - 1;
            let index = this.cursorIndex < 0 ? last : this.cursorIndex;
            const big = Math.max(1, Math.round(frame.domain.length / 10));
            switch (event.key) {
                case 'ArrowLeft':
                    index -= event.shiftKey ? big : 1;
                    break;
                case 'ArrowRight':
                    index += event.shiftKey ? big : 1;
                    break;
                case 'PageUp':
                    index -= big;
                    break;
                case 'PageDown':
                    index += big;
                    break;
                case 'Home':
                    index = 0;
                    break;
                case 'End':
                    index = last;
                    break;
                case 'ArrowUp':
                case 'ArrowDown': {
                    const keys = frame.series.filter(series => series.visible && !series.source.reference).map(series => series.source.key);
                    if (keys.length > 1) {
                        const at = keys.indexOf(this.primaryKey ?? keys[0]);
                        this.primaryKey = keys[(at + (event.key === 'ArrowUp' ? -1 : 1) + keys.length) % keys.length];
                    }
                    break;
                }
                case 'Enter':
                case ' ': {
                    const href = this.currentPoint()?.href;
                    if (href) {
                        event.preventDefault();
                        this.ctx.onOpen?.(href);
                    }
                    return;
                }
                case 'Escape':
                    this.hideCursor();
                    return;
                default:
                    return;
            }
            event.preventDefault();
            this.moveCursor(clamp(index, 0, last), false);
            this.announce();
        }
        hoverAt(px, py) {
            const frame = this.shown;
            const box = this.box;
            const sx = this.sx;
            const sy = this.sy;
            if (!frame || !box || !sx || !sy || frame.empty || !frame.domain.length || this.loading) {
                return;
            }
            if (this.model.type === 'scatter') {
                this.hoverScatter(frame, px, py, sx, sy);
                return;
            }
            const index = nearestIndex(frame.domain, sx.inv(px));
            if (!this.focusKey) {
                // The series nearest the pointer leads the tooltip.
                let best;
                let bestDistance = Infinity;
                for (const series of frame.series) {
                    if (!series.visible || series.source.reference) {
                        continue;
                    }
                    const at = this.valueIndex(series, frame.domain[index]);
                    if (at < 0) {
                        continue;
                    }
                    const top = sy(series.top[at]);
                    const bot = this.stacked ? sy(series.bot[at]) : top;
                    const distance = py >= Math.min(top, bot) && py <= Math.max(top, bot) ? 0 : Math.min(Math.abs(py - top), Math.abs(py - bot));
                    if (distance < bestDistance) {
                        bestDistance = distance;
                        best = series.source.key;
                    }
                }
                this.primaryKey = best;
            }
            this.moveCursor(index, false);
        }
        hoverScatter(frame, px, py, sx, sy) {
            let bestSeries;
            let bestIndex = -1;
            let bestDistance = 28 * 28;
            for (const series of frame.series) {
                if (!series.visible) {
                    continue;
                }
                const center = nearestIndex(series.xs, sx.inv(px));
                for (let at = Math.max(0, center - 60); at < Math.min(series.xs.length, center + 60); at++) {
                    if (!Number.isFinite(series.top[at])) {
                        continue;
                    }
                    const dx = sx(series.xs[at]) - px;
                    const dy = sy(series.top[at]) - py;
                    const distance = dx * dx + dy * dy;
                    if (distance < bestDistance) {
                        bestDistance = distance;
                        bestSeries = series;
                        bestIndex = at;
                    }
                }
            }
            if (!bestSeries) {
                this.hideCursor();
                return;
            }
            this.primaryKey = bestSeries.source.key;
            this.moveCursor(nearestIndex(frame.domain, bestSeries.xs[bestIndex]), false);
        }
        /** Index in `series.xs` of the point at `x`: exact, or the nearest within half a step. */
        valueIndex(series, x) {
            const at = nearestIndex(series.xs, x);
            if (at < 0 || !Number.isFinite(series.raw[at])) {
                return -1;
            }
            if (series.xs[at] === x) {
                return at;
            }
            const frame = this.shown;
            const tolerance = frame ? this.typicalGap(frame) / 2 : 0;
            return Math.abs(series.xs[at] - x) <= tolerance ? at : -1;
        }
        currentPoint() {
            const frame = this.shown;
            if (!frame || this.cursorIndex < 0 || !this.cursorShown) {
                return undefined;
            }
            const x = frame.domain[this.cursorIndex];
            const series = frame.series.find(item => item.source.key === this.primaryKey) ?? frame.series.find(item => item.visible && !item.source.reference);
            if (!series) {
                return undefined;
            }
            const at = this.valueIndex(series, x);
            return at >= 0 ? series.points[at] : undefined;
        }
        moveCursor(index, jump) {
            const frame = this.shown;
            const box = this.box;
            const sx = this.sx;
            const sy = this.sy;
            if (!frame || !box || !sx || !sy || index < 0 || index >= frame.domain.length) {
                return;
            }
            const changed = index !== this.cursorIndex;
            this.cursorIndex = index;
            const x = frame.domain[index];
            const firstShow = !this.cursorShown;
            const snap = jump || firstShow;
            if (!this.primaryKey || !frame.series.some(series => series.source.key === this.primaryKey && series.visible)) {
                this.primaryKey = frame.series.find(series => series.visible && !series.source.reference)?.source.key;
            }
            this.springs.set('x', sx(x), snap);
            for (const series of frame.series) {
                const at = this.valueIndex(series, x);
                const knob = this.knobs.get(series.source.key);
                const visible = at >= 0 && series.visible && !series.source.reference;
                if (knob) {
                    knob.style.opacity = visible && series.source.key !== this.primaryKey ? '0.9' : '0';
                }
                if (visible) {
                    this.springs.set(`y:${series.source.key}`, sy(series.top[at]), snap || knob?.style.opacity === '0');
                }
            }
            const primary = frame.series.find(series => series.source.key === this.primaryKey);
            const primaryAt = primary ? this.valueIndex(primary, x) : -1;
            const showKnob = !this.bars && primaryAt >= 0;
            this.knob.style.opacity = showKnob ? '1' : '0';
            this.halo.style.opacity = showKnob ? '' : '0';
            if (primary && primaryAt >= 0) {
                this.knob.style.fill = primary.source.color;
                this.halo.style.fill = primary.source.color;
                this.springs.set('ky', sy(primary.top[primaryAt]), snap);
            }
            const bars = this.bars;
            const slot = bars ? Math.abs(sx(this.typicalGap(frame)) - sx(0)) : 0;
            setAttrs(this.crosshair, { y1: box.top, y2: box.bottom });
            this.crosshair.style.opacity = bars ? '0' : '1';
            setAttrs(this.bandHover, { x: -slot / 2, width: slot, y: box.top, height: box.bottom - box.top });
            this.bandHover.style.opacity = bars ? '1' : '0';
            this.hit.classList.toggle('vc-link', !!this.currentPointAt(index)?.href);
            if (changed || firstShow) {
                this.tip.set(this.tipModel(frame, index));
            }
            this.cursorShown = true;
            this.cursorLayer.classList.add('vc-shown');
            this.tip.show();
            this.applyCursor();
        }
        currentPointAt(index) {
            const frame = this.shown;
            if (!frame) {
                return undefined;
            }
            const series = frame.series.find(item => item.source.key === this.primaryKey);
            const at = series ? this.valueIndex(series, frame.domain[index]) : -1;
            return series && at >= 0 ? series.points[at] : undefined;
        }
        applyCursor() {
            const box = this.box;
            if (!box || !this.cursorShown) {
                return;
            }
            const x = this.springs.get('x');
            const crossX = crisp(x);
            this.crosshair.setAttribute('transform', `translate(${num(crossX)},0)`);
            this.bandHover.setAttribute('transform', `translate(${num(x)},0)`);
            const ky = this.springs.get('ky');
            setAttrs(this.knob, { cx: x, cy: ky });
            setAttrs(this.halo, { cx: x, cy: ky });
            for (const [key, knob] of this.knobs) {
                if (knob.style.opacity !== '0') {
                    setAttrs(knob, { cx: x, cy: this.springs.get(`y:${key}`) });
                }
            }
            const anchorY = this.bars ? box.top + (box.bottom - box.top) * 0.35 : ky;
            this.tip.place(x, anchorY, box.width, 0, box.height, this.bars ? Math.abs((this.sx?.(this.typicalGap(this.shown)) ?? 0) - (this.sx?.(0) ?? 0)) / 2 + 8 : 14);
        }
        hideCursor() {
            if (!this.cursorShown) {
                return;
            }
            this.cursorShown = false;
            this.cursorLayer.classList.remove('vc-shown');
            this.tip.hide();
            this.hit.classList.remove('vc-link');
        }
        xLabel(x) {
            const model = this.model;
            if (model.xKind === 'time') {
                return formatTimePoint(x, model.grain, model.zone);
            }
            if (model.xKind === 'category') {
                return model.categories[Math.round(x)] ?? String(x);
            }
            return formatValue(x, model.xUnit);
        }
        tipModel(frame, index) {
            const x = frame.domain[index];
            const title = this.xLabel(x);
            const primary = frame.series.find(series => series.source.key === this.primaryKey);
            const primaryAt = primary ? this.valueIndex(primary, x) : -1;
            const point = primary && primaryAt >= 0 ? primary.points[primaryAt] : undefined;
            if (point && this.model.tooltip) {
                return this.model.tooltip(point);
            }
            const visible = frame.series.filter(series => series.visible);
            const hint = point?.href ? this.ctx.strings.open : undefined;
            if (visible.filter(series => !series.source.reference).length <= 1 || this.model.type === 'scatter') {
                const series = primary ?? visible[0];
                const at = series ? this.valueIndex(series, x) : -1;
                const value = series && at >= 0 ? series.raw[at] : Number.NaN;
                const references = visible.filter(item => item.source.reference && item !== series).flatMap(item => {
                    const refAt = this.valueIndex(item, x);
                    return refAt >= 0 ? [{ name: item.source.name, value: formatValue(item.raw[refAt], item.source.unit), color: item.source.color, dashed: true }] : [];
                });
                return {
                    title: point?.label ? `${point.label} · ${title}` : title,
                    hero: series ? formatValue(value, series.source.unit, true) : undefined,
                    sub: visible.length > 1 && series ? series.source.name : undefined,
                    rows: references,
                    meta: point?.detail,
                    hint,
                };
            }
            const rows = [];
            let total = 0;
            let summed = 0;
            visible.forEach((series, order) => {
                const at = this.valueIndex(series, x);
                if (at < 0) {
                    return;
                }
                const raw = series.raw[at];
                if (!series.source.reference && Number.isFinite(raw)) {
                    total += this.model.type === 'share' ? 0 : raw;
                    summed++;
                }
                let value = formatValue(raw, series.source.unit);
                if (this.model.type === 'share') {
                    // The share, then what it is a share of.
                    const absolute = series.points[at]?.y;
                    value = isNum(absolute) ? `${formatPercent(raw)}  ·  ${formatValue(absolute, series.source.unit)}` : formatPercent(raw);
                }
                rows.push({ name: series.source.name, value, color: series.source.color, dashed: series.source.dashed, strong: series.source.key === this.primaryKey, order: this.stacked ? -order : -raw });
            });
            rows.sort((a, b) => a.order - b.order);
            const limited = rows.slice(0, 8);
            if (rows.length > 8) {
                limited.push({ name: `+${rows.length - 8} more`, value: '' });
            }
            if (summed > 1 && this.model.type !== 'share' && (this.stacked || additive(frame.unit))) {
                limited.push({ name: this.ctx.strings.total, value: formatValue(total, frame.unit), strong: false });
            }
            return { title, rows: limited, meta: point?.detail, hint };
        }
        announce() {
            const frame = this.shown;
            if (!frame || this.cursorIndex < 0) {
                return;
            }
            const model = this.tipModel(frame, this.cursorIndex);
            const parts = [model.title, model.hero, model.sub, ...(model.rows ?? []).map(row => `${row.name} ${row.value}`), ...(model.meta ?? []).map(([name, value]) => `${name} ${value}`)].filter(Boolean);
            this.live.textContent = parts.join(', ');
        }
        //#endregion
        dispose() {
            this.animation?.cancel();
            this.springs.dispose();
            this.tip.dispose();
            this.header?.dispose();
            if (this.pointerFrame) {
                win.cancelAnimationFrame(this.pointerFrame);
            }
        }
    }
    //#endregion
    //#region Stats row
    function statDelta(item, unit) {
        if (!isNum(item.delta)) {
            return undefined;
        }
        const delta = item.delta;
        const direction = Math.abs(delta) < 0.05 ? 0 : delta > 0 ? 1 : -1;
        const arrow = direction > 0 ? '↑' : direction < 0 ? '↓' : '→';
        const points = unit.kind === 'percent' || unit.kind === 'ratio';
        return { text: `${arrow} ${numberFormat(0, Math.abs(delta) >= 100 ? 0 : 1).format(Math.abs(delta))}${points ? ' pts' : '%'}`, direction };
    }
    /** Headline numbers in a row of hairline-divided tiles, each with an optional change and sparkline. */
    class StatsBlock {
        constructor(parent, spec, _ctx, problems, where) {
            this.trends = [];
            this.element = h('div', 'vc-block', parent);
            blockHead(this.element, spec.title, spec.subtitle);
            const items = (Array.isArray(spec.items) ? spec.items : []).filter(isRecord).slice(0, 12);
            if (!items.length) {
                problems.push(`${where}: stats need "items": [{ "label": "...", "value": 123 }].`);
            }
            const wrap = h('div', 'vc-stats', this.element);
            const inner = h('div', 'vc-stats-inner', wrap);
            items.forEach((item, index) => {
                const tile = h('div', 'vc-stat', inner);
                const label = str(item.label, 80) ?? '';
                const unit = resolveUnit(item.unit, label, isNum(item.value) ? [item.value] : []);
                const text = isNum(item.value) ? formatValue(item.value, unit) : str(item.value, 40) ?? '—';
                const value = h('div', 'vc-stat-value', tile, text);
                value.title = text;
                h('div', 'vc-stat-label', tile, label);
                const delta = statDelta(item, unit);
                if (delta) {
                    const good = item.good === 'up' || item.good === 'down' ? item.good : undefined;
                    const deltaEl = h('div', `vc-stat-delta${good && delta.direction ? ((delta.direction > 0) === (good === 'up') ? ' vc-good' : ' vc-bad') : ''}`, tile, delta.text);
                    const deltaLabel = str(item.deltaLabel, 60);
                    if (deltaLabel) {
                        deltaEl.append(` ${deltaLabel}`);
                    }
                }
                const trend = Array.isArray(item.trend) ? item.trend.filter(isNum).slice(0, 2000) : [];
                if (trend.length > 1) {
                    const svg = s('svg', { class: 'vc-stat-trend', height: 26 }, tile);
                    this.trends.push({ svg, values: trend, color: seriesColor(item.color, index, label) });
                }
                if (!label) {
                    problems.push(`${where}: item ${index + 1} has no label.`);
                }
            });
        }
        layout() {
            for (const trend of this.trends) {
                const width = Math.max(40, (trend.svg.parentElement?.clientWidth ?? 120) - 32);
                const height = 26;
                let lo = Infinity;
                let hi = -Infinity;
                for (const value of trend.values) {
                    lo = Math.min(lo, value);
                    hi = Math.max(hi, value);
                }
                const span = hi - lo || 1;
                const points = trend.values.map((value, index) => [(index / (trend.values.length - 1)) * width, 3 + (1 - (value - lo) / span) * (height - 6)]);
                trend.svg.replaceChildren();
                setAttrs(trend.svg, { width, viewBox: `0 0 ${width} ${height}` });
                const id = nextId('spark');
                const gradient = s('linearGradient', { id, x1: 0, x2: 0, y1: 0, y2: 1 }, s('defs', {}, trend.svg));
                const a = s('stop', { offset: '0%' }, gradient);
                a.style.stopColor = trend.color;
                a.style.stopOpacity = '0.2';
                const b = s('stop', { offset: '100%' }, gradient);
                b.style.stopColor = trend.color;
                b.style.stopOpacity = '0';
                const curve = trend.values.length > width / 2 ? 'linear' : 'smooth';
                s('path', { d: areaPath(points, points.map(([x]) => [x, height]), curve), fill: `url(#${id})` }, trend.svg);
                const line = s('path', { d: curvePath(points, curve, true), class: 'vc-line' }, trend.svg);
                line.style.stroke = trend.color;
                line.style.strokeWidth = '1.5';
                const lastPoint = points[points.length - 1];
                const dot = s('circle', { cx: lastPoint[0], cy: lastPoint[1], r: 2.25, class: 'vc-dot' }, trend.svg);
                dot.style.fill = trend.color;
            }
        }
        dispose() { }
    }
    //#endregion
    //#region Heatmap
    class HeatmapBlock {
        constructor(parent, spec, ctx, problems, where) {
            this.ctx = ctx;
            this.width = 0;
            this.drawn = false;
            this.element = h('div', 'vc-block', parent);
            blockHead(this.element, spec.title, spec.subtitle);
            this.rows = (Array.isArray(spec.rows) ? spec.rows : []).map(item => str(item, 40) ?? '').slice(0, 60);
            this.columns = (Array.isArray(spec.columns) ? spec.columns : []).map(item => str(item, 40) ?? '').slice(0, 200);
            const raw = Array.isArray(spec.values) ? spec.values : [];
            this.values = this.rows.map((_, row) => this.columns.map((__, column) => {
                const line = raw[row];
                const value = Array.isArray(line) ? line[column] : undefined;
                return isNum(value) ? value : Number.NaN;
            }));
            if (!this.rows.length || !this.columns.length) {
                problems.push(`${where}: heatmaps need "rows", "columns" and "values" (values[row][column]).`);
            }
            else if (raw.length !== this.rows.length || raw.some(line => !Array.isArray(line) || line.length !== this.columns.length)) {
                problems.push(`${where}: "values" must have ${this.rows.length} rows of ${this.columns.length} numbers.`);
            }
            let lo = Infinity;
            let hi = -Infinity;
            const flat = [];
            for (const line of this.values) {
                for (const value of line) {
                    if (Number.isFinite(value)) {
                        lo = Math.min(lo, value);
                        hi = Math.max(hi, value);
                        flat.push(value);
                    }
                }
            }
            this.lo = Number.isFinite(lo) ? Math.min(0, lo) : 0;
            this.hi = Number.isFinite(hi) ? hi : 1;
            this.unit = resolveUnit(spec.unit, `${str(spec.title) ?? ''} ${str(spec.subtitle) ?? ''}`, flat);
            this.plot = h('div', 'vc-plot', this.element);
            this.plot.tabIndex = 0;
            this.plot.setAttribute('role', 'group');
            this.plot.setAttribute('aria-roledescription', 'heatmap');
            this.plot.setAttribute('aria-label', `${str(spec.title) ?? 'Heatmap'}. Use arrow keys to read cells.`);
            this.svg = s('svg', { class: 'vc-svg' }, this.plot);
            this.cellsLayer = s('g', {}, this.svg);
            this.hover = s('rect', { class: 'vc-heat-hover' }, this.svg);
            this.hover.style.opacity = '0';
            this.tip = new Tip(this.plot);
            this.live = h('div', 'vc-sr', this.plot);
            this.live.setAttribute('aria-live', 'polite');
            const scaleWords = Array.isArray(spec.scale) ? spec.scale.map(item => str(item, 20)) : [];
            const key = h('div', 'vc-heat-key', this.element);
            h('span', '', key, scaleWords[0] ?? ctx.strings.fewer);
            for (let step = 0; step < 10; step++) {
                h('span', 'vc-heat-step', key).style.background = heatColor(step / 9);
            }
            h('span', '', key, scaleWords[1] ?? ctx.strings.more);
            this.wire();
        }
        layout(width) {
            if (width === this.width && this.drawn) {
                return;
            }
            this.width = width;
            const font = `400 11px ${win.getComputedStyle(this.element).fontFamily || 'system-ui'}`;
            let labelWidth = 0;
            for (const row of this.rows) {
                labelWidth = Math.max(labelWidth, textWidth(row, font));
            }
            const left = Math.ceil(labelWidth) + 10;
            const columns = Math.max(1, this.columns.length);
            const gap = width < 480 ? 2 : 3;
            const cell = Math.max(4, (width - left - gap * (columns - 1)) / columns);
            const cellH = clamp(cell * 0.86, 12, 34);
            const top = 0;
            const gridHeight = this.rows.length * cellH + Math.max(0, this.rows.length - 1) * gap;
            const height = gridHeight + 22;
            this.geometry = { left, top, cell, cellH, gap, width, height };
            setAttrs(this.svg, { width, height, viewBox: `0 0 ${width} ${height}` });
            this.plot.style.height = `${height}px`;
            this.cellsLayer.replaceChildren();
            const radius = Math.min(4, cell / 5, cellH / 5);
            const animate = !this.drawn && this.ctx.animate && !reducedMotion();
            const span = this.hi - this.lo || 1;
            this.rows.forEach((row, r) => {
                const y = top + r * (cellH + gap);
                const label = s('text', { x: left - 10, y: y + cellH / 2, 'text-anchor': 'end', 'dominant-baseline': 'central', class: 'vc-axis-label' }, this.cellsLayer);
                label.textContent = row;
                label.style.fill = 'var(--vc-muted)';
                label.style.fontSize = '11px';
                this.columns.forEach((_, c) => {
                    const value = this.values[r][c];
                    const rect = s('rect', { x: left + c * (cell + gap), y, width: cell, height: cellH, rx: radius, class: 'vc-heat-cell' }, this.cellsLayer);
                    rect.style.fill = Number.isFinite(value) ? heatColor((value - this.lo) / span) : 'var(--vc-grid)';
                    if (animate) {
                        rect.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 320, delay: 80 + c * 14 + r * 6, easing: 'ease-out', fill: 'backwards' });
                    }
                });
            });
            let widest = 0;
            for (const column of this.columns) {
                widest = Math.max(widest, textWidth(column, font));
            }
            const every = Math.max(1, Math.ceil((widest + 10) / (cell + gap)));
            for (let c = 0; c < this.columns.length; c += every) {
                const text = s('text', { x: left + c * (cell + gap) + (every > 1 ? 0 : cell / 2), y: gridHeight + 16, 'text-anchor': every > 1 ? 'start' : 'middle' }, this.cellsLayer);
                text.textContent = this.columns[c];
                text.style.fill = 'var(--vc-muted)';
                text.style.fontSize = '11px';
            }
            this.drawn = true;
            if (this.active) {
                this.activate(this.active[0], this.active[1], true);
            }
        }
        wire() {
            this.plot.addEventListener('pointermove', event => {
                const g = this.geometry;
                if (!g) {
                    return;
                }
                const rect = this.svg.getBoundingClientRect();
                const x = event.clientX - rect.left - g.left;
                const y = event.clientY - rect.top - g.top;
                const c = Math.floor(x / (g.cell + g.gap));
                const r = Math.floor(y / (g.cellH + g.gap));
                if (c >= 0 && c < this.columns.length && r >= 0 && r < this.rows.length) {
                    this.activate(r, c, false);
                }
                else {
                    this.deactivate();
                }
            });
            this.plot.addEventListener('pointerleave', () => this.deactivate());
            this.plot.addEventListener('blur', () => this.deactivate());
            this.plot.addEventListener('focus', () => {
                if (!this.active) {
                    this.activate(0, 0, true);
                }
            });
            this.plot.addEventListener('keydown', event => {
                const [r, c] = this.active ?? [0, 0];
                const moves = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
                const move = moves[event.key];
                if (move) {
                    event.preventDefault();
                    this.activate(clamp(r + move[0], 0, this.rows.length - 1), clamp(c + move[1], 0, this.columns.length - 1), true);
                    this.live.textContent = `${this.rows[this.active[0]]} ${this.columns[this.active[1]]}: ${formatValue(this.values[this.active[0]][this.active[1]], this.unit, true)}`;
                }
                else if (event.key === 'Escape') {
                    this.deactivate();
                }
            });
        }
        activate(r, c, jump) {
            const g = this.geometry;
            if (!g) {
                return;
            }
            const same = this.active && this.active[0] === r && this.active[1] === c;
            this.active = [r, c];
            const x = g.left + c * (g.cell + g.gap);
            const y = g.top + r * (g.cellH + g.gap);
            setAttrs(this.hover, { x: x - 1, y: y - 1, width: g.cell + 2, height: g.cellH + 2, rx: Math.min(5, g.cell / 4) });
            this.hover.style.opacity = '1';
            if (!same || jump) {
                const value = this.values[r][c];
                this.tip.set({ title: `${this.rows[r]} · ${this.columns[c]}`, hero: formatValue(value, this.unit, true) });
            }
            this.tip.show();
            this.tip.place(x + g.cell / 2, y + g.cellH / 2, g.width, 0, g.height, g.cell / 2 + 8);
        }
        deactivate() {
            this.active = undefined;
            this.hover.style.opacity = '0';
            this.tip.hide();
        }
        dispose() {
            this.tip.dispose();
        }
    }
    function readTree(raw, problems, where) {
        let count = 0;
        const read = (value, depth) => {
            if (!isRecord(value) || count > 20_000 || depth > 24) {
                return undefined;
            }
            count++;
            const children = (Array.isArray(value.children) ? value.children : []).map(child => read(child, depth + 1)).filter((child) => !!child && child.value > 0);
            const own = isNum(value.value) ? Math.max(0, value.value) : 0;
            const sum = children.reduce((total, child) => total + child.value, 0);
            return {
                name: str(value.name, 120) ?? '',
                value: children.length ? Math.max(sum, own) : own,
                color: isNum(value.color) ? value.color : undefined,
                href: safeHref(value.href),
                detail: detailRows(value.detail),
                children,
                path: '',
                x0: 0, y0: 0, x1: 0, y1: 0,
                group: 0,
            };
        };
        const root = Array.isArray(raw) ? read({ name: '', children: raw }, 0) : read(raw, 0);
        if (!root || root.value <= 0) {
            problems.push(`${where}: treemaps need "data": { "name": "...", "children": [{ "name": "...", "value": 12 }] } with positive values.`);
            return { name: '', value: 0, children: [], path: '', x0: 0, y0: 0, x1: 0, y1: 0, group: 0 };
        }
        if (count > 20_000) {
            problems.push(`${where}: only the first 20,000 treemap nodes are drawn.`);
        }
        const link = (node, parent, group) => {
            node.parent = parent;
            node.group = group;
            const join = parent?.path && !parent.path.endsWith('/') ? `${parent.path}/` : parent?.path ?? '';
            node.path = parent ? `${join}${node.name}` : node.name;
            node.children.sort((a, b) => b.value - a.value);
            node.children.forEach((child, index) => link(child, node, parent ? group : index));
        };
        link(root, undefined, 0);
        return root;
    }
    /** Squarified treemap (Bruls et al.): rows of tiles whose aspect ratios stay close to 1. */
    function squarify(nodes, x0, y0, x1, y1) {
        const items = nodes.filter(node => node.value > 0);
        const total = items.reduce((sum, node) => sum + node.value, 0);
        if (total <= 0 || x1 - x0 <= 0 || y1 - y0 <= 0) {
            for (const node of nodes) {
                node.x0 = node.x1 = x0;
                node.y0 = node.y1 = y0;
            }
            return;
        }
        const scale = ((x1 - x0) * (y1 - y0)) / total;
        const rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
        const worst = (row, side) => {
            let sum = 0;
            let max = 0;
            let min = Infinity;
            for (const node of row) {
                const area = node.value * scale;
                sum += area;
                max = Math.max(max, area);
                min = Math.min(min, area);
            }
            const side2 = side * side;
            const sum2 = sum * sum;
            return Math.max((side2 * max) / sum2, sum2 / (side2 * min));
        };
        const place = (row) => {
            const area = row.reduce((sum, node) => sum + node.value * scale, 0);
            if (rect.w >= rect.h) {
                const width = rect.h > 0 ? area / rect.h : 0;
                let y = rect.y;
                for (const node of row) {
                    const height = width > 0 ? (node.value * scale) / width : 0;
                    node.x0 = rect.x;
                    node.x1 = rect.x + width;
                    node.y0 = y;
                    node.y1 = y + height;
                    y += height;
                }
                rect.x += width;
                rect.w -= width;
            }
            else {
                const height = rect.w > 0 ? area / rect.w : 0;
                let x = rect.x;
                for (const node of row) {
                    const width = height > 0 ? (node.value * scale) / height : 0;
                    node.y0 = rect.y;
                    node.y1 = rect.y + height;
                    node.x0 = x;
                    node.x1 = x + width;
                    x += width;
                }
                rect.y += height;
                rect.h -= height;
            }
        };
        let row = [];
        let index = 0;
        while (index < items.length) {
            const side = Math.min(rect.w, rect.h);
            const next = items[index];
            if (!row.length || worst([...row, next], side) <= worst(row, side)) {
                row.push(next);
                index++;
            }
            else {
                place(row);
                row = [];
            }
        }
        if (row.length) {
            place(row);
        }
    }
    const GROUP_HEADER = 17;
    function layoutTree(node, x0, y0, x1, y1, depth) {
        node.x0 = x0;
        node.y0 = y0;
        node.x1 = x1;
        node.y1 = y1;
        if (!node.children.length) {
            return;
        }
        const width = x1 - x0;
        const height = y1 - y0;
        const header = depth > 0 && width > 46 && height > GROUP_HEADER * 2.2 ? GROUP_HEADER : 0;
        const pad = depth > 0 ? (width > 24 && height > 24 ? 2 : 0) : 0;
        squarify(node.children, x0 + pad, y0 + header + (header ? 0 : pad), x1 - pad, y1 - pad);
        for (const child of node.children) {
            layoutTree(child, child.x0, child.y0, child.x1, child.y1, depth + 1);
        }
    }
    /** Resolved sRGB for CSS colors (var(), color-mix()), read in one style pass. */
    function resolveRgb(host, colors) {
        const probe = doc.createElement('div');
        probe.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;visibility:hidden';
        host.appendChild(probe);
        const spans = colors.map(color => {
            const span = doc.createElement('span');
            span.style.color = color;
            probe.appendChild(span);
            return span;
        });
        const out = spans.map(span => {
            const value = win.getComputedStyle(span).color;
            const match = /(?:rgba?\(|color\(srgb\s+)([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(value);
            if (!match) {
                return undefined;
            }
            const scale = value.startsWith('color(') ? 255 : 1;
            return [Number(match[1]) * scale, Number(match[2]) * scale, Number(match[3]) * scale];
        });
        probe.remove();
        return out;
    }
    function luminance([r, g, b]) {
        const channel = (value) => {
            const c = value / 255;
            return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    }
    class TreemapBlock {
        constructor(parent, spec, ctx, problems, where) {
            this.ctx = ctx;
            this.leaves = [];
            this.width = 0;
            this.height = 0;
            this.drawn = false;
            this.zooming = false;
            this.element = h('div', 'vc-block', parent);
            blockHead(this.element, spec.title, spec.subtitle);
            this.root = readTree(spec.data, problems, where);
            this.focus = this.root;
            this.sizeLabel = str(spec.sizeLabel, 40);
            this.colorLabel = str(spec.colorLabel, 60);
            this.sizeUnit = resolveUnit(spec.unit, this.sizeLabel);
            this.colorUnit = resolveUnit(spec.colorUnit, this.colorLabel);
            let min = Infinity;
            let max = -Infinity;
            const visit = (node) => {
                if (!node.children.length && isNum(node.color)) {
                    min = Math.min(min, node.color);
                    max = Math.max(max, node.color);
                }
                node.children.forEach(visit);
            };
            visit(this.root);
            this.hasColor = Number.isFinite(min);
            this.colorMin = this.hasColor ? Math.min(0, min) : 0;
            this.colorMax = this.hasColor ? max : 1;
            this.heightSpec = isNum(spec.height) ? clamp(spec.height, 160, 900) : 420;
            this.crumbs = h('div', 'vc-tree-crumbs', this.element);
            this.plot = h('div', 'vc-plot', this.element);
            this.plot.tabIndex = 0;
            this.plot.setAttribute('role', 'group');
            this.plot.setAttribute('aria-roledescription', 'treemap');
            this.plot.setAttribute('aria-label', `${str(spec.title) ?? 'Treemap'}. Arrow keys move between tiles, Enter zooms in, Escape zooms out.`);
            this.svg = s('svg', { class: 'vc-svg' }, this.plot);
            this.layer = s('g', {}, this.svg);
            this.hover = s('rect', { class: 'vc-tile-hover' }, this.svg);
            this.hover.style.opacity = '0';
            this.tip = new Tip(this.plot);
            this.live = h('div', 'vc-sr', this.plot);
            this.live.setAttribute('aria-live', 'polite');
            const foot = h('div', 'vc-tree-foot', this.element);
            if (this.hasColor) {
                const ramp = h('div', 'vc-ramp', foot);
                h('span', '', ramp, formatValue(this.colorMin, this.colorUnit));
                const bar = h('i', '', ramp);
                bar.style.background = `linear-gradient(90deg, ${[0, 0.2, 0.4, 0.6, 0.8, 1].map(t => spectrumColor(t)).join(', ')})`;
                h('span', '', ramp, `${formatValue(this.colorMax, this.colorUnit)}${this.colorLabel ? ` ${this.colorLabel}` : ''}`);
            }
            h('span', 'vc-tree-hint', foot, ctx.strings.zoomHint);
            this.wire();
        }
        fill(node) {
            if (this.hasColor) {
                return isNum(node.color) ? spectrumColor((node.color - this.colorMin) / ((this.colorMax - this.colorMin) || 1)) : 'var(--vc-cold)';
            }
            return PALETTE[node.group % PALETTE.length];
        }
        layout(width) {
            if (width === this.width && this.drawn) {
                return;
            }
            this.width = width;
            this.height = width < 480 ? Math.round(Math.min(this.heightSpec, Math.max(260, width * 0.9))) : this.heightSpec;
            this.element.querySelector('.vc-tree-hint')?.style.setProperty('display', width < 480 ? 'none' : '');
            this.render(!this.drawn && this.ctx.animate);
            this.drawn = true;
        }
        render(animate) {
            const width = this.width;
            const height = this.height;
            setAttrs(this.svg, { width, height, viewBox: `0 0 ${width} ${height}` });
            this.plot.style.height = `${height}px`;
            layoutTree(this.focus, 0, 0, width, height, 0);
            this.layer.replaceChildren();
            this.leaves = [];
            const groups = [];
            const walk = (node, depth) => {
                if (node.x1 - node.x0 < 0.5 || node.y1 - node.y0 < 0.5) {
                    return;
                }
                if (!node.children.length) {
                    this.leaves.push(node);
                    return;
                }
                if (depth > 0) {
                    groups.push(node);
                }
                node.children.forEach(child => walk(child, depth + 1));
            };
            walk(this.focus, 0);
            for (const group of groups) {
                const rect = s('rect', { x: group.x0, y: group.y0, width: group.x1 - group.x0, height: group.y1 - group.y0, rx: 2 }, this.layer);
                rect.style.fill = 'color-mix(in srgb, var(--vc-fg) 4%, transparent)';
            }
            const fills = this.leaves.map(leaf => this.fill(leaf));
            const labelled = this.leaves.map(leaf => leaf.x1 - leaf.x0 > 46 && leaf.y1 - leaf.y0 > 18);
            const rgb = resolveRgb(this.plot, fills.filter((_, index) => labelled[index]));
            let rgbIndex = 0;
            const font = `400 11px ${monoFamily(this.element)}`;
            this.leaves.forEach((leaf, index) => {
                const rect = s('rect', { x: leaf.x0, y: leaf.y0, width: Math.max(0, leaf.x1 - leaf.x0), height: Math.max(0, leaf.y1 - leaf.y0), class: 'vc-tile' }, this.layer);
                rect.style.fill = fills[index];
                if (labelled[index]) {
                    const color = rgb[rgbIndex++];
                    const text = s('text', { x: leaf.x0 + 5, y: leaf.y0 + 13, class: 'vc-tile-label' }, this.layer);
                    text.textContent = ellipsize(leaf.name, font, leaf.x1 - leaf.x0 - 9);
                    text.style.fill = color && luminance(color) > 0.36 ? 'rgba(0,0,0,0.78)' : 'rgba(255,255,255,0.94)';
                }
            });
            const boldFont = `600 11px ${monoFamily(this.element)}`;
            for (const group of groups) {
                if (group.x1 - group.x0 > 46 && group.y1 - group.y0 > GROUP_HEADER * 2.2) {
                    const text = s('text', { x: group.x0 + 5, y: group.y0 + 12.5, class: 'vc-group-label' }, this.layer);
                    text.textContent = ellipsize(group.name.endsWith('/') ? group.name : `${group.name}/`, boldFont, group.x1 - group.x0 - 10);
                }
            }
            if (animate && !reducedMotion()) {
                this.layer.animate?.([{ opacity: 0, transform: 'scale(0.985)' }, { opacity: 1, transform: 'none' }], { duration: 420, easing: EASE_OUT });
            }
            this.renderCrumbs();
            this.deactivate();
        }
        renderCrumbs() {
            this.crumbs.replaceChildren();
            const chain = [];
            for (let node = this.focus; node; node = node.parent) {
                chain.unshift(node);
            }
            chain.forEach((node, index) => {
                if (index > 0) {
                    h('span', '', this.crumbs, '/');
                }
                const label = node.name || 'root';
                if (index === chain.length - 1) {
                    h('span', 'vc-current', this.crumbs, label);
                }
                else {
                    const button = h('button', '', this.crumbs, label);
                    button.type = 'button';
                    button.addEventListener('click', () => this.zoomTo(node));
                }
            });
            this.crumbs.style.display = chain.length > 1 || this.root.name ? '' : 'none';
        }
        /** The child of the focused node on the way to `node`. */
        stepToward(node) {
            let current = node;
            while (current && current.parent !== this.focus) {
                current = current.parent;
            }
            return current;
        }
        zoomTo(target) {
            if (target === this.focus || this.zooming) {
                return;
            }
            const into = target.parent === this.focus || this.isAncestor(this.focus, target);
            if (into && !reducedMotion()) {
                const scaleX = this.width / Math.max(1, target.x1 - target.x0);
                const scaleY = this.height / Math.max(1, target.y1 - target.y0);
                this.zooming = true;
                const animation = this.layer.animate?.([
                    { transform: 'none', transformOrigin: '0 0' },
                    { transform: `scale(${scaleX},${scaleY}) translate(${-target.x0}px,${-target.y0}px)`, transformOrigin: '0 0', opacity: 0.4 },
                ], { duration: 300, easing: EASE_OUT });
                const done = () => {
                    this.zooming = false;
                    this.focus = target;
                    this.render(false);
                    this.layer.animate?.([{ opacity: 0.4 }, { opacity: 1 }], { duration: 160 });
                };
                if (animation) {
                    animation.onfinish = done;
                }
                else {
                    done();
                }
                return;
            }
            this.focus = target;
            this.render(false);
            if (!reducedMotion()) {
                this.layer.animate?.([{ opacity: 0, transform: 'scale(1.03)', transformOrigin: '50% 50%' }, { opacity: 1, transform: 'none', transformOrigin: '50% 50%' }], { duration: 260, easing: EASE_OUT });
            }
        }
        isAncestor(ancestor, node) {
            for (let current = node.parent; current; current = current.parent) {
                if (current === ancestor) {
                    return true;
                }
            }
            return false;
        }
        wire() {
            this.plot.addEventListener('pointermove', event => {
                const rect = this.svg.getBoundingClientRect();
                const leaf = this.leafAt(event.clientX - rect.left, event.clientY - rect.top);
                if (leaf) {
                    this.activate(leaf);
                }
                else {
                    this.deactivate();
                }
            });
            this.plot.addEventListener('pointerleave', () => this.deactivate());
            this.plot.addEventListener('click', event => {
                const rect = this.svg.getBoundingClientRect();
                const leaf = this.leafAt(event.clientX - rect.left, event.clientY - rect.top);
                if (leaf) {
                    this.openOrZoom(leaf);
                }
            });
            this.plot.addEventListener('contextmenu', event => {
                if (this.focus.parent) {
                    event.preventDefault();
                    this.zoomTo(this.focus.parent);
                }
            });
            this.plot.addEventListener('focus', () => {
                if (!this.active && this.leaves.length) {
                    this.activate(this.leaves[0]);
                }
            });
            this.plot.addEventListener('blur', () => this.deactivate());
            this.plot.addEventListener('keydown', event => {
                if (event.key === 'Escape' && this.focus.parent) {
                    event.preventDefault();
                    this.zoomTo(this.focus.parent);
                    return;
                }
                if ((event.key === 'Enter' || event.key === ' ') && this.active) {
                    event.preventDefault();
                    this.openOrZoom(this.active);
                    return;
                }
                const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
                const direction = directions[event.key];
                if (!direction) {
                    return;
                }
                event.preventDefault();
                const from = this.active ?? this.leaves[0];
                if (!from) {
                    return;
                }
                const cx = (from.x0 + from.x1) / 2;
                const cy = (from.y0 + from.y1) / 2;
                let best;
                let bestScore = Infinity;
                for (const leaf of this.leaves) {
                    if (leaf === from) {
                        continue;
                    }
                    const dx = (leaf.x0 + leaf.x1) / 2 - cx;
                    const dy = (leaf.y0 + leaf.y1) / 2 - cy;
                    const along = dx * direction[0] + dy * direction[1];
                    if (along <= 0.5) {
                        continue;
                    }
                    const across = Math.abs(dx * direction[1]) + Math.abs(dy * direction[0]);
                    const score = along + across * 2;
                    if (score < bestScore) {
                        bestScore = score;
                        best = leaf;
                    }
                }
                if (best) {
                    this.activate(best);
                    this.live.textContent = this.describe(best);
                }
            });
        }
        openOrZoom(leaf) {
            const step = this.stepToward(leaf);
            if (step && step.children.length) {
                this.zoomTo(step);
            }
            else if (leaf.href) {
                this.ctx.onOpen?.(leaf.href);
            }
        }
        leafAt(x, y) {
            for (const leaf of this.leaves) {
                if (x >= leaf.x0 && x < leaf.x1 && y >= leaf.y0 && y < leaf.y1) {
                    return leaf;
                }
            }
            return undefined;
        }
        describe(leaf) {
            const parts = [leaf.path, `${formatValue(leaf.value, this.sizeUnit)}${this.sizeLabel ? ` ${this.sizeLabel}` : ''}`];
            if (isNum(leaf.color)) {
                parts.push(`${formatValue(leaf.color, this.colorUnit)}${this.colorLabel ? ` ${this.colorLabel}` : ''}`);
            }
            return parts.join(', ');
        }
        activate(leaf) {
            if (this.active !== leaf) {
                this.active = leaf;
                setAttrs(this.hover, { x: leaf.x0 + 0.75, y: leaf.y0 + 0.75, width: Math.max(0, leaf.x1 - leaf.x0 - 1.5), height: Math.max(0, leaf.y1 - leaf.y0 - 1.5) });
                const sizeText = `${formatValue(leaf.value, this.sizeUnit)}${this.sizeLabel ? ` ${this.sizeLabel}` : ''}`;
                const colorText = isNum(leaf.color) ? `${formatValue(leaf.color, this.colorUnit)}${this.colorLabel ? ` ${this.colorLabel}` : ''}` : undefined;
                const step = this.stepToward(leaf);
                this.tip.set({
                    title: leaf.path,
                    sub: colorText ? `${sizeText} · ${colorText}` : sizeText,
                    meta: leaf.detail,
                    hint: step && step.children.length ? undefined : leaf.href ? this.ctx.strings.open : undefined,
                });
            }
            this.hover.style.opacity = '1';
            this.tip.show();
            this.tip.place((leaf.x0 + leaf.x1) / 2, (leaf.y0 + leaf.y1) / 2, this.width, 0, this.height, Math.min(40, (leaf.x1 - leaf.x0) / 2) + 6);
            this.svg.style.cursor = leaf.href || this.stepToward(leaf)?.children.length ? 'pointer' : '';
        }
        deactivate() {
            this.active = undefined;
            this.hover.style.opacity = '0';
            this.tip.hide();
        }
        dispose() {
            this.tip.dispose();
        }
    }
    function readParts(raw, problems, where) {
        const list = (Array.isArray(raw) ? raw : []).filter(isRecord).slice(0, 500);
        if (!list.length) {
            problems.push(`${where}: give "data": [{ "label": "...", "value": 12 }].`);
        }
        return list.flatMap((item, index) => {
            const label = str(item.label ?? item.name, 200);
            const value = isNum(item.value) ? item.value : Number.NaN;
            if (!label || !Number.isFinite(value)) {
                problems.push(`${where}: item ${index + 1} needs a "label" and a numeric "value".`);
                return [];
            }
            return [{ label, value, color: seriesColor(item.color, index, label), href: safeHref(item.href), detail: str(item.detail, 200) }];
        });
    }
    function arcPath(cx, cy, outer, inner, start, end) {
        const sweep = Math.max(0, end - start);
        if (sweep >= Math.PI * 2 - 1e-6) {
            return `M${num(cx + outer)},${num(cy)}A${num(outer)},${num(outer)} 0 1 1 ${num(cx - outer)},${num(cy)}A${num(outer)},${num(outer)} 0 1 1 ${num(cx + outer)},${num(cy)}M${num(cx + inner)},${num(cy)}A${num(inner)},${num(inner)} 0 1 0 ${num(cx - inner)},${num(cy)}A${num(inner)},${num(inner)} 0 1 0 ${num(cx + inner)},${num(cy)}Z`;
        }
        const large = sweep > Math.PI ? 1 : 0;
        const p = (radius, angle) => `${num(cx + radius * Math.cos(angle))},${num(cy + radius * Math.sin(angle))}`;
        return `M${p(outer, start)}A${num(outer)},${num(outer)} 0 ${large} 1 ${p(outer, end)}L${p(inner, end)}A${num(inner)},${num(inner)} 0 ${large} 0 ${p(inner, start)}Z`;
    }
    class DonutBlock {
        constructor(parent, spec, ctx, problems, where) {
            this.ctx = ctx;
            this.arcs = [];
            this.items = [];
            this.active = -1;
            this.size = 0;
            this.drawn = false;
            this.element = h('div', 'vc-block', parent);
            blockHead(this.element, spec.title, spec.subtitle);
            this.parts = readParts(spec.data, problems, where).filter(part => part.value > 0).sort((a, b) => b.value - a.value);
            if (this.parts.length > 12) {
                const rest = this.parts.splice(11);
                this.parts.push({ label: ctx.strings.other, value: rest.reduce((sum, part) => sum + part.value, 0), color: 'var(--vc-other)' });
            }
            this.total = this.parts.reduce((sum, part) => sum + part.value, 0);
            this.unit = resolveUnit(spec.unit, `${str(spec.title) ?? ''} ${str(spec.subtitle) ?? ''}`, this.parts.map(part => part.value));
            this.centerText = str(spec.centerLabel, 40) ?? ctx.strings.total;
            const wrap = h('div', 'vc-donut', this.element);
            this.svg = s('svg', { role: 'img' }, wrap);
            this.list = h('div', 'vc-donut-list', wrap);
            this.list.setAttribute('role', 'list');
            this.centerValue = s('text', { class: 'vc-donut-center-value', 'text-anchor': 'middle' });
            this.centerLabel = s('text', { class: 'vc-donut-center-label', 'text-anchor': 'middle' });
            this.parts.forEach((part, index) => {
                const item = h('div', 'vc-donut-item', this.list);
                item.tabIndex = 0;
                item.setAttribute('role', 'listitem');
                const swatch = h('span', 'vc-swatch', item);
                swatch.style.background = part.color;
                h('span', 'vc-tip-name', item, part.label);
                h('span', 'vc-tip-value', item, `${formatValue(part.value, this.unit)}  ${formatPercent((part.value / (this.total || 1)) * 100)}`);
                item.addEventListener('pointerenter', () => this.setActive(index));
                item.addEventListener('pointerleave', () => this.setActive(-1));
                item.addEventListener('focus', () => this.setActive(index));
                item.addEventListener('blur', () => this.setActive(-1));
                item.addEventListener('click', () => part.href && this.ctx.onOpen?.(part.href));
                item.addEventListener('keydown', event => {
                    if (event.key === 'Enter' && part.href) {
                        this.ctx.onOpen?.(part.href);
                    }
                    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                        event.preventDefault();
                        this.items[clamp(index + (event.key === 'ArrowDown' ? 1 : -1), 0, this.items.length - 1)]?.focus();
                    }
                });
                this.items.push(item);
            });
            this.svg.setAttribute('aria-label', this.parts.map(part => `${part.label} ${formatPercent((part.value / (this.total || 1)) * 100)}`).join(', '));
        }
        layout(width) {
            const size = Math.round(clamp(width < 440 ? width * 0.52 : 184, 120, 220));
            if (size === this.size && this.drawn) {
                return;
            }
            this.size = size;
            setAttrs(this.svg, { width: size, height: size, viewBox: `0 0 ${size} ${size}` });
            this.svg.replaceChildren();
            this.arcs = this.parts.map(part => {
                const arc = s('path', { class: 'vc-arc' }, this.svg);
                arc.style.fill = part.color;
                return arc;
            });
            this.arcs.forEach((arc, index) => {
                arc.addEventListener('pointerenter', () => this.setActive(index));
                arc.addEventListener('pointerleave', () => this.setActive(-1));
                arc.addEventListener('click', () => this.parts[index].href && this.ctx.onOpen?.(this.parts[index].href));
            });
            this.svg.appendChild(this.centerValue);
            this.svg.appendChild(this.centerLabel);
            setAttrs(this.centerValue, { x: size / 2, y: size / 2 + 2 });
            setAttrs(this.centerLabel, { x: size / 2, y: size / 2 + 19 });
            this.renderCenter();
            const animate = !this.drawn && this.ctx.animate;
            this.animation?.cancel();
            this.animation = tween(animate ? 620 : 0, t => this.draw(t));
            this.drawn = true;
        }
        draw(progress) {
            const size = this.size;
            const outer = size / 2 - 4;
            const inner = outer * 0.66;
            const pad = this.parts.length > 1 ? 0.012 : 0;
            let angle = -Math.PI / 2;
            const full = Math.PI * 2 * progress;
            this.parts.forEach((part, index) => {
                const sweep = (part.value / (this.total || 1)) * full;
                const start = angle + pad / 2;
                const end = angle + sweep - pad / 2;
                this.arcs[index].setAttribute('d', arcPath(size / 2, size / 2, outer, inner, start, Math.max(start, end)));
                const mid = (start + end) / 2;
                this.arcs[index].dataset.dx = String(Math.cos(mid) * 3);
                this.arcs[index].dataset.dy = String(Math.sin(mid) * 3);
                angle += sweep;
            });
        }
        renderCenter() {
            const part = this.parts[this.active];
            this.centerValue.textContent = part ? formatPercent((part.value / (this.total || 1)) * 100) : formatValue(this.total, this.unit);
            this.centerLabel.textContent = part ? ellipsize(part.label, '400 11px system-ui', this.size * 0.5) : this.centerText;
        }
        setActive(index) {
            this.active = index;
            this.arcs.forEach((arc, at) => {
                arc.style.opacity = index < 0 || at === index ? '' : '0.32';
                arc.style.transform = at === index ? `translate(${arc.dataset.dx}px,${arc.dataset.dy}px)` : '';
            });
            this.items.forEach((item, at) => item.classList.toggle('vc-active', at === index));
            this.renderCenter();
        }
        dispose() {
            this.animation?.cancel();
        }
    }
    /** A ranked list with bars: hottest files, top models, slowest tools. */
    class RankedBlock {
        constructor(parent, spec, ctx, problems, where) {
            this.ctx = ctx;
            this.expanded = false;
            this.drawn = false;
            this.width = 0;
            this.element = h('div', 'vc-block', parent);
            blockHead(this.element, spec.title, spec.subtitle);
            this.parts = readParts(spec.data, problems, where).sort((a, b) => b.value - a.value);
            this.unit = resolveUnit(spec.unit, `${str(spec.title) ?? ''} ${str(spec.subtitle) ?? ''}`, this.parts.map(part => part.value));
            this.limit = isNum(spec.limit) ? clamp(Math.round(spec.limit), 1, 500) : 10;
            this.heat = spec.color === 'heat' || spec.colors === 'heat';
            this.mono = spec.mono === true || (spec.mono !== false && this.parts.length > 0 && this.parts.every(part => /[/\\.]/.test(part.label) && !/\s/.test(part.label)));
            this.grid = h('div', `vc-ranked${this.mono ? ' vc-mono' : ''}`, this.element);
            this.grid.setAttribute('role', 'list');
            this.tip = new Tip(this.element);
        }
        layout(width) {
            if (this.drawn && width === this.width) {
                return;
            }
            this.width = width;
            this.render(!this.drawn && this.ctx.animate);
            this.drawn = true;
        }
        render(animate) {
            this.grid.replaceChildren();
            this.element.querySelector('.vc-more')?.remove();
            const max = Math.max(...this.parts.map(part => Math.abs(part.value)), 0) || 1;
            const shown = this.expanded ? this.parts : this.parts.slice(0, this.limit);
            const font = this.mono ? `400 12px ${monoFamily(this.element)}` : `400 13px ${win.getComputedStyle(this.element).fontFamily || 'system-ui'}`;
            shown.forEach((part, index) => {
                const row = h('div', `vc-ranked-row${part.href ? ' vc-link' : ''}`, this.grid);
                row.setAttribute('role', 'listitem');
                row.tabIndex = 0;
                const label = h('span', 'vc-ranked-label', row);
                const slash = this.mono ? Math.max(part.label.lastIndexOf('/'), part.label.lastIndexOf('\\')) : -1;
                if (slash > 0) {
                    h('span', 'vc-dir', label, part.label.slice(0, slash + 1));
                    label.append(part.label.slice(slash + 1));
                }
                else {
                    label.textContent = part.label;
                }
                label.title = part.label;
                const barCell = h('span', 'vc-ranked-bar', row);
                const bar = h('i', '', barCell);
                const share = Math.abs(part.value) / max;
                bar.style.width = `${Math.max(1.5, share * 100)}%`;
                bar.style.background = this.heat ? spectrumColor(0.35 + share * 0.65) : part.color === PALETTE[index % PALETTE.length] ? 'var(--vc-accent)' : part.color;
                if (animate && !reducedMotion()) {
                    bar.style.transform = 'scaleX(0)';
                    bar.style.transitionDelay = `${index * 24}ms`;
                    win.requestAnimationFrame(() => win.requestAnimationFrame(() => bar.style.transform = ''));
                }
                h('span', 'vc-ranked-value', row, formatValue(part.value, this.unit));
                const open = () => part.href && this.ctx.onOpen?.(part.href);
                row.addEventListener('click', open);
                row.addEventListener('keydown', event => {
                    if (event.key === 'Enter') {
                        open();
                    }
                    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                        event.preventDefault();
                        const rows = this.grid.querySelectorAll('.vc-ranked-row');
                        rows[clamp(index + (event.key === 'ArrowDown' ? 1 : -1), 0, rows.length - 1)]?.focus();
                    }
                });
                if (part.detail || textWidth(part.label, font) > label.clientWidth) {
                    row.addEventListener('pointerenter', () => {
                        this.tip.set({ title: part.label, hero: formatValue(part.value, this.unit, true), sub: part.detail, hint: part.href ? this.ctx.strings.open : undefined });
                        this.tip.show();
                        const hostRect = this.element.getBoundingClientRect();
                        const rowRect = label.getBoundingClientRect();
                        this.tip.place(rowRect.left - hostRect.left + Math.min(rowRect.width, 220), rowRect.top - hostRect.top + rowRect.height / 2, this.width, 0, this.element.clientHeight);
                    });
                    row.addEventListener('pointerleave', () => this.tip.hide());
                }
            });
            if (this.parts.length > this.limit) {
                const more = h('button', 'vc-more', this.element, this.expanded ? this.ctx.strings.showLess : `${this.ctx.strings.showAll} ${this.parts.length}`);
                more.type = 'button';
                more.addEventListener('click', () => {
                    this.expanded = !this.expanded;
                    this.render(false);
                });
            }
        }
        dispose() {
            this.tip.dispose();
        }
    }
    //#endregion
    //#region Cumulative share (Lorenz curve)
    /** Turns per-entity values into a cumulative-share line chart with callouts at the marks. */
    function cumulativeSpec(spec, problems, where) {
        const values = (Array.isArray(spec.values) ? spec.values : []).filter(isNum).filter(value => value >= 0).sort((a, b) => b - a);
        if (!values.length) {
            problems.push(`${where}: cumulative charts need "values": one non-negative number per ${str(spec.entity) ?? 'entity'}.`);
        }
        const entity = str(spec.entity, 40) ?? 'items';
        const measure = str(spec.measure, 40) ?? 'the total';
        const n = values.length;
        const prefix = [0];
        for (const value of values) {
            prefix.push(prefix[prefix.length - 1] + value);
        }
        const total = prefix[n] || 1;
        const shareAt = (fraction) => {
            const exact = fraction * n;
            const lo = Math.floor(exact);
            const hi = Math.min(n, lo + 1);
            return ((prefix[lo] + (prefix[hi] - prefix[lo]) * (exact - lo)) / total) * 100;
        };
        const samples = Math.min(400, Math.max(2, n + 1));
        const data = [];
        for (let index = 0; index < samples; index++) {
            const fraction = index / (samples - 1);
            data.push([fraction * 100, shareAt(fraction)]);
        }
        const marks = (Array.isArray(spec.marks) ? spec.marks.filter(isNum) : [0.01, 0.1, 0.25]).filter(mark => mark > 0 && mark < 1 && mark * n >= 1).slice(0, 5);
        const callouts = marks.map(mark => {
            const share = shareAt(mark);
            return { x: mark * 100, y: share, label: `top ${formatPercent(mark * 100)} → ${Math.round(share)}%` };
        });
        const lead = marks.find(mark => mark >= 0.1) ?? marks[0];
        return {
            spec: {
                type: 'line',
                height: spec.height ?? 260,
                title: spec.title ?? (lead !== undefined ? `The top ${formatPercent(lead * 100)} of ${entity} account for ${Math.round(shareAt(lead))}% of ${measure}` : undefined),
                subtitle: spec.subtitle ?? `Cumulative share of ${measure}, ${entity} sorted from heaviest to lightest. The diagonal is equal use.`,
                note: spec.note,
                x: { type: 'number', unit: 'percent', label: `of ${entity}` },
                y: { unit: 'percent', min: 0, max: 100 },
                series: [
                    { name: `Share of ${measure}`, data, color: spec.color ?? 'accent' },
                    { name: 'Equal use', data: [[0, 0], [100, 100]], reference: true, color: 'muted' },
                ],
                callouts,
                legend: false,
                points: false,
            },
            tooltip: point => ({ title: `Top ${formatPercent(point.x)} of ${entity}`, hero: `${numberFormat(0, 1).format(point.y)}%`, sub: `of ${measure}` }),
        };
    }
    //#endregion
    //#region Rows, the visual and its blocks
    class RowBlock {
        constructor(parent, spec, ctx, problems, where) {
            this.element = h('div', 'vc-block', parent);
            blockHead(this.element, spec.title, spec.subtitle);
            const grid = h('div', 'vc-row', this.element);
            const charts = (Array.isArray(spec.charts) ? spec.charts : []).filter(isRecord).slice(0, 6);
            if (!charts.length) {
                problems.push(`${where}: rows need "charts": [ ... ].`);
            }
            this.children = charts.map((chart, index) => createBlock(grid, chart, ctx, problems, `${where}.charts[${index}]`));
        }
        layout() {
            for (const child of this.children) {
                child.layout(Math.floor(child.element.clientWidth));
            }
        }
        setLoading(loading) {
            for (const child of this.children) {
                child.setLoading?.(loading);
            }
        }
        dispose() {
            for (const child of this.children) {
                child.dispose();
            }
        }
    }
    const TYPE_ALIASES = {
        pie: 'donut', ring: 'donut', 'bars-h': 'ranked', hbar: 'ranked', list: 'ranked', top: 'ranked', lorenz: 'cumulative', pareto: 'cumulative',
        grid: 'row', columns: 'row', kpi: 'stats', kpis: 'stats', numbers: 'stats', columnchart: 'bar', column: 'bar', 'stacked': 'stacked-area', 'stacked-column': 'stacked-bar',
        '100%': 'share', percent: 'share', 'area-share': 'share', dots: 'scatter', bubble: 'scatter', sessions: 'scatter', 'grouped': 'grouped-bar', calendar: 'heatmap', matrix: 'heatmap',
    };
    /** The chart type: what the spec says, or what its data looks like. */
    function chartType(spec) {
        const declared = typeof spec.type === 'string' ? spec.type.toLowerCase().trim() : '';
        if (declared) {
            return TYPE_ALIASES[declared] ?? declared;
        }
        if (Array.isArray(spec.items)) {
            return 'stats';
        }
        if (Array.isArray(spec.charts)) {
            return 'row';
        }
        if (Array.isArray(spec.rows) && Array.isArray(spec.columns)) {
            return 'heatmap';
        }
        if (Array.isArray(spec.values) && !spec.series) {
            return 'cumulative';
        }
        if (isRecord(spec.data) || (Array.isArray(spec.data) && spec.data.some(item => isRecord(item) && Array.isArray(item.children)))) {
            return 'treemap';
        }
        if (Array.isArray(spec.data)) {
            return 'ranked';
        }
        return Array.isArray(spec.categories) ? 'bar' : 'line';
    }
    function createBlock(parent, spec, ctx, problems, where) {
        const type = chartType(spec);
        switch (type) {
            case 'stats': return new StatsBlock(parent, spec, ctx, problems, where);
            case 'heatmap': return new HeatmapBlock(parent, spec, ctx, problems, where);
            case 'treemap': return new TreemapBlock(parent, spec, ctx, problems, where);
            case 'donut': return new DonutBlock(parent, spec, ctx, problems, where);
            case 'ranked': return new RankedBlock(parent, spec, ctx, problems, where);
            case 'row': return new RowBlock(parent, spec, ctx, problems, where);
            case 'cumulative': {
                const { spec: lineSpec, tooltip } = cumulativeSpec(spec, problems, where);
                return new CartesianChart(parent, lineSpec, ctx, problems, where, tooltip);
            }
            default:
                if (!CARTESIAN_TYPES.includes(type)) {
                    problems.push(`${where}: unknown chart type "${type}". Use one of: ${[...CARTESIAN_TYPES, 'heatmap', 'treemap', 'donut', 'ranked', 'cumulative', 'stats', 'row'].join(', ')}.`);
                }
                return new CartesianChart(parent, { ...spec, type: CARTESIAN_TYPES.includes(type) ? type : (spec.series || spec.metrics ? 'line' : type) }, ctx, problems, where);
        }
    }
    function parseVisual(input, problems) {
        let value = input;
        if (typeof value === 'string') {
            try {
                value = JSON.parse(value);
            }
            catch {
                problems.push('The visual is not valid JSON.');
                return { charts: [] };
            }
        }
        if (Array.isArray(value)) {
            return { charts: value.filter(isRecord) };
        }
        if (!isRecord(value)) {
            problems.push('Pass a chart spec object, or { "charts": [ ... ] }.');
            return { charts: [] };
        }
        if (Array.isArray(value.charts) && (value.type === undefined || value.type === 'visual' || value.type === 'dashboard')) {
            const charts = value.charts.filter(isRecord).slice(0, 24);
            if (!charts.length) {
                problems.push('"charts" is empty.');
            }
            return { title: str(value.title, 160), subtitle: str(value.subtitle, 300), charts };
        }
        return { charts: [value] };
    }
    class Visual {
        constructor(container, input, ctx) {
            this.ctx = ctx;
            this.blocks = [];
            this.types = [];
            this.width = 0;
            this.frame = 0;
            this.disposed = false;
            this.loading = false;
            ensureStyles(container.ownerDocument);
            this.element = ctx.root;
            this.element.classList.add('vc-root');
            container.appendChild(this.element);
            this.head = h('div', 'vc-visual-head', this.element);
            this.body = h('div', 'vc-blocks', this.element);
            this.setInput(input, []);
            this.syncTheme();
            if (typeof win.ResizeObserver === 'function') {
                this.observer = new win.ResizeObserver(() => this.schedule());
                this.observer.observe(this.element);
            }
            const themeTarget = container.closest('.monaco-workbench') ?? container.ownerDocument.body;
            if (themeTarget && typeof win.MutationObserver === 'function') {
                this.themeObserver = new win.MutationObserver(() => this.syncTheme());
                this.themeObserver.observe(themeTarget, { attributes: true, attributeFilter: ['class'] });
            }
            this.schedule();
        }
        syncTheme() {
            this.element.classList.toggle('vc-light', isLightTheme(this.element));
        }
        setInput(input, problems) {
            const visual = parseVisual(input, problems);
            this.head.replaceChildren();
            const title = visual.title;
            const subtitle = visual.subtitle;
            if (title) {
                h('div', 'vc-visual-title', this.head, title).setAttribute('role', 'heading');
            }
            if (subtitle) {
                h('div', 'vc-visual-subtitle', this.head, subtitle);
            }
            this.head.style.display = title || subtitle ? '' : 'none';
            const types = visual.charts.map(chartType);
            const reuse = types.length === this.types.length && types.every((type, index) => type === this.types[index]);
            if (reuse) {
                visual.charts.forEach((chart, index) => {
                    const block = this.blocks[index];
                    if (block instanceof CartesianChart && types[index] !== 'cumulative') {
                        block.setSpec({ ...chart, type: CARTESIAN_TYPES.includes(types[index]) ? types[index] : 'line' }, problems, `charts[${index}]`);
                    }
                    else {
                        const next = createBlock(this.body, chart, this.ctx, problems, `charts[${index}]`);
                        this.body.replaceChild(next.element, block.element);
                        block.dispose();
                        this.blocks[index] = next;
                        if (this.width) {
                            next.layout(this.width);
                        }
                    }
                });
            }
            else {
                for (const block of this.blocks) {
                    block.dispose();
                }
                this.body.replaceChildren();
                this.blocks = visual.charts.map((chart, index) => createBlock(this.body, chart, this.ctx, problems, `charts[${index}]`));
                this.types = types;
                this.width = 0;
            }
            if (this.loading) {
                for (const block of this.blocks) {
                    block.setLoading?.(true);
                }
            }
            this.element.setAttribute('role', 'figure');
            this.element.setAttribute('aria-label', title ?? visual.charts.map(chart => str(chart.title)).filter(Boolean).join('; ') ?? this.ctx.strings.chart);
        }
        schedule() {
            if (this.frame || this.disposed) {
                return;
            }
            this.frame = win.requestAnimationFrame(() => {
                this.frame = 0;
                this.layout();
            });
        }
        layout() {
            if (this.disposed) {
                return;
            }
            const width = Math.floor(this.element.clientWidth);
            if (!width) {
                return;
            }
            const changed = width !== this.width;
            this.width = width;
            for (const block of this.blocks) {
                block.layout(changed ? width : Math.floor(block.element.clientWidth) || width);
            }
            this.ctx.animate = false;
        }
        update(input, animate = true) {
            this.ctx.animate = animate;
            this.setInput(input, []);
            this.width = 0;
            this.layout();
            this.ctx.animate = false;
        }
        setLoading(loading) {
            this.loading = loading;
            this.element.classList.toggle('vc-loading', loading);
            for (const block of this.blocks) {
                block.setLoading?.(loading);
            }
        }
        dispose() {
            this.disposed = true;
            if (this.frame) {
                win.cancelAnimationFrame(this.frame);
            }
            this.observer?.disconnect();
            this.themeObserver?.disconnect();
            for (const block of this.blocks) {
                block.dispose();
            }
            this.blocks = [];
            this.element.remove();
        }
    }
    //#endregion
    //#region API
    function flattenCharts(charts) {
        return charts.flatMap(chart => chartType(chart) === 'row' && Array.isArray(chart.charts) ? flattenCharts(chart.charts.filter(isRecord)) : [chart]);
    }
    /** How many values a chart would draw. */
    function countData(spec) {
        const finite = (list) => Array.isArray(list) ? list.filter(isNum).length : 0;
        switch (chartType(spec)) {
            case 'stats':
                return Array.isArray(spec.items) ? spec.items.filter(isRecord).length : 0;
            case 'heatmap':
                return Array.isArray(spec.values) ? spec.values.reduce((sum, row) => sum + finite(row), 0) : 0;
            case 'treemap': {
                const leaves = (node) => !isRecord(node) ? 0 : Array.isArray(node.children) && node.children.length ? node.children.reduce((sum, child) => sum + leaves(child), 0) : (isNum(node.value) && node.value > 0 ? 1 : 0);
                return Array.isArray(spec.data) ? spec.data.reduce((sum, node) => sum + leaves(node), 0) : leaves(spec.data);
            }
            case 'donut':
            case 'ranked':
                return Array.isArray(spec.data) ? spec.data.filter(item => isRecord(item) && isNum(item.value)).length : 0;
            case 'cumulative':
                return finite(spec.values);
            case 'row':
                return Array.isArray(spec.charts) ? spec.charts.filter(isRecord).reduce((sum, chart) => sum + countData(chart), 0) : 0;
            default: {
                const model = parseCartesian(spec, [], '');
                return model.metrics.reduce((sum, metric) => sum + metric.series.reduce((count, series) => count + series.points.filter(point => Number.isFinite(point.y)).length, 0), 0);
            }
        }
    }
    function inspect(input) {
        const problems = [];
        const visual = parseVisual(input, problems);
        const host = doc.createElement('div');
        const ctx = { strings: DEFAULT_STRINGS, animate: false, root: host };
        let points = 0;
        visual.charts.forEach((chart, index) => {
            createBlock(host, chart, ctx, problems, `charts[${index}]`).dispose();
            const count = countData(chart);
            if (!count) {
                problems.push(`charts[${index}]${typeof chart.title === 'string' ? ` ("${chart.title}")` : ''}: has no values to draw.`);
            }
            points += count;
        });
        return { problems: [...new Set(problems)], charts: visual.charts.length, points };
    }
    function csvCell(value) {
        const text = value === undefined || value === null || (typeof value === 'number' && !Number.isFinite(value)) ? '' : String(value);
        return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    }
    function toCsv(input) {
        const visual = parseVisual(input, []);
        const out = [];
        const table = (title, rows) => {
            if (out.length) {
                out.push('');
            }
            const name = str(title, 160);
            if (name) {
                out.push(`# ${name}`);
            }
            for (const row of rows) {
                out.push(row.map(csvCell).join(','));
            }
        };
        for (const chart of flattenCharts(visual.charts)) {
            const type = chartType(chart);
            if (type === 'stats') {
                table(chart.title, [['label', 'value'], ...(Array.isArray(chart.items) ? chart.items.filter(isRecord).map(item => [item.label, item.value]) : [])]);
            }
            else if (type === 'heatmap') {
                const columns = Array.isArray(chart.columns) ? chart.columns : [];
                const rows = Array.isArray(chart.rows) ? chart.rows : [];
                const values = Array.isArray(chart.values) ? chart.values : [];
                table(chart.title, [['', ...columns], ...rows.map((row, index) => [row, ...(Array.isArray(values[index]) ? values[index] : [])])]);
            }
            else if (type === 'treemap') {
                const root = readTree(chart.data, [], '');
                const rows = [['path', 'value', 'color']];
                const walk = (node) => node.children.length ? node.children.forEach(walk) : rows.push([node.path, node.value, node.color]);
                walk(root);
                table(chart.title, rows);
            }
            else if (type === 'donut' || type === 'ranked') {
                table(chart.title, [['label', 'value'], ...readParts(chart.data, [], '').map(part => [part.label, part.value])]);
            }
            else if (type === 'cumulative') {
                const values = (Array.isArray(chart.values) ? chart.values : []).filter(isNum).sort((a, b) => b - a);
                table(chart.title, [['rank', 'value'], ...values.map((value, index) => [index + 1, value])]);
            }
            else {
                const model = parseCartesian({ ...chart, type: CARTESIAN_TYPES.includes(type) ? type : 'line' }, [], '');
                for (const metric of model.metrics) {
                    const xs = [...new Set(metric.series.flatMap(series => series.points.map(point => point.x)))].sort((a, b) => a - b);
                    const header = ['x', ...metric.series.map(series => series.name)];
                    const lookup = metric.series.map(series => new Map(series.points.map(point => [point.x, point.y])));
                    const label = (x) => model.xKind === 'time' ? new Date(x).toISOString() : model.xKind === 'category' ? model.categories[x] : x;
                    table(model.metrics.length > 1 ? `${str(chart.title) ?? ''} · ${metric.label}` : chart.title, [header, ...xs.map(x => [label(x), ...lookup.map(map => map.get(x))])]);
                }
            }
        }
        return out.join('\n');
    }
    function describe(input) {
        const visual = parseVisual(input, []);
        const lines = flattenCharts(visual.charts).map(chart => {
            const type = chartType(chart);
            const title = str(chart.title, 160);
            let detail = '';
            if (type === 'stats') {
                detail = (Array.isArray(chart.items) ? chart.items.filter(isRecord) : []).map(item => `${str(item.label) ?? ''} ${isNum(item.value) ? formatValue(item.value, resolveUnit(item.unit, str(item.label))) : str(item.value) ?? ''}`).join(', ');
            }
            else if (CARTESIAN_TYPES.includes(type) || type === 'line') {
                const metrics = Array.isArray(chart.metrics) ? chart.metrics.filter(isRecord) : [{ series: chart.series }];
                detail = metrics.flatMap(metric => (Array.isArray(metric.series) ? metric.series : []).filter(isRecord).map(series => str(series.name) ?? '')).filter(Boolean).join(', ');
            }
            return `${title ?? type}${detail ? ` (${type}: ${detail})` : ` (${type})`}`;
        });
        return [str(visual.title, 160), ...lines].filter(Boolean).join('\n');
    }
    function render(container, visual, options) {
        if (options?.locale) {
            locale = options.locale;
        }
        const ctx = {
            strings: { ...DEFAULT_STRINGS, ...options?.strings },
            onOpen: options?.onOpen,
            animate: options?.animate !== false,
            root: doc.createElement('div'),
        };
        return new Visual(container, visual, ctx);
    }
    function mountAll(root = doc, options) {
        const handles = [];
        for (const script of Array.from(root.querySelectorAll('script[type="application/volt-chart+json"]'))) {
            if (script.dataset.vcMounted) {
                continue;
            }
            script.dataset.vcMounted = '1';
            const host = doc.createElement('div');
            host.className = script.className;
            script.after(host);
            handles.push(render(host, script.textContent ?? '', options));
        }
        for (const element of Array.from(root.querySelectorAll('[data-volt-chart]'))) {
            if (element.dataset.vcMounted || element instanceof HTMLScriptElement) {
                continue;
            }
            element.dataset.vcMounted = '1';
            const source = element.getAttribute('data-volt-chart') || element.textContent || '';
            element.textContent = '';
            handles.push(render(element, source, options));
        }
        return handles;
    }
    const api = { version: VERSION, render, validate: input => inspect(input).problems, inspect, toCsv, describe, mountAll };
    return api;
    //#endregion
}
