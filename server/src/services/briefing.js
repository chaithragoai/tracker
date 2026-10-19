import { getAnalytics, formatDuration } from './analytics.js';
import { refreshDailySummary } from './events.js';

/** Deterministic daily briefing from recorded sessions only. */
export function buildDailyBriefing(db, day, { now = Date.now() } = {}) {
  const from = `${day}T00:00:00.000Z`;
  const to = `${day}T23:59:59.999Z`;
  refreshDailySummary(db, day);
  const analytics = getAnalytics(db, { from, to, now });
  const idle = db.prepare(`
    SELECT COALESCE(SUM(duration_seconds),0) AS s FROM idle_periods
    WHERE substr(started_at,1,10)=?
  `).get(day).s;
  const gaps = db.prepare(`
    SELECT COUNT(*) AS c, COALESCE(SUM(duration_seconds),0) AS s FROM tracking_gaps
    WHERE substr(started_at,1,10)=?
  `).get(day);
  const switches = db.prepare(`
    SELECT COUNT(*) AS c FROM events
    WHERE substr(timestamp,1,10)=? AND type='sessionStarted'
  `).get(day).c;

  const facts = [
    `Recorded foreground app time: ${formatDuration(analytics.summary.totalTrackedAppSeconds)}.`,
    `Recorded browser tab time (separate): ${formatDuration(analytics.summary.totalBrowserSeconds)}.`,
    `Apps used: ${analytics.summary.appCount}; websites: ${analytics.summary.websiteCount}.`,
    `Context switches (app session starts): ${switches}.`,
    `Idle time recorded: ${formatDuration(idle)}; tracking gaps: ${gaps.c} (${formatDuration(gaps.s)}).`,
  ];
  if (analytics.summary.topApplication) {
    facts.push(
      `Top app: ${analytics.summary.topApplication.name} (${formatDuration(analytics.summary.topApplication.seconds)}).`
    );
  }
  if (analytics.summary.topWebsite) {
    facts.push(
      `Top website: ${analytics.summary.topWebsite.name} (${formatDuration(analytics.summary.topWebsite.seconds)}).`
    );
  }

  const estimates = [];
  if (analytics.notes.openSessions.apps || analytics.notes.openSessions.tabs) {
    estimates.push(
      `Some sessions were still open when this briefing was built (${analytics.notes.openSessions.apps} apps, ${analytics.notes.openSessions.tabs} tabs); their time is clipped and may grow.`
    );
  }
  estimates.push('Category labels (Development/Browsing/etc.) are heuristics, not measured productivity.');

  const briefing = {
    day,
    generated_at: new Date(now).toISOString(),
    kind: 'deterministic',
    facts,
    estimates,
    analytics_summary: analytics.summary,
    categories: analytics.categories,
    top_apps: analytics.applications.items.slice(0, 5),
    top_websites: analytics.websites.items.slice(0, 5),
    usage_over_time: analytics.usageOverTime,
    disclaimer: 'This briefing uses recorded tracker data only. It does not invent work completed or page contents.',
  };

  db.prepare(`
    INSERT INTO daily_briefings (day, generated_at, content_json, kind)
    VALUES (?, ?, ?, 'deterministic')
    ON CONFLICT(day) DO UPDATE SET
      generated_at=excluded.generated_at,
      content_json=excluded.content_json,
      kind=excluded.kind
  `).run(day, briefing.generated_at, JSON.stringify(briefing));

  return briefing;
}

export function getDailyBriefing(db, day) {
  const row = db.prepare('SELECT * FROM daily_briefings WHERE day = ?').get(day);
  if (!row) return null;
  return JSON.parse(row.content_json);
}
