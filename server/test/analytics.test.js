import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, closeDatabase } from '../src/db/database.js';
import { insertEvent } from '../src/services/events.js';
import {
  overlapSeconds,
  clippedSessionSeconds,
  unionIntervalSeconds,
  buildAnalytics,
  getAnalytics,
  formatDuration,
  categorizeApp,
  toRanked,
  activityCeilingMs,
  healStaleOpenSessions,
  COLLECTOR_STALE_MS,
} from '../src/services/analytics.js';

function tempDb() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-analytics-')), 't.sqlite');
}

test('overlap and clip avoid double range and negative durations', () => {
  assert.equal(overlapSeconds(0, 10_000, 5_000, 15_000), 5);
  assert.equal(overlapSeconds(0, 1000, 2000, 3000), 0);
  const session = {
    started_at: '2026-10-15T10:00:00.000Z',
    ended_at: '2026-10-15T10:10:00.000Z',
  };
  const from = Date.parse('2026-10-15T10:05:00.000Z');
  const to = Date.parse('2026-10-15T10:20:00.000Z');
  const { seconds } = clippedSessionSeconds(session, from, to, to);
  assert.equal(seconds, 300);
});

test('open sessions are clipped to now and marked incomplete', () => {
  const now = Date.parse('2026-10-15T10:05:00.000Z');
  const session = { started_at: '2026-10-15T10:00:00.000Z', ended_at: null };
  const from = Date.parse('2026-10-15T09:00:00.000Z');
  const to = Date.parse('2026-10-15T11:00:00.000Z');
  const { seconds, incomplete } = clippedSessionSeconds(session, from, to, now);
  assert.equal(seconds, 300);
  assert.equal(incomplete, true);
});

test('empty data produces zero totals without invented apps', () => {
  const result = buildAnalytics({
    appSessions: [],
    tabSessions: [],
    fromMs: Date.parse('2026-10-15T00:00:00.000Z'),
    toMs: Date.parse('2026-10-15T23:59:59.000Z'),
    nowMs: Date.parse('2026-10-15T12:00:00.000Z'),
  });
  assert.equal(result.summary.totalTrackedAppSeconds, 0);
  assert.equal(result.summary.appCount, 0);
  assert.equal(result.applications.items.length, 0);
  assert.equal(result.websites.items.length, 0);
  assert.equal(result.summary.topApplication, null);
});

test('unionIntervalSeconds merges overlapping open-tab orphans', () => {
  const a0 = Date.parse('2026-10-15T10:00:00.000Z');
  const a1 = Date.parse('2026-10-15T14:00:00.000Z'); // 4h
  const b0 = Date.parse('2026-10-15T11:00:00.000Z');
  const b1 = Date.parse('2026-10-15T15:00:00.000Z'); // overlaps → union 5h
  assert.equal(unionIntervalSeconds([[a0, a1], [b0, b1]]), 5 * 3600);
  assert.equal(unionIntervalSeconds([[a0, a1], [a0, a1]]), 4 * 3600);
});

test('app total and per-app ranks use exclusive union for overlapping open apps', () => {
  const fromMs = Date.parse('2026-10-15T00:00:00.000Z');
  const toMs = Date.parse('2026-10-15T23:59:59.000Z');
  const nowMs = Date.parse('2026-10-15T14:00:00.000Z');
  const result = buildAnalytics({
    appSessions: [
      { id: 'c1', app_name: 'Cursor', bundle_identifier: 'com.cursor', started_at: '2026-10-15T10:00:00.000Z', ended_at: null },
      { id: 'c2', app_name: 'Cursor', bundle_identifier: 'com.cursor', started_at: '2026-10-15T11:00:00.000Z', ended_at: null },
      { id: 'ch', app_name: 'Chrome', bundle_identifier: 'com.google.Chrome', started_at: '2026-10-15T10:00:00.000Z', ended_at: null },
    ],
    tabSessions: [],
    fromMs,
    toMs,
    nowMs,
  });
  // Attributed sum would be 4h+3h+4h = 11h; exclusive wall clock is 4h.
  assert.equal(result.summary.totalTrackedAppSeconds, 4 * 3600);
  assert.equal(result.summary.totalTrackedAppSecondsAttributed, 11 * 3600);
  const cursor = result.applications.items.find((i) => i.name === 'Cursor');
  assert.equal(cursor.seconds, 4 * 3600); // overlapping Cursor orphans merged
  // Hour buckets must not exceed 3600s of exclusive activity.
  for (const b of result.usageOverTime) {
    assert.ok(b.seconds <= 3600 + 0.001, `bucket ${b.key} = ${b.seconds}`);
  }
});

