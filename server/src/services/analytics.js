/**
 * Range analytics for the dashboard.
 * App time and website time are kept separate (different session tables).
 *
 * Duration rules (shared by Overview, charts, briefing, reports, manager):
 * 1. Clip sessions to the selected [from, to] range.
 * 2. Open sessions end at min(now, collector activity ceiling).
 *    If Mac/Chrome has been silent longer than COLLECTOR_STALE_MS, the ceiling
 *    freezes at last_*_event_at so orphan open rows cannot grow for hours/days.
 * 3. Overlapping intervals for the same metric are merged (exclusive union).
 * 4. App and browser totals are never added together in Overview metrics.
 * 5. System lock-screen apps (loginwindow, screensaver) are excluded from app time.
 */

const DEV_BUNDLES = [
  'com.todesktop', // Cursor
  'com.microsoft.VSCode',
  'com.apple.dt.Xcode',
  'com.apple.Terminal',
  'com.googlecode.iterm2',
  'com.jetbrains',
  'com.github.Atom',
  'com.sublimetext',
  'dev.warp.Warp-Stable',
  'com.apple.dt.Instruments',
];

const COMM_BUNDLES = [
  'com.tinyspeck.slackmacgap',
  'com.apple.MobileSMS',
  'com.apple.mail',
  'com.microsoft.teams',
  'us.zoom.xos',
  'com.hnc.Discord',
  'com.apple.FaceTime',
  'net.whatsapp.WhatsApp',
  'com.apple.iChat',
];

const BROWSER_BUNDLES = [
  'com.google.Chrome',
  'com.apple.Safari',
  'org.mozilla.firefox',
  'com.microsoft.edgemac',
  'company.thebrowser.Browser', // Arc
  'com.brave.Browser',
  'com.operasoftware.Opera',
];

const COMM_DOMAINS = [
  'mail.google.com',
  'outlook.live.com',
  'outlook.office.com',
  'teams.microsoft.com',
  'teams.cloud.microsoft',
  'slack.com',
  'web.whatsapp.com',
  'discord.com',
  'zoom.us',
];

const DEV_DOMAINS = [
  'github.com',
  'gitlab.com',
  'stackoverflow.com',
  'localhost',
  '127.0.0.1',
  'developer.apple.com',
  'npmjs.com',
];

/** If a collector is silent longer than this, open sessions freeze at last activity. */
export const COLLECTOR_STALE_MS = 15 * 60 * 1000;

/** Lock screen / saver — not countable "tracked app" time. */
export const SYSTEM_EXCLUDED_APP_BUNDLES = [
  'com.apple.loginwindow',
  'com.apple.ScreenSaver.engine',
  'com.apple.screensaver',
];

export const SYSTEM_EXCLUDED_APP_NAMES = [
  'loginwindow',
  'screensaverengine',
  'screen saver',
];

export function parseRange({ from, to, now = Date.now() } = {}) {
  const end = to ? Date.parse(to) : now;
  const start = from ? Date.parse(from) : end - 24 * 60 * 60 * 1000;
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    throw new Error('invalid_range');
  }
  return {
    fromMs: start,
    toMs: end,
    fromIso: new Date(start).toISOString(),
    toIso: new Date(end).toISOString(),
    nowMs: now,
  };
}

/**
 * Open-session growth ceiling from last collector activity.
 * Fresh collector → now; stale collector → freeze at last event time.
 */
export function activityCeilingMs(lastActivityIso, nowMs, staleMs = COLLECTOR_STALE_MS) {
  if (lastActivityIso == null || lastActivityIso === '') return nowMs;
  const last = Date.parse(lastActivityIso);
  if (Number.isNaN(last)) return nowMs;
  if (nowMs - last > staleMs) return last;
  return nowMs;
}

export function isSystemExcludedApp(session) {
  const bid = session.bundle_identifier || '';
  const name = (session.app_name || '').toLowerCase();
  if (SYSTEM_EXCLUDED_APP_BUNDLES.some((b) => bid === b || bid.startsWith(`${b}.`))) return true;
  if (SYSTEM_EXCLUDED_APP_NAMES.includes(name)) return true;
  return false;
}

export function shouldCountAppSession(session, { excludedBundles = [], excludedNames = [] } = {}) {
  if (!session) return false;
  if (Number(session.was_idle) === 1) return false;
  if (isSystemExcludedApp(session)) return false;
  const bid = session.bundle_identifier || '';
  const name = (session.app_name || '').toLowerCase();
  if (excludedBundles.some((b) => b && (bid === b || bid.startsWith(b)))) return false;
  if (excludedNames.some((n) => n && name === String(n).toLowerCase())) return false;
  return true;
}

