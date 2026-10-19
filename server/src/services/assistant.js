import { getAnalytics, formatDuration } from './analytics.js';
import { searchActivity } from './search.js';
import { buildDailyBriefing } from './briefing.js';
import { buildDailyWorkReport } from './workUnderstanding.js';

/**
 * Deterministic activity assistant — answers from SQLite only.
 * No external AI. Clearly labels facts vs estimates.
 */
export function askAssistant(db, { question, now = Date.now() } = {}) {
  const q = String(question || '').trim();
  if (!q) {
    return {
      answer: 'Ask a question about your recorded activity (apps, websites, times), or request a daily work report.',
      facts: [],
      estimates: [],
      sources: [],
      mode: 'deterministic',
    };
  }

  const lower = q.toLowerCase();
  const dayMatch = detectDay(lower, now);
  const hourRange = detectHourRange(lower, dayMatch.day);
  const from = hourRange
    ? new Date(hourRange.fromMs).toISOString()
    : `${dayMatch.day}T00:00:00.000Z`;
  const to = hourRange
    ? new Date(hourRange.toMs).toISOString()
    : `${dayMatch.day}T23:59:59.999Z`;
  const analytics = getAnalytics(db, { from, to, now });
  const sources = [];

  // Work understanding / daily report questions
  if (
    /what did i (do|work)|daily work report|work report|what (work|tasks)|errors did i fix|testing did i|incomplete|between \d/.test(lower)
    || (/report/.test(lower) && /day|daily|work/.test(lower))
  ) {
    const report = buildDailyWorkReport(db, dayMatch.day, {
      now,
      fromMs: hourRange?.fromMs ?? null,
      toMs: hourRange?.toMs ?? null,
      rebuild: true,
    });
    sources.push(...(report.main_tasks || []).slice(0, 8));
    if (/error|fix|debug/.test(lower)) {
      const probs = report.problems_and_resolutions || [];
      if (!probs.length) {
        return reply(
          `No failure/error events were recorded in work sessions for ${dayMatch.day}${hourRange ? ' in that hour range' : ''}. I cannot invent bugs that were fixed.`,
          ['Checked recorded error/failure events linked to grouped work sessions.'],
          ['Add a work note if you fixed something the tracker did not observe.'],
          sources,
        );
      }
      const list = probs.slice(0, 12).map((p) => `• ${p.task}: ${p.label}`).join('\n');
      return reply(
        `Observed problem-related events on ${dayMatch.day}:\n${list}`,
        ['From recorded error/failure events in work session windows.'],
        ['Event presence is not proof of a successful fix unless you noted the outcome.'],
        probs,
      );
    }
    if (/test|testing|smoke|verify/.test(lower)) {
      const tests = report.tests_performed || [];
      if (!tests.length) {
        return reply(
          `No test-related events were detected for ${dayMatch.day}. The tracker only sees app/browser activity and event types — not npm/playwright output unless you add a note.`,
          [],
          ['Keyword inference only; unverified.'],
          sources,
        );
      }
      const list = tests.slice(0, 12).map((t) => `• ${t.task}: ${t.label}`).join('\n');
      return reply(
        `Possible testing-related activity on ${dayMatch.day}:\n${list}`,
        ['Matched event keywords near work sessions.'],
        ['Inferred — not proof of pass/fail.'],
        tests,
      );
    }
    if (/incomplete|unfinished|left open/.test(lower)) {
      const open = report.incomplete_or_unresolved || [];
      if (!open.length) {
        return reply(`Nothing was flagged incomplete for ${dayMatch.day}.`, [], [], sources);
      }
      const list = open.map((s) => `• ${s.title} (${s.status}) — ${s.note}`).join('\n');
      return reply(`Possibly incomplete items on ${dayMatch.day}:\n${list}`, [], ['Status is inferred from tracking unless you edited it.'], open);
    }
    return reply(
      report.text,
      [
        `App active ${formatDuration(report.time.appActiveSeconds)}; browser elapsed ${formatDuration(report.time.browserElapsedSeconds)}.`,
        `${(report.main_tasks || []).length} grouped work session(s).`,
      ],
      [
        report.disclaimer,
        report.time.note,
        ...(report.unknown || []),
      ],
      report.main_tasks,
    );
  }

  // Pattern: time in a specific app
  const appTime = lower.match(/(?:how much time|time).*(?:in|on)\s+([a-z0-9 ._-]+?)(?:\s+yesterday|\s+today|$|\?)/i)
    || lower.match(/spent (?:in|on)\s+([a-z0-9 ._-]+)/i);
  if (appTime) {
    const name = appTime[1].trim();
    const hit = analytics.applications.items.find((a) => a.name.toLowerCase().includes(name.toLowerCase()));
    sources.push(...analytics.applications.items.slice(0, 5));
    if (!hit) {
      return reply(
        `I have no recorded foreground time for an app matching “${name}” on ${dayMatch.day}.`,
        [`Checked app_sessions overlapping ${dayMatch.day}.`],
        [],
        sources
      );
    }
    return reply(
      `On ${dayMatch.day}, recorded foreground time in ${hit.name} was ${formatDuration(hit.seconds)} (${hit.percent.toFixed(1)}% of app time that day).`,
      [`Source: app_sessions for ${hit.name}.`],
      hit.incomplete ? ['Session may still have been open (clipped to now).'] : [],
      [hit]
    );
  }

  if (/which websites|websites did i|sites did i|visited/.test(lower)) {
    const sites = analytics.websites.items.slice(0, 10);
    sources.push(...sites);
    if (!sites.length) {
      return reply(`No website tab sessions were recorded for ${dayMatch.day}.`, [], [], []);
    }
    const list = sites.map((s) => `• ${s.name}: ${formatDuration(s.seconds)}`).join('\n');
    return reply(
      `Websites recorded on ${dayMatch.day} (tab session time, separate from app time):\n${list}`,
      ['From tab_sessions.'],
      ['Background-tab overcount is reduced after active-tab hardening; older open sessions may still look long.'],
      sites
    );
  }

  if (/which apps|applications did i|apps did i use|what apps/.test(lower)) {
    const apps = analytics.applications.items.slice(0, 10);
    if (!apps.length) {
      return reply(`No application sessions were recorded for ${dayMatch.day}.`, [], [], []);
    }
    const list = apps.map((a) => `• ${a.name}: ${formatDuration(a.seconds)}`).join('\n');
    return reply(
      `Applications recorded on ${dayMatch.day}:\n${list}`,
      ['From app_sessions (foreground).'],
      [],
      apps
    );
  }

  if (/interrupt|context switch|switch/.test(lower)) {
    const switches = db.prepare(`
      SELECT COUNT(*) AS c FROM events
      WHERE substr(timestamp,1,10)=? AND type='sessionStarted'
    `).get(dayMatch.day).c;
    return reply(
      `On ${dayMatch.day} there were ${switches} recorded app session starts (context switches).`,
      ['Counted sessionStarted events.'],
      ['This counts switches, not whether they were interruptions.'],
      []
    );
  }

  if (/summarize|summary|briefing|what did i (do|work)/.test(lower)) {
    const briefing = buildDailyBriefing(db, dayMatch.day, { now });
    return reply(
      briefing.facts.join(' '),
      briefing.facts,
      briefing.estimates,
      [...briefing.top_apps, ...briefing.top_websites]
    );
  }

  if (/find|search|page i visited|look for/.test(lower)) {
    const term = q.replace(/.*(find|search|look for)\s+/i, '').replace(/[?]/g, '').trim() || q;
    const found = searchActivity(db, { q: term, from, to, limit: 8 });
    if (!found.results.length) {
      return reply(`No stored records matched “${term}” in that range.`, [], [], []);
    }
    const list = found.results.slice(0, 8).map((r) => `• [${r.kind}] ${r.title} — ${r.snippet || r.timestamp || ''}`).join('\n');
    return reply(`Matches for “${term}”:\n${list}`, ['From local search index / events.'], [], found.results);
  }

  // Default: day overview
  return reply(
    `For ${dayMatch.day}: app time ${formatDuration(analytics.summary.totalTrackedAppSeconds)}, browser time ${formatDuration(analytics.summary.totalBrowserSeconds)}, top app ${analytics.summary.topApplication?.name || 'none'}. Ask about a specific app, websites, or say “summarize my day”.`,
    ['Default overview from analytics.'],
    ['I only know recorded tracker data — not page contents or untracked time.'],
    analytics.applications.items.slice(0, 3)
  );
}