test('formatDuration handles zero, missing, invalid, and large values', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(null), '0s');
  assert.equal(formatDuration(undefined), '0s');
  assert.equal(formatDuration(Number.NaN), '0s');
  assert.equal(formatDuration(-5), '0s');
  assert.equal(formatDuration(90), '1m');
  assert.equal(formatDuration(3661), '1h 1m');
  assert.equal(formatDuration(100 * 3600), '100h 0m');
});

test('browser total uses exclusive union, not sum of concurrent open tabs', () => {
  const fromMs = Date.parse('2026-10-15T00:00:00.000Z');
  const toMs = Date.parse('2026-10-15T23:59:59.000Z');
  const nowMs = Date.parse('2026-10-15T14:00:00.000Z');
  const result = buildAnalytics({
    appSessions: [],
    tabSessions: [
      { id: 'o1', domain: 'chatgpt.com', started_at: '2026-10-15T10:00:00.000Z', ended_at: null },
      { id: 'o2', domain: 'example.com', started_at: '2026-10-15T10:00:00.000Z', ended_at: null },
      { id: 'o3', domain: '127.0.0.1', started_at: '2026-10-15T11:00:00.000Z', ended_at: null },
    ],
    fromMs,
    toMs,
    nowMs,
  });
  // Sum would be 4h+4h+3h = 11h; exclusive wall clock is 4h.
  assert.equal(result.summary.totalBrowserSeconds, 4 * 3600);
  assert.equal(result.summary.totalBrowserSecondsAttributed, 11 * 3600);
  assert.equal(result.notes.openSessions.tabs, 3);
  // Per-site list still shows attributed seconds (can sum above exclusive total).
  assert.ok(result.websites.totalSeconds > result.summary.totalBrowserSeconds);
});

test('app and website totals stay separate; percentages use correct denominator', () => {
  const fromMs = Date.parse('2026-10-15T00:00:00.000Z');
  const toMs = Date.parse('2026-10-15T23:59:59.000Z');
  const nowMs = toMs;
  const result = buildAnalytics({
    appSessions: [
      {
        id: 'a1',
        app_name: 'Cursor',
        bundle_identifier: 'com.todesktop.230313mzl4w4u92',
        started_at: '2026-10-15T10:00:00.000Z',
        ended_at: '2026-10-15T10:10:00.000Z',
        duration_seconds: 600,
      },
      {
        id: 'a2',
        app_name: 'Google Chrome',
        bundle_identifier: 'com.google.Chrome',
        started_at: '2026-10-15T10:10:00.000Z',
        ended_at: '2026-10-15T10:15:00.000Z',
        duration_seconds: 300,
      },
    ],
    tabSessions: [
      {
        id: 't1',
        domain: 'example.com',
        started_at: '2026-10-15T10:10:00.000Z',
        ended_at: '2026-10-15T10:12:00.000Z',
        duration_seconds: 120,
      },
      {
        id: 't2',
        domain: 'example.com',
        started_at: '2026-10-15T10:12:00.000Z',
        ended_at: '2026-10-15T10:15:00.000Z',
        duration_seconds: 180,
      },
    ],
    fromMs,
    toMs,
    nowMs,
  });

  assert.equal(result.summary.totalTrackedAppSeconds, 900);
  assert.equal(result.summary.totalBrowserSeconds, 300);
  assert.notEqual(result.summary.totalTrackedAppSeconds, result.summary.totalBrowserSeconds);

  const cursor = result.applications.items.find((i) => i.name === 'Cursor');
  assert.ok(cursor);
  assert.equal(cursor.seconds, 600);
  assert.ok(Math.abs(cursor.percent - (600 / 900) * 100) < 0.01);

  const site = result.websites.items.find((i) => i.name === 'example.com');
  assert.equal(site.seconds, 300);
  assert.equal(site.percent, 100);

  const cats = Object.fromEntries(result.categories.items.map((c) => [c.name, c.seconds]));
  assert.equal(cats.Development, 600);
  assert.equal(cats.Browsing, 300);
});

test('non-overlapping sequential sessions do not invent overlap', () => {
  const fromMs = Date.parse('2026-10-15T00:00:00.000Z');
  const toMs = Date.parse('2026-10-15T23:59:59.000Z');
  const result = buildAnalytics({
    appSessions: [
      {
        id: '1',
        app_name: 'A',
        bundle_identifier: 'a',
        started_at: '2026-10-15T10:00:00.000Z',
        ended_at: '2026-10-15T10:01:00.000Z',
      },
      {
        id: '2',
        app_name: 'B',
        bundle_identifier: 'b',
        started_at: '2026-10-15T10:01:00.000Z',
        ended_at: '2026-10-15T10:03:00.000Z',
      },
    ],
    tabSessions: [],
    fromMs,
    toMs,
    nowMs: toMs,
  });
  assert.equal(result.summary.totalTrackedAppSeconds, 180);
  assert.equal(result.summary.appCount, 2);
});