/** Overlap duration in seconds between [a0,a1) and [b0,b1). */
export function overlapSeconds(a0, a1, b0, b1) {
  const start = Math.max(a0, b0);
  const end = Math.min(a1, b1);
  return Math.max(0, (end - start) / 1000);
}

export function sessionEffectiveEnd(session, nowMs, ceilingMs = null) {
  if (session.ended_at) return Date.parse(session.ended_at);
  if (ceilingMs != null && Number.isFinite(ceilingMs)) return Math.min(nowMs, ceilingMs);
  return nowMs;
}

export function clippedSessionSeconds(session, fromMs, toMs, nowMs, ceilingMs = null) {
  const start = Date.parse(session.started_at);
  if (Number.isNaN(start)) return { seconds: 0, incomplete: !session.ended_at, interval: null };
  const end = sessionEffectiveEnd(session, nowMs, ceilingMs);
  if (Number.isNaN(end) || end <= start) {
    return { seconds: 0, incomplete: !session.ended_at, interval: null };
  }
  const a0 = Math.max(start, fromMs);
  const a1 = Math.min(end, toMs);
  const seconds = Math.max(0, (a1 - a0) / 1000);
  return {
    seconds,
    incomplete: !session.ended_at,
    interval: seconds > 0 ? [a0, a1] : null,
  };
}

/** Exclusive wall-clock seconds from possibly overlapping [startMs, endMs) intervals. */
export function unionIntervalSeconds(intervals) {
  const cleaned = (intervals || [])
    .filter((x) => Array.isArray(x) && x.length === 2 && x[1] > x[0])
    .map(([a, b]) => [a, b])
    .sort((a, b) => a[0] - b[0]);
  if (!cleaned.length) return 0;
  let total = 0;
  let cur0 = cleaned[0][0];
  let cur1 = cleaned[0][1];
  for (let i = 1; i < cleaned.length; i += 1) {
    const [a, b] = cleaned[i];
    if (a <= cur1) {
      cur1 = Math.max(cur1, b);
    } else {
      total += (cur1 - cur0) / 1000;
      cur0 = a;
      cur1 = b;
    }
  }
  total += (cur1 - cur0) / 1000;
  return total;
}

export function categorizeApp(session) {
  const bid = session.bundle_identifier || '';
  const name = (session.app_name || '').toLowerCase();
  if (BROWSER_BUNDLES.some((p) => bid.startsWith(p)) || /chrome|safari|firefox|edge|brave|arc/.test(name)) {
    return 'Browsing';
  }
  if (DEV_BUNDLES.some((p) => bid.startsWith(p)) || /cursor|code|xcode|terminal|iterm|warp|intellij|sublime/.test(name)) {
    return 'Development';
  }
  if (COMM_BUNDLES.some((p) => bid.startsWith(p)) || /slack|messages|mail|teams|zoom|discord|facetime|whatsapp/.test(name)) {
    return 'Communication';
  }
  return 'Other';
}

export function categorizeDomain(domain) {
  const d = (domain || '').toLowerCase();
  if (!d) return 'Other';
  if (COMM_DOMAINS.some((x) => d === x || d.endsWith(`.${x}`))) return 'Communication';
  if (DEV_DOMAINS.some((x) => d === x || d.endsWith(`.${x}`))) return 'Development';
  if (d.includes('mail') || d.includes('chat') || d.includes('meet')) return 'Communication';
  return 'Browsing';
}

/**
 * Aggregate apps or domains into ranked items with percentages.
 * @param {Map<string, {name:string, seconds:number, incomplete?:boolean}>} map
 */
export function toRanked(map) {
  const items = [...map.values()]
    .filter((x) => x.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds);
  const total = items.reduce((s, x) => s + x.seconds, 0);
  return {
    totalSeconds: total,
    items: items.map((x) => ({
      ...x,
      percent: total > 0 ? (x.seconds / total) * 100 : 0,
    })),
  };
}

export function addCategorySeconds(categories, label, seconds) {
  if (seconds <= 0) return;
  categories[label] = (categories[label] || 0) + seconds;
}

/**
 * Split clipped session time into hour or day buckets (UTC labels).
 */