function reply(answer, facts, estimates, sources) {
  return {
    answer,
    facts,
    estimates,
    sources: (sources || []).slice(0, 10),
    mode: 'deterministic',
    provider: 'local-rules',
    note: 'Cloud AI is not used. Answers come from your local SQLite records.',
  };
}

function detectDay(lower, now) {
  const d = new Date(now);
  if (lower.includes('yesterday')) {
    d.setDate(d.getDate() - 1);
  }
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return { day: `${y}-${m}-${day}` };
}

/** Parse "between 10 and 12" / "10am-12pm" as local hours on the given UTC day string. */
function detectHourRange(lower, day) {
  const m = lower.match(/between\s+(\d{1,2})\s*(am|pm)?\s*(?:and|-|to)\s*(\d{1,2})\s*(am|pm)?/i)
    || lower.match(/(\d{1,2})\s*(am|pm)\s*[-–to]+\s*(\d{1,2})\s*(am|pm)/i);
  if (!m) return null;
  let h1 = Number(m[1]);
  let h2 = Number(m[3]);
  const p1 = (m[2] || '').toLowerCase();
  const p2 = (m[4] || '').toLowerCase();
  if (p1 === 'pm' && h1 < 12) h1 += 12;
  if (p1 === 'am' && h1 === 12) h1 = 0;
  if (p2 === 'pm' && h2 < 12) h2 += 12;
  if (p2 === 'am' && h2 === 12) h2 = 0;
  if (!(h1 >= 0 && h1 < 24 && h2 > h1 && h2 <= 24)) return null;
  // Interpret hours in local timezone for the calendar day
  const [y, mo, d] = day.split('-').map(Number);
  const fromMs = new Date(y, mo - 1, d, h1, 0, 0, 0).getTime();
  const toMs = new Date(y, mo - 1, d, h2, 0, 0, 0).getTime() - 1;
  return { fromMs, toMs };
}