test('date filter excludes sessions outside range', () => {
  const result = buildAnalytics({
    appSessions: [
      {
        id: 'old',
        app_name: 'Old',
        bundle_identifier: 'old',
        started_at: '2026-10-14T10:00:00.000Z',
        ended_at: '2026-10-14T10:30:00.000Z',
      },
      {
        id: 'in',
        app_name: 'In',
        bundle_identifier: 'in',
        started_at: '2026-10-15T10:00:00.000Z',
        ended_at: '2026-10-15T10:05:00.000Z',
      },
    ],
    tabSessions: [],
    fromMs: Date.parse('2026-10-15T00:00:00.000Z'),
    toMs: Date.parse('2026-10-15T23:59:59.000Z'),
    nowMs: Date.parse('2026-10-15T23:59:59.000Z'),
  });
  assert.equal(result.summary.appCount, 1);
  assert.equal(result.applications.items[0].name, 'In');
  assert.equal(result.summary.totalTrackedAppSeconds, 300);
});

test('formatDuration and categorizeApp helpers', () => {
  assert.equal(formatDuration(3661), '1h 1m');
  assert.equal(formatDuration(90), '1m');
  assert.equal(categorizeApp({ bundle_identifier: 'com.google.Chrome', app_name: 'Chrome' }), 'Browsing');
  assert.equal(categorizeApp({ bundle_identifier: 'com.unknown.app', app_name: 'Foo' }), 'Other');
});

test('toRanked ignores zero-second entries', () => {
  const map = new Map([
    ['a', { key: 'a', name: 'A', seconds: 0 }],
    ['b', { key: 'b', name: 'B', seconds: 10 }],
  ]);
  const ranked = toRanked(map);
  assert.equal(ranked.items.length, 1);
  assert.equal(ranked.totalSeconds, 10);
});

test('getAnalytics reads SQLite sessions for a range', () => {
  const db = openDatabase(tempDb());
  insertEvent(db, {
    id: 'an1',
    timestamp: '2026-10-15T08:00:00.000Z',
    type: 'sessionStarted',
    outcome: 'success',
    sessionId: 'an-sess',
    app: { name: 'TextEdit', bundleIdentifier: 'com.apple.TextEdit' },
  }, 'mac-agent');
  insertEvent(db, {
    id: 'an2',
    timestamp: '2026-10-15T08:04:00.000Z',
    type: 'sessionEnded',
    outcome: 'success',
    sessionId: 'an-sess',
    durationSeconds: 240,
    app: { name: 'TextEdit', bundleIdentifier: 'com.apple.TextEdit' },
  }, 'mac-agent');
  insertEvent(db, {
    id: 'an3',
    timestamp: '2026-10-15T08:01:00.000Z',
    type: 'tabSessionStarted',
    outcome: 'success',
    tabSessionId: 'an-tab',
    browser: 'Chrome',
    tab: { tabId: 1, title: 'Ex', url: 'https://example.com/', domain: 'example.com', browser: 'Chrome' },
    domain: 'example.com',
  }, 'chrome-extension');
  insertEvent(db, {
    id: 'an4',
    timestamp: '2026-10-15T08:03:00.000Z',
    type: 'tabSessionEnded',
    outcome: 'success',
    tabSessionId: 'an-tab',
    durationSeconds: 120,
    domain: 'example.com',
  }, 'chrome-extension');

  const analytics = getAnalytics(db, {
    from: '2026-10-15T00:00:00.000Z',
    to: '2026-10-15T23:59:59.000Z',
    now: Date.parse('2026-10-15T23:59:59.000Z'),
  });
  assert.equal(analytics.summary.totalTrackedAppSeconds, 240);
  assert.equal(analytics.summary.totalBrowserSeconds, 120);
  assert.equal(analytics.summary.topApplication.name, 'TextEdit');
  assert.equal(analytics.summary.topWebsite.name, 'example.com');
  closeDatabase(db);
});

test('single 30-minute closed session', () => {
  const fromMs = Date.parse('2026-10-15T00:00:00.000Z');
  const toMs = Date.parse('2026-10-15T23:59:59.000Z');
  const result = buildAnalytics({
    appSessions: [{
      id: 's30',
      app_name: 'Notes',
      bundle_identifier: 'com.apple.Notes',
      started_at: '2026-10-15T12:00:00.000Z',
      ended_at: '2026-10-15T12:30:00.000Z',
    }],
    tabSessions: [],
    fromMs,
    toMs,
    nowMs: toMs,
  });
  assert.equal(result.summary.totalTrackedAppSeconds, 30 * 60);
});