export function bucketSession(session, fromMs, toMs, nowMs, mode, ceilingMs = null) {
  const start = Date.parse(session.started_at);
  const end = sessionEffectiveEnd(session, nowMs, ceilingMs);
  const a0 = Math.max(start, fromMs);
  const a1 = Math.min(end, toMs);
  if (!(a1 > a0)) return [];

  const out = [];
  if (mode === 'day') {
    let cursor = a0;
    while (cursor < a1) {
      const d = new Date(cursor);
      const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      const dayEnd = dayStart + 24 * 60 * 60 * 1000;
      const segEnd = Math.min(a1, dayEnd);
      const key = new Date(dayStart).toISOString().slice(0, 10);
      out.push({ key, seconds: (segEnd - cursor) / 1000 });
      cursor = segEnd;
    }
    return out;
  }

  // hour
  let cursor = a0;
  while (cursor < a1) {
    const d = new Date(cursor);
    const hourStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours());
    const hourEnd = hourStart + 60 * 60 * 1000;
    const segEnd = Math.min(a1, hourEnd);
    const key = `${new Date(hourStart).toISOString().slice(0, 13)}:00Z`;
    out.push({ key, seconds: (segEnd - cursor) / 1000 });
    cursor = segEnd;
  }
  return out;
}

export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/**
 * Merge overlapping intervals into exclusive seconds, keyed for ranking maps.
 * @param {Map<string, {key:string,name:string,incomplete:boolean,intervals:number[][]}>} map
 */
export function finalizeIntervalMap(map) {
  const ranked = new Map();
  for (const [key, entry] of map) {
    ranked.set(key, {
      key: entry.key,
      name: entry.name,
      incomplete: entry.incomplete,
      seconds: unionIntervalSeconds(entry.intervals),
    });
  }
  return toRanked(ranked);
}

export function buildAnalytics({
  appSessions,
  tabSessions,
  fromMs,
  toMs,
  nowMs,
  macActivityCeilingMs = null,
  chromeActivityCeilingMs = null,
  excludedBundles = [],
  excludedNames = [],
} = {}) {
  const appMap = new Map();
  const domainMap = new Map();
  const categoryIntervals = {
    Development: [],
    Communication: [],
    Browsing: [],
    Other: [],
  };
  const spanDays = (toMs - fromMs) / (24 * 60 * 60 * 1000);
  const bucketMode = spanDays > 1.5 ? 'day' : 'hour';
  const bucketIntervals = new Map();
  const allAppIntervals = [];
  let attributedAppSeconds = 0;
  let openAppSessions = 0;
  let openTabSessions = 0;
  let excludedAppSessions = 0;
  const appOpts = { excludedBundles, excludedNames };

  for (const session of appSessions) {
    if (!shouldCountAppSession(session, appOpts)) {
      excludedAppSessions += 1;
      continue;
    }
    const { seconds, incomplete, interval } = clippedSessionSeconds(
      session, fromMs, toMs, nowMs, macActivityCeilingMs,
    );
    if (incomplete) openAppSessions += 1;
    if (seconds <= 0 || !interval) continue;
    attributedAppSeconds += seconds;
    allAppIntervals.push(interval);

    const key = session.bundle_identifier || session.app_name || session.id;
    const prev = appMap.get(key) || {
      key,
      name: session.app_name || key,
      incomplete: false,
      intervals: [],
    };
    prev.intervals.push(interval);
    prev.incomplete = prev.incomplete || incomplete;
    appMap.set(key, prev);

    categoryIntervals[categorizeApp(session)].push(interval);

    for (const b of bucketSession(session, fromMs, toMs, nowMs, bucketMode, macActivityCeilingMs)) {
      if (b.seconds <= 0) continue;
      const list = bucketIntervals.get(b.key) || [];
      list.push(intervalForBucket(session, fromMs, toMs, nowMs, bucketMode, b.key, macActivityCeilingMs));
      bucketIntervals.set(b.key, list);
    }
  }

  const tabIntervals = [];
  let attributedBrowserSeconds = 0;
  for (const session of tabSessions) {
    const { seconds, incomplete, interval } = clippedSessionSeconds(
      session, fromMs, toMs, nowMs, chromeActivityCeilingMs,
    );
    if (incomplete) openTabSessions += 1;
    if (seconds <= 0 || !interval) continue;
    attributedBrowserSeconds += seconds;
    tabIntervals.push(interval);
    const domain = session.domain || 'unknown';
    const prev = domainMap.get(domain) || {
      key: domain,
      name: domain,
      incomplete: false,
      intervals: [],
    };
    prev.intervals.push(interval);
    prev.incomplete = prev.incomplete || incomplete;
    domainMap.set(domain, prev);
  }

  // Overview totals must be exclusive wall-clock time. Summing concurrent open/orphan
  // sessions (agent/extension restarts) massively inflates "random looking" hour totals.
  const exclusiveAppSeconds = unionIntervalSeconds(allAppIntervals);
  const exclusiveBrowserSeconds = unionIntervalSeconds(tabIntervals);

  const apps = finalizeIntervalMap(appMap);
  const websites = finalizeIntervalMap(domainMap);

  const categories = { Development: 0, Communication: 0, Browsing: 0, Other: 0 };
  for (const [label, intervals] of Object.entries(categoryIntervals)) {
    categories[label] = unionIntervalSeconds(intervals);
  }
  const categoryTotal = Object.values(categories).reduce((a, b) => a + b, 0);
  const categoryItems = Object.entries(categories)
    .map(([name, seconds]) => ({
      name,
      seconds,
      percent: categoryTotal > 0 ? (seconds / categoryTotal) * 100 : 0,
    }))
    .filter((x) => x.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds);

  const timeline = [...bucketIntervals.entries()]
    .map(([key, intervals]) => ({
      key,
      seconds: unionIntervalSeconds(intervals.filter(Boolean)),
    }))
    .filter((x) => x.seconds > 0)
    .sort((a, b) => a.key.localeCompare(b.key));

  return {
    range: {
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      bucketMode,
    },
    notes: {
      appWebsiteSeparate: true,
      categoryRule:
        'Heuristic from app bundle/name (Development, Communication, Browsing, Other). Unknown apps stay Other.',
      browserTimeRule:
        'totalBrowserSeconds is exclusive elapsed browsing (overlapping tab intervals merged). Open tabs freeze at last Chrome activity when the extension is stale. Attributed sum is diagnostic only.',
      appTimeRule:
        'totalTrackedAppSeconds is exclusive elapsed foreground app time (overlaps merged). loginwindow/screensaver excluded. Open apps freeze at last Mac activity when the agent is stale.',
      openSessions: {
        apps: openAppSessions,
        tabs: openTabSessions,
        excludedApps: excludedAppSessions,
        note: 'Open sessions clip to min(now, collector activity ceiling). Stale collectors freeze orphans at last event time.',
        macActivityCeiling: macActivityCeilingMs != null ? new Date(macActivityCeilingMs).toISOString() : null,
        chromeActivityCeiling: chromeActivityCeilingMs != null ? new Date(chromeActivityCeilingMs).toISOString() : null,
      },
    },
    summary: {
      totalTrackedAppSeconds: exclusiveAppSeconds,
      totalTrackedAppSecondsAttributed: attributedAppSeconds,
      totalBrowserSeconds: exclusiveBrowserSeconds,
      totalBrowserSecondsAttributed: attributedBrowserSeconds,
      appCount: apps.items.length,
      websiteCount: websites.items.length,
      topApplication: apps.items[0] || null,
      topWebsite: websites.items[0] || null,
    },
    applications: apps,
    websites,
    categories: {
      totalSeconds: categoryTotal,
      items: categoryItems,
    },
    usageOverTime: timeline,
  };
}

/** Exact [start,end) for one bucket key overlapping a session. */
export function intervalForBucket(session, fromMs, toMs, nowMs, mode, key, ceilingMs = null) {
  const start = Date.parse(session.started_at);
  const end = sessionEffectiveEnd(session, nowMs, ceilingMs);
  const a0 = Math.max(start, fromMs);
  const a1 = Math.min(end, toMs);
  if (!(a1 > a0)) return null;

  if (mode === 'day') {
    const dayStart = Date.parse(`${key}T00:00:00.000Z`);
    if (Number.isNaN(dayStart)) return null;
    const dayEnd = dayStart + 24 * 60 * 60 * 1000;
    const s = Math.max(a0, dayStart);
    const e = Math.min(a1, dayEnd);
    return e > s ? [s, e] : null;
  }

  const hourStart = Date.parse(key);
  if (Number.isNaN(hourStart)) return null;
  const hourEnd = hourStart + 60 * 60 * 1000;
  const s = Math.max(a0, hourStart);
  const e = Math.min(a1, hourEnd);
  return e > s ? [s, e] : null;
}