test('two non-overlapping sequential sessions count fully', () => {
  const fromMs = Date.parse('2026-10-15T00:00:00.000Z');
  const toMs = Date.parse('2026-10-15T23:59:59.000Z');
  const result = buildAnalytics({
    appSessions: [
      {
        id: 'a', app_name: 'A', bundle_identifier: 'a',
        started_at: '2026-10-15T10:00:00.000Z', ended_at: '2026-10-15T10:10:00.000Z',
      },
      {
        id: 'b', app_name: 'B', bundle_identifier: 'b',
        started_at: '2026-10-15T10:10:00.000Z', ended_at: '2026-10-15T10:25:00.000Z',
      },
    ],
    tabSessions: [],
    fromMs,
    toMs,
    nowMs: toMs,
  });
  assert.equal(result.summary.totalTrackedAppSeconds, 25 * 60);
  assert.equal(result.summary.appCount, 2);
});

test('two overlapping browser tabs for the same hour count once exclusively', () => {
  const fromMs = Date.parse('2026-10-15T00:00:00.000Z');
  const toMs = Date.parse('2026-10-15T23:59:59.000Z');
  const result = buildAnalytics({
    appSessions: [],
    tabSessions: [
      {
        id: 't1', domain: 'a.com',
        started_at: '2026-10-15T10:00:00.000Z', ended_at: '2026-10-15T11:00:00.000Z',
      },
      {
        id: 't2', domain: 'b.com',
        started_at: '2026-10-15T10:00:00.000Z', ended_at: '2026-10-15T11:00:00.000Z',
      },
    ],
    fromMs,
    toMs,
    nowMs: toMs,
  });
  assert.equal(result.summary.totalBrowserSeconds, 3600);
  assert.equal(result.summary.totalBrowserSecondsAttributed, 7200);
  assert.notEqual(result.summary.totalTrackedAppSeconds, result.summary.totalBrowserSeconds);
});

test('stale chrome ceiling freezes orphan open tabs (prior failure pattern)', () => {
  const fromMs = Date.parse('2026-10-16T00:00:00.000+05:30');
  const toMs = Date.parse('2026-10-16T23:59:59.999+05:30');
  const nowMs = Date.parse('2026-10-16T12:00:00.000+05:30');
  const lastChrome = Date.parse('2026-10-15T10:32:00.000Z');
  assert.ok(nowMs - lastChrome > COLLECTOR_STALE_MS);
  const ceiling = activityCeilingMs(new Date(lastChrome).toISOString(), nowMs);
  assert.equal(ceiling, lastChrome);

  const result = buildAnalytics({
    appSessions: [],
    tabSessions: [
      { id: 'o1', domain: 'example.com', started_at: '2026-10-15T06:05:58.000Z', ended_at: null },
      { id: 'o2', domain: 'chatgpt.com', started_at: '2026-10-15T06:10:00.000Z', ended_at: null },
    ],
    fromMs,
    toMs,
    nowMs,
    chromeActivityCeilingMs: ceiling,
  });
  // Orphans froze yesterday — contribute 0 to today's local range.
  assert.equal(result.summary.totalBrowserSeconds, 0);
  assert.equal(result.summary.totalBrowserSecondsAttributed, 0);
});

test('loginwindow is excluded from tracked app time', () => {
  const fromMs = Date.parse('2026-10-16T00:00:00.000Z');
  const toMs = Date.parse('2026-10-16T23:59:59.000Z');
  const nowMs = Date.parse('2026-10-16T12:00:00.000Z');
  const result = buildAnalytics({
    appSessions: [
      {
        id: 'lw',
        app_name: 'loginwindow',
        bundle_identifier: 'com.apple.loginwindow',
        started_at: '2026-10-16T01:00:00.000Z',
        ended_at: '2026-10-16T12:00:00.000Z',
      },
      {
        id: 'cur',
        app_name: 'Cursor',
        bundle_identifier: 'com.todesktop.x',
        started_at: '2026-10-16T11:00:00.000Z',
        ended_at: '2026-10-16T11:30:00.000Z',
      },
    ],
    tabSessions: [],
    fromMs,
    toMs,
    nowMs,
  });
  assert.equal(result.summary.totalTrackedAppSeconds, 30 * 60);
  assert.equal(result.summary.topApplication.name, 'Cursor');
  assert.ok(!result.applications.items.some((i) => i.name === 'loginwindow'));
});