export function queryOverlappingSessions(db, table, fromIso, toIso) {
  return db.prepare(`
    SELECT * FROM ${table}
    WHERE started_at < ?
      AND (ended_at IS NULL OR ended_at > ?)
    ORDER BY started_at ASC
  `).all(toIso, fromIso);
}

/**
 * Persist closed ends for open sessions when a collector is stale.
 * Reversible: rows keep started_at; end_reason documents the repair.
 * Does not delete history.
 */
export function healStaleOpenSessions(db, { now = Date.now(), staleMs = COLLECTOR_STALE_MS } = {}) {
  let status;
  try {
    status = db.prepare(`
      SELECT last_mac_event_at, last_chrome_event_at FROM tracker_status WHERE id = 1
    `).get() || {};
  } catch {
    status = {};
  }

  const chromeCeil = activityCeilingMs(status.last_chrome_event_at, now, staleMs);
  const macCeil = activityCeilingMs(status.last_mac_event_at, now, staleMs);
  const chromeStale = status.last_chrome_event_at
    && chromeCeil === Date.parse(status.last_chrome_event_at);
  const macStale = status.last_mac_event_at
    && macCeil === Date.parse(status.last_mac_event_at);

  let tabsHealed = 0;
  let appsHealed = 0;

  if (chromeStale) {
    const endIso = status.last_chrome_event_at;
    const endMs = Date.parse(endIso);
    const rows = db.prepare(`SELECT id, started_at FROM tab_sessions WHERE ended_at IS NULL`).all();
    const upd = db.prepare(`
      UPDATE tab_sessions
      SET ended_at = ?, duration_seconds = ?, end_reason = ?
      WHERE id = ? AND ended_at IS NULL
    `);
    for (const row of rows) {
      const startMs = Date.parse(row.started_at);
      if (!Number.isFinite(startMs)) continue;
      const finalEnd = endMs > startMs ? endIso : row.started_at;
      const dur = Math.max(0, (Date.parse(finalEnd) - startMs) / 1000);
      upd.run(finalEnd, dur, 'stale_orphan_clipped_to_last_chrome_activity', row.id);
      tabsHealed += 1;
    }
  }

  if (macStale) {
    const endIso = status.last_mac_event_at;
    const endMs = Date.parse(endIso);
    const rows = db.prepare(`SELECT id, started_at FROM app_sessions WHERE ended_at IS NULL`).all();
    const upd = db.prepare(`
      UPDATE app_sessions
      SET ended_at = ?, duration_seconds = ?, end_reason = ?
      WHERE id = ? AND ended_at IS NULL
    `);
    for (const row of rows) {
      const startMs = Date.parse(row.started_at);
      if (!Number.isFinite(startMs)) continue;
      const finalEnd = endMs > startMs ? endIso : row.started_at;
      const dur = Math.max(0, (Date.parse(finalEnd) - startMs) / 1000);
      upd.run(finalEnd, dur, 'stale_orphan_clipped_to_last_mac_activity', row.id);
      appsHealed += 1;
    }
  }

  return {
    tabsHealed,
    appsHealed,
    chromeStale: Boolean(chromeStale),
    macStale: Boolean(macStale),
    chromeCeiling: status.last_chrome_event_at || null,
    macCeiling: status.last_mac_event_at || null,
  };
}

export function getAnalytics(db, {
  from,
  to,
  now = Date.now(),
  excludedBundles = [],
  excludedNames = [],
  heal = true,
} = {}) {
  const healInfo = heal ? healStaleOpenSessions(db, { now }) : null;
  const range = parseRange({ from, to, now });
  let status = {};
  try {
    status = db.prepare(`
      SELECT last_mac_event_at, last_chrome_event_at FROM tracker_status WHERE id = 1
    `).get() || {};
  } catch {
    status = {};
  }
  const macActivityCeilingMs = activityCeilingMs(status.last_mac_event_at, range.nowMs);
  const chromeActivityCeilingMs = activityCeilingMs(status.last_chrome_event_at, range.nowMs);
  const appSessions = queryOverlappingSessions(db, 'app_sessions', range.fromIso, range.toIso);
  const tabSessions = queryOverlappingSessions(db, 'tab_sessions', range.fromIso, range.toIso);
  const result = buildAnalytics({
    appSessions,
    tabSessions,
    fromMs: range.fromMs,
    toMs: range.toMs,
    nowMs: range.nowMs,
    macActivityCeilingMs,
    chromeActivityCeilingMs,
    excludedBundles,
    excludedNames,
  });
  if (healInfo) {
    result.notes.staleSessionHeal = healInfo;
  }
  return result;
}