test('sessions crossing midnight are clipped to each day range', () => {
  const session = {
    id: 'cross',
    app_name: 'Cursor',
    bundle_identifier: 'com.cursor',
    started_at: '2026-10-15T22:00:00.000Z',
    ended_at: '2026-10-16T02:00:00.000Z',
  };
  const day1 = buildAnalytics({
    appSessions: [session],
    tabSessions: [],
    fromMs: Date.parse('2026-10-15T00:00:00.000Z'),
    toMs: Date.parse('2026-10-15T23:59:59.999Z'),
    nowMs: Date.parse('2026-10-16T12:00:00.000Z'),
  });
  const day2 = buildAnalytics({
    appSessions: [session],
    tabSessions: [],
    fromMs: Date.parse('2026-10-16T00:00:00.000Z'),
    toMs: Date.parse('2026-10-16T23:59:59.999Z'),
    nowMs: Date.parse('2026-10-16T12:00:00.000Z'),
  });
  // 22:00–23:59:59.999 ≈ 2h on day1; 00:00–02:00 = 2h on day2
  assert.ok(day1.summary.totalTrackedAppSeconds > 7199 && day1.summary.totalTrackedAppSeconds <= 7200);
  assert.equal(day2.summary.totalTrackedAppSeconds, 2 * 3600);
});

test('invalid and reversed timestamps contribute zero', () => {
  const fromMs = Date.parse('2026-10-15T00:00:00.000Z');
  const toMs = Date.parse('2026-10-15T23:59:59.000Z');
  const result = buildAnalytics({
    appSessions: [
      {
        id: 'bad',
        app_name: 'Bad',
        bundle_identifier: 'bad',
        started_at: '2026-10-15T12:00:00.000Z',
        ended_at: '2026-10-15T11:00:00.000Z',
      },
      {
        id: 'nan',
        app_name: 'Nan',
        bundle_identifier: 'nan',
        started_at: 'not-a-date',
        ended_at: '2026-10-15T12:00:00.000Z',
      },
    ],
    tabSessions: [],
    fromMs,
    toMs,
    nowMs: toMs,
  });
  assert.equal(result.summary.totalTrackedAppSeconds, 0);
});

test('healStaleOpenSessions closes orphan tabs at last chrome activity', () => {
  const db = openDatabase(tempDb());
  insertEvent(db, {
    id: 'h1',
    timestamp: '2026-10-15T10:00:00.000Z',
    type: 'tabSessionStarted',
    outcome: 'success',
    tabSessionId: 'orphan-tab',
    tab: { domain: 'example.com', url: 'https://example.com/', title: 'Ex' },
  }, 'chrome-extension');
  // Simulate stale chrome: last chrome event stays at 10:00, "now" is much later
  db.prepare(`UPDATE tracker_status SET last_chrome_event_at = ? WHERE id = 1`)
    .run('2026-10-15T10:05:00.000Z');
  const now = Date.parse('2026-10-16T12:00:00.000Z');
  const heal = healStaleOpenSessions(db, { now });
  assert.equal(heal.chromeStale, true);
  assert.equal(heal.tabsHealed, 1);
  const row = db.prepare(`SELECT * FROM tab_sessions WHERE id = ?`).get('orphan-tab');
  assert.equal(row.ended_at, '2026-10-15T10:05:00.000Z');
  assert.equal(row.end_reason, 'stale_orphan_clipped_to_last_chrome_activity');
  closeDatabase(db);
});

test('app and browser metrics stay separate in summary', () => {
  const result = buildAnalytics({
    appSessions: [{
      id: '1', app_name: 'Cursor', bundle_identifier: 'com.cursor',
      started_at: '2026-10-15T10:00:00.000Z', ended_at: '2026-10-15T11:00:00.000Z',
    }],
    tabSessions: [{
      id: 't', domain: 'example.com',
      started_at: '2026-10-15T10:00:00.000Z', ended_at: '2026-10-15T10:30:00.000Z',
    }],
    fromMs: Date.parse('2026-10-15T00:00:00.000Z'),
    toMs: Date.parse('2026-10-15T23:59:59.000Z'),
    nowMs: Date.parse('2026-10-15T23:59:59.000Z'),
  });
  assert.equal(result.summary.totalTrackedAppSeconds, 3600);
  assert.equal(result.summary.totalBrowserSeconds, 1800);
  assert.notEqual(
    result.summary.totalTrackedAppSeconds,
    result.summary.totalTrackedAppSeconds + result.summary.totalBrowserSeconds,
  );
});
