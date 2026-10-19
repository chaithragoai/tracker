/**
 * Work understanding: group tracked activity into editable work sessions
 * and generate on-demand daily work reports.
 *
 * Rules:
 * - Only use recorded sessions/events + user notes (no invented work).
 * - Durations use exclusive interval union (shared analytics helpers).
 * - Distinguish observed / user_note / inferred.
 * - Summarize WHAT KIND of work — never invent prompts, code, filenames, or outcomes.
 */

import {
  categorizeApp,
  clippedSessionSeconds,
  formatDuration,
  getAnalytics,
  queryOverlappingSessions,
  unionIntervalSeconds,
  activityCeilingMs,
} from './analytics.js';

const GAP_SPLIT_MS = 45 * 60 * 1000; // merge related fragments across short breaks
const CATEGORY_GAP_MS = 12 * 60 * 1000;
const CODE_FILE_RE = /\.(swift|ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|cpp|h|m|mm|css|scss|html|vue|svelte|json|yml|yaml|toml|md|sql)\b/i;

/** Human labels for stored category keys. */
export const WORK_KIND_LABELS = {
  bug_fixing: 'Bug fixing',
  feature_development: 'Feature development',
  coding: 'Writing or modifying code',
  testing: 'Testing and verification',
  debugging: 'Debugging and investigating errors',
  research: 'Research and learning',
  review: 'Reviewing existing work',
  configuration: 'Configuration and setup',
  documentation: 'Documentation',
  meeting: 'Meetings or communication',
  other: 'Other work',
  uncertain: 'Uncertain activity',
};

const CATEGORY_LABELS = WORK_KIND_LABELS;

const DEV_APP_RE = /cursor|code|xcode|terminal|iterm|warp|intellij|sublime|android studio|visual studio/i;
const COMM_APP_RE = /slack|messages|mail|teams|zoom|discord|facetime|whatsapp|skype/i;
const CONFIG_APP_RE = /system settings|system preferences|finder|openvpn|keychain|terminal/i;
const DOC_APP_RE = /notes|notion|bear|obsidian|pages|word|docs/i;

const RESEARCH_DOMAINS = [
  'stackoverflow.com', 'stackexchange.com', 'developer.mozilla.org', 'mdn.io',
  'learn.microsoft.com', 'docs.github.com', 'wikipedia.org', 'reddit.com',
  'medium.com', 'dev.to', 'npmjs.com', 'pypi.org', 'pkg.go.dev',
];
const AI_ASSIST_DOMAINS = [
  'chatgpt.com', 'chat.openai.com', 'claude.ai', 'gemini.google.com',
  'perplexity.ai', 'copilot.microsoft.com', 'cursor.com',
];
const REVIEW_DOMAINS = ['github.com', 'gitlab.com', 'bitbucket.org', 'dev.azure.com'];
const DOCS_DOMAINS = [
  'notion.so', 'notion.site', 'docs.google.com', 'sharepoint.com',
  'confluence.', 'gitbook.io', 'readme.io',
];
const MEETING_DOMAINS = [
  'meet.google.com', 'zoom.us', 'teams.microsoft.com', 'teams.cloud.microsoft',
  'calendar.google.com',
];
const HR_ADMIN_DOMAINS = ['people.zoho.', 'zoho.in', 'okta.com', 'passportindia.gov'];

export function dayBoundsUtc(day) {
  return {
    from: `${day}T00:00:00.000Z`,
    to: `${day}T23:59:59.999Z`,
    fromMs: Date.parse(`${day}T00:00:00.000Z`),
    toMs: Date.parse(`${day}T23:59:59.999Z`),
  };
}

function mapCategory(session) {
  const c = categorizeApp(session);
  if (c === 'Development') return 'coding';
  if (c === 'Communication') return 'meeting';
  if (c === 'Browsing') return 'research';
  return 'other';
}

function domainMatches(domain, list) {
  const d = String(domain || '').toLowerCase();
  if (!d) return false;
  return list.some((x) => d === x || d.endsWith(`.${x}`) || d.includes(x));
}

/** Extract work-type keywords from tab titles without echoing sensitive detail. */
function titleSignals(title) {
  const t = String(title || '').toLowerCase();
  const hits = new Set();
  if (/\b(fix|bug|hotfix|regression|broken)\b/.test(t)) hits.add('bug');
  if (/\b(feature|implement|enhancement|add |new )\b/.test(t)) hits.add('feature');
  if (/\b(test|testing|qa|verify|verification|smoke|e2e|playwright|jest)\b/.test(t)) hits.add('test');
  if (/\b(debug|investigate|troubleshoot|error|failing)\b/.test(t)) hits.add('debug');
  if (/\b(pr|pull request|code review|review)\b/.test(t)) hits.add('review');
  if (/\b(doc|docs|readme|documentation|wiki)\b/.test(t)) hits.add('docs');
  if (/\b(setup|config|configure|install|onboarding)\b/.test(t)) hits.add('config');
  if (/\b(research|learn|tutorial|how to)\b/.test(t)) hits.add('research');
  return hits;
}

/** Meaningful work failures — ignore aborted navigations / download noise. */
function isMeaningfulFailure(event) {
  if (!event) return false;
  if (event.type === 'error') return true;
  if (event.outcome !== 'failure') return false;
  if (event.type === 'download') return false;
  if (event.type === 'navigation') {
    const meta = String(event.metadata_json || '');
    // Local app / auth refused can indicate testing or debugging a running service
    if (/ERR_CONNECTION_REFUSED|ERR_TIMED_OUT/i.test(meta) && /127\.0\.0\.1|localhost/i.test(meta)) {
      return true;
    }
    return false;
  }
  return true;
}

function toolsUsed(appSessions, tabEvidence) {
  const apps = [...new Set(appSessions.map((s) => s.app_name).filter(Boolean))];
  const domains = [...new Set(tabEvidence.map((t) => t.domain).filter(Boolean))];
  return { apps, domains, label: [...apps, ...domains.slice(0, 4)].slice(0, 6).join(', ') || 'Unknown tools' };
}

/** Parse IDE/browser window titles into privacy-safe work signals (no full paths echoed). */
export function parseIdeContext(windowTitle, projectHint) {
  const title = String(windowTitle || '').trim();
  const hint = String(projectHint || '').trim();
  const out = {
    project: hint || null,
    hasCodeFile: false,
    hasTestFile: false,
    hasConfigFile: false,
    hasDocFile: false,
    signals: new Set(),
  };
  if (!title && !hint) return out;
  const blob = `${title} ${hint}`.toLowerCase();
  if (!out.project && title) {
    const parts = title.split(/\s+[—–-]\s+/).map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const skip = new Set(['cursor', 'code', 'visual studio code', 'xcode', 'terminal', 'chrome', 'safari']);
      const cand = parts.length >= 3 ? parts[parts.length - 2] : parts[0];
      if (cand && !skip.has(cand.toLowerCase())) out.project = cand.slice(0, 80);
    }
  }
  if (CODE_FILE_RE.test(title) || /\.(swift|ts|tsx|js|jsx|py|go|rs)\b/i.test(title)) out.hasCodeFile = true;
  if (/\b(test|spec|e2e)\b/i.test(title) || /\.(test|spec)\./i.test(title)) {
    out.hasTestFile = true;
    out.signals.add('test');
  }
  if (/\b(package\.json|toml|yml|yaml|dockerfile|makefile|tsconfig|webpack|vite\.config)\b/i.test(title)) {
    out.hasConfigFile = true;
    out.signals.add('config');
  }
  if (/\.(md|txt|rst)$/i.test(title) || /\breadme\b/i.test(title)) {
    out.hasDocFile = true;
    out.signals.add('docs');
  }
  for (const h of titleSignals(title)) out.signals.add(h);
  if (out.hasCodeFile) out.signals.add('code');
  return out;
}

/** Prefer tabs with meaningful engagement over fleeting opens. */
export function isEngagedTab(tab) {
  const seconds = Number(tab.seconds || tab.duration_seconds || 0);
  const score = Number(tab.engagement_score || 0);
  if (seconds >= 45 || score >= 1) return true;
  if (seconds >= 20 && score >= 0.5) return true;
  // Code-hosting / AI assist visits count sooner
  const d = String(tab.domain || '').toLowerCase();
  if ((domainMatches(d, REVIEW_DOMAINS) || domainMatches(d, AI_ASSIST_DOMAINS) || domainMatches(d, RESEARCH_DOMAINS))
    && seconds >= 15) {
    return true;
  }
  return false;
}

/**
 * Classify work kind from apps, browser context, notes, and meaningful events.
 * Returns inferred descriptions only when signals support them; otherwise uncertain.
 */
export function classifyWorkKind({ appSessions = [], tabEvidence = [], events = [], notes = [] } = {}) {
  const scores = Object.fromEntries(Object.keys(WORK_KIND_LABELS).map((k) => [k, 0]));
  const signals = [];
  const tools = toolsUsed(appSessions, tabEvidence);
  const appBlob = tools.apps.join(' ').toLowerCase();
  const hasDevApp = DEV_APP_RE.test(appBlob) || tools.apps.some((a) => /cursor/i.test(a));
  const hasCommApp = COMM_APP_RE.test(appBlob);
  const hasConfigApp = CONFIG_APP_RE.test(appBlob) && !hasDevApp;
  const hasDocApp = DOC_APP_RE.test(appBlob);

  const ideContexts = appSessions.map((s) => parseIdeContext(s.window_title, s.project_hint));
  const projects = [...new Set(ideContexts.map((c) => c.project).filter(Boolean))];
  const anyCodeFile = ideContexts.some((c) => c.hasCodeFile);
  const anyTestFile = ideContexts.some((c) => c.hasTestFile);
  const anyConfigFile = ideContexts.some((c) => c.hasConfigFile);
  const anyDocFile = ideContexts.some((c) => c.hasDocFile);
  const engagedTabs = tabEvidence.filter(isEngagedTab);

  if (notes?.length) {
    const body = String(notes[0].body || '').toLowerCase();
    signals.push({ factType: 'user_note', label: 'User work note' });
    if (/\b(fix|bug|hotfix)\b/.test(body)) scores.bug_fixing += 8;
    if (/\b(feature|implement|built|added)\b/.test(body)) scores.feature_development += 8;
    if (/\b(test|verified|smoke|qa)\b/.test(body)) scores.testing += 8;
    if (/\b(debug|investigat|troubleshoot)\b/.test(body)) scores.debugging += 8;
    if (/\b(review|pr)\b/.test(body)) scores.review += 6;
    if (/\b(doc|documentation|wrote notes)\b/.test(body)) scores.documentation += 6;
    if (/\b(meeting|call|sync)\b/.test(body)) scores.meeting += 6;
    if (/\b(setup|config|install)\b/.test(body)) scores.configuration += 6;
    if (/\b(research|learn|read)\b/.test(body)) scores.research += 5;
    // Generic note still raises confidence for coding if in a dev app
    if (hasDevApp) scores.coding += 3;
  }

  // IDE window titles (observed) — stronger than app-open alone
  if (anyCodeFile) {
    scores.coding += 5;
    signals.push({ factType: 'observed', label: 'Code file open in editor window title' });
  }
  if (anyTestFile) {
    scores.testing += 5;
    signals.push({ factType: 'observed', label: 'Test-related file in editor window title' });
  }
  if (anyConfigFile) {
    scores.configuration += 4;
    signals.push({ factType: 'observed', label: 'Config file in editor window title' });
  }
  if (anyDocFile) {
    scores.documentation += 4;
    signals.push({ factType: 'observed', label: 'Doc file in editor window title' });
  }
  for (const c of ideContexts) {
    for (const h of c.signals) {
      if (h === 'bug') scores.bug_fixing += 3;
      if (h === 'feature') scores.feature_development += 3;
      if (h === 'debug') scores.debugging += 3;
      if (h === 'review') scores.review += 2;
    }
  }
  if (projects.length) {
    signals.push({ factType: 'observed', label: `Project context: ${projects.slice(0, 3).join(', ')}` });
    if (hasDevApp && anyCodeFile) scores.coding += 1;
  }

  const seenDomains = new Set();
  for (const t of engagedTabs) {
    const d = (t.domain || '').toLowerCase();
    const dup = d && seenDomains.has(d);
    if (d) seenDomains.add(d);

    const isAi = domainMatches(d, AI_ASSIST_DOMAINS);
    // Never score work-type from AI chat titles (often contain words like "Testing" from prompts).
    const hits = isAi ? new Set() : titleSignals(t.title);

    if (isAi && !dup) {
      scores.research += 3;
      if (hasDevApp) scores.coding += 2;
      signals.push({ factType: 'observed', label: `AI assist site (${d})` });
    }
    if (domainMatches(d, RESEARCH_DOMAINS) && !dup) {
      scores.research += 4;
      signals.push({ factType: 'observed', label: `Reference site (${d})` });
    }
    if (domainMatches(d, REVIEW_DOMAINS) && !dup) {
      scores.review += 3;
      if (hits.has('bug') || /\/(issues|pull)\b/i.test(String(t.url || ''))) scores.bug_fixing += 3;
      if (hits.has('feature')) scores.feature_development += 2;
      if (hits.has('review') || /\/pull\b/i.test(String(t.url || ''))) scores.review += 3;
      signals.push({ factType: 'observed', label: `Code hosting (${d})` });
    }
    if (domainMatches(d, DOCS_DOMAINS) && !dup) {
      scores.documentation += 3;
      scores.review += 1;
      signals.push({ factType: 'observed', label: `Documents (${d})` });
    }
    if (domainMatches(d, MEETING_DOMAINS) && !dup) {
      scores.meeting += 5;
      signals.push({ factType: 'observed', label: `Meeting site (${d})` });
    }
    if (domainMatches(d, HR_ADMIN_DOMAINS) && !dup) {
      scores.other += 2;
      signals.push({ factType: 'observed', label: `Admin site (${d})` });
    }
    // Localhost/tracker dashboard alone is not proof of testing.
    const urlBlob = `${d} ${t.title || ''} ${t.url || ''}`;
    const isTrackerUi = /127\.0\.0\.1:8787|localhost:8787/i.test(urlBlob)
      || /mac activity tracker/i.test(String(t.title || ''));
    if (!dup && /playwright|jest|cypress|pytest/i.test(urlBlob)) {
      scores.testing += 4;
      signals.push({ factType: 'inferred', label: 'Test-tool keyword in site/title' });
    } else if (!dup && !isTrackerUi && hasDevApp && /localhost:\d+|127\.0\.0\.1:\d+/i.test(urlBlob)) {
      scores.testing += 2;
      signals.push({ factType: 'inferred', label: 'Local app URL while using a development app' });
    }
    // Title keywords only for code-hosting / docs / research sites — not AI chats or random pages.
    const allowTitleKeywords = domainMatches(d, REVIEW_DOMAINS)
      || domainMatches(d, DOCS_DOMAINS)
      || domainMatches(d, RESEARCH_DOMAINS);
    if (allowTitleKeywords) {
      for (const h of hits) {
        if (h === 'bug') scores.bug_fixing += 3;
        if (h === 'feature') scores.feature_development += 3;
        if (h === 'test') scores.testing += 3;
        if (h === 'debug') scores.debugging += 3;
        if (h === 'review') scores.review += 2;
        if (h === 'docs') scores.documentation += 2;
        if (h === 'config') scores.configuration += 2;
        if (h === 'research') scores.research += 2;
      }
      if (hits.size) {
        signals.push({ factType: 'inferred', label: `Title keywords: ${[...hits].join(', ')}` });
      }
    }
  }

  const meaningfulFailures = events.filter(isMeaningfulFailure);
  if (meaningfulFailures.length && hasDevApp) {
    scores.debugging += 5;
    scores.testing += 1;
    signals.push({
      factType: 'observed',
      label: `${meaningfulFailures.length} meaningful failure/error event(s)`,
    });
  }

  // App presence alone is a weak signal — only mention tools; do not force a work kind.
  if (hasDevApp) {
    signals.push({
      factType: 'observed',
      label: `Development app: ${tools.apps.filter((a) => DEV_APP_RE.test(a) || /cursor/i.test(a)).join(', ')}`,
    });
  }
  if (hasCommApp) {
    scores.meeting += 4;
    signals.push({ factType: 'observed', label: 'Communication app in use' });
  }
  if (hasConfigApp) {
    scores.configuration += 4;
    signals.push({ factType: 'observed', label: 'System/config app in use' });
  }
  if (hasDocApp) {
    scores.documentation += 3;
    signals.push({ factType: 'observed', label: 'Notes/docs app in use' });
  }

  // Pick best non-uncertain score
  let best = 'uncertain';
  let bestScore = 0;
  for (const [k, v] of Object.entries(scores)) {
    if (k === 'uncertain' || k === 'other') continue;
    if (v > bestScore) {
      bestScore = v;
      best = k;
    }
  }
  // Require real supporting evidence (window title, engaged site, note, or failure) — not app-open alone.
  const hasSupportingEvidence = notes?.length
    || anyCodeFile || anyTestFile || anyConfigFile || anyDocFile || projects.length
    || engagedTabs.length > 0
    || meaningfulFailures.length > 0
    || hasCommApp || hasDocApp
    || (hasConfigApp && !hasDevApp);

  if (bestScore < 3 || (hasDevApp && !hasSupportingEvidence && bestScore < 5)) {
    if (!hasSupportingEvidence) {
      best = 'uncertain';
      bestScore = 0;
    } else if (bestScore < 3) {
      best = scores.other >= 2 ? 'other' : 'uncertain';
    }
  }

  let confidence = 'low';
  let factType = 'inferred';
  if (notes?.length) {
    confidence = 'high';
    factType = 'user_note';
  } else if (bestScore >= 8 && signals.some((s) => s.factType === 'observed')) {
    confidence = 'medium';
    factType = 'inferred';
  } else if (best !== 'uncertain' && bestScore >= 4) {
    confidence = 'medium';
    factType = 'inferred';
  } else {
    confidence = 'low';
    factType = best === 'uncertain' ? 'observed' : 'inferred';
  }

  const kindLabel = WORK_KIND_LABELS[best] || WORK_KIND_LABELS.uncertain;
  const projectBit = projects[0] ? ` · ${projects[0]}` : '';
  const title = notes?.length
    ? (String(notes[0].body).trim().length > 80
      ? `${String(notes[0].body).trim().slice(0, 77)}…`
      : String(notes[0].body).trim())
    : best === 'uncertain'
      ? null // UI groups these; no per-card title spam
      : `${kindLabel}${projectBit}`;

  const description = buildWorkDescription({
    best,
    kindLabel,
    tools,
    hasDevApp,
    tabEvidence: engagedTabs,
    notes,
    meaningfulFailures,
    confidence,
    factType,
    projects,
  });

  let outcome = null;
  let unresolved = null;
  if (notes?.length) {
    outcome = {
      factType: 'user_note',
      label: 'Confirmed in your note',
      detail: String(notes[0].body).trim().slice(0, 200),
    };
  } else if (best !== 'uncertain') {
    outcome = {
      factType: 'inferred',
      label: 'In progress / outcome not auto-detected',
      detail: `Detected as “${kindLabel}” from apps, window context, and sites. Completion is not verified automatically.`,
    };
  }

  if (meaningfulFailures.length && !notes?.length) {
    unresolved = {
      factType: 'observed',
      label: 'Possible unresolved issue',
      detail: 'Meaningful failure/error events occurred in this window; resolution was not recorded.',
    };
  }

  return {
    category: best,
    kindLabel,
    title: title || kindLabel,
    description,
    confidence,
    factType,
    tools,
    projects,
    signals: signals.slice(0, 12),
    outcome,
    unresolved,
    meaningfulFailures,
    score: bestScore,
  };
}

function buildWorkDescription({
  best, kindLabel, tools, hasDevApp, tabEvidence, notes, meaningfulFailures, confidence, factType, projects = [],
}) {
  const parts = [];
  if (notes?.length) {
    parts.push(String(notes[0].body).trim().slice(0, 160));
  } else if (best === 'uncertain') {
    parts.push(
      hasDevApp
        ? `Time in ${tools.apps.slice(0, 2).join(', ') || 'a development app'} without enough context to name the task.`
        : 'Activity recorded, but the work type is unclear from available signals.',
    );
  } else {
    const where = projects[0]
      ? ` on ${projects[0]}`
      : tools.domains[0]
        ? ` involving ${tools.domains.slice(0, 2).join(', ')}`
        : tools.apps[0]
          ? ` in ${tools.apps[0]}`
          : '';
    parts.push(`${kindLabel}${where}.`);
  }

  if (tabEvidence?.length && best !== 'uncertain') {
    const domains = [...new Set(tabEvidence.map((t) => t.domain).filter(Boolean))].slice(0, 3);
    if (domains.length) parts.push(`Related sites: ${domains.join(', ')}.`);
  }
  if (meaningfulFailures.length) {
    parts.push(`${meaningfulFailures.length} related failure/error event(s) observed.`);
  }
  if (confidence === 'high') parts.push('Confirmed by your note.');
  else if (best !== 'uncertain') parts.push(`Automatically inferred (${confidence} confidence).`);
  return parts.join(' ');
}

/**
 * Build in-memory work groups for a UTC day without persisting.
 */
export function groupWorkActivity(db, day, { now = Date.now(), fromMs = null, toMs = null } = {}) {
  const bounds = dayBoundsUtc(day);
  const rangeFrom = fromMs != null ? fromMs : bounds.fromMs;
  const rangeTo = toMs != null ? toMs : bounds.toMs;
  const analytics = getAnalytics(db, {
    from: new Date(rangeFrom).toISOString(),
    to: new Date(rangeTo).toISOString(),
    now,
    heal: true,
  });

  let status = {};
  try {
    status = db.prepare(`SELECT last_mac_event_at, last_chrome_event_at FROM tracker_status WHERE id = 1`).get() || {};
  } catch {
    status = {};
  }
  const macCeil = activityCeilingMs(status.last_mac_event_at, now);
  const chromeCeil = activityCeilingMs(status.last_chrome_event_at, now);

  const fromIso = new Date(rangeFrom).toISOString();
  const toIso = new Date(rangeTo).toISOString();
  const appSessions = queryOverlappingSessions(db, 'app_sessions', fromIso, toIso)
    .filter((s) => Number(s.was_idle) !== 1);

  const tabSessions = queryOverlappingSessions(db, 'tab_sessions', fromIso, toIso);

  const events = db.prepare(`
    SELECT id, timestamp, type, outcome, app_name, metadata_json, source
    FROM events
    WHERE timestamp >= ? AND timestamp <= ?
    ORDER BY timestamp ASC
  `).all(new Date(rangeFrom).toISOString(), new Date(rangeTo).toISOString());

  const notes = db.prepare(`
    SELECT * FROM work_notes WHERE day = ? ORDER BY created_at ASC
  `).all(day);

  const memories = db.prepare(`
    SELECT id, title, body, created_at FROM memories
    WHERE substr(created_at,1,10)=? OR substr(updated_at,1,10)=?
    ORDER BY created_at ASC LIMIT 50
  `).all(day, day);

  // Clip apps into intervals for grouping order
  const clippedApps = [];
  for (const session of appSessions) {
    const { seconds, interval, incomplete } = clippedSessionSeconds(
      session, rangeFrom, rangeTo, now, macCeil,
    );
    if (!interval || seconds <= 0) continue;
    // Skip system lock screen via analytics exclusion path — loginwindow still in raw query
    const bid = session.bundle_identifier || '';
    if (bid === 'com.apple.loginwindow' || (session.app_name || '').toLowerCase() === 'loginwindow') continue;
    const ide = parseIdeContext(session.window_title, session.project_hint);
    clippedApps.push({
      session,
      seconds,
      interval,
      incomplete,
      startMs: interval[0],
      endMs: interval[1],
      category: mapCategory(session),
      project: ide.project,
    });
  }
  clippedApps.sort((a, b) => a.startMs - b.startMs);

  const groups = [];
  let current = null;
  for (const item of clippedApps) {
    if (!current) {
      current = { items: [item], category: item.category, project: item.project || null };
      continue;
    }
    const last = current.items[current.items.length - 1];
    const gap = item.startMs - last.endMs;
    const sameProject = current.project && item.project && current.project === item.project;
    const sameDevFamily = current.category === 'coding' && item.category === 'coding';
    const categoryChanged = item.category !== current.category;
    // Keep related development fragments together, especially same project.
    const allowMerge = gap <= GAP_SPLIT_MS
      && (!categoryChanged || sameProject || (sameDevFamily && gap <= GAP_SPLIT_MS));
    const forceSplit = gap > GAP_SPLIT_MS || (categoryChanged && !sameProject && gap > CATEGORY_GAP_MS);
    if (forceSplit || !allowMerge) {
      groups.push(current);
      current = { items: [item], category: item.category, project: item.project || null };
    } else {
      current.items.push(item);
      if (!current.project && item.project) current.project = item.project;
    }
  }
  if (current) groups.push(current);

  const workSessions = groups.map((g, idx) => {
    const startMs = Math.min(...g.items.map((i) => i.startMs));
    const endMs = Math.max(...g.items.map((i) => i.endMs));
    const appIntervals = g.items.map((i) => i.interval);
    const estimatedSeconds = unionIntervalSeconds(appIntervals);
    const apps = g.items.map((i) => i.session);

    const overlappingTabs = tabSessions.filter((t) => {
      const { interval } = clippedSessionSeconds(t, rangeFrom, rangeTo, now, chromeCeil);
      if (!interval) return false;
      return interval[0] < endMs && interval[1] > startMs;
    }).map((t) => {
      const { seconds, interval } = clippedSessionSeconds(t, rangeFrom, rangeTo, now, chromeCeil);
      return { ...t, seconds, interval };
    }).filter((t) => {
      if (!t.seconds || t.seconds <= 0) return false;
      const tabStart = Date.parse(t.started_at);
      const startedInWindow = Number.isFinite(tabStart)
        && tabStart >= startMs - 5 * 60 * 1000
        && tabStart <= endMs + 5 * 60 * 1000;
      if (!(startedInWindow || t.seconds >= 120)) return false;
      return isEngagedTab(t);
    });

    const windowEvents = events.filter((e) => {
      const ts = Date.parse(e.timestamp);
      return ts >= startMs && ts <= endMs;
    });

    const windowNotes = notes.filter((n) => {
      if (n.work_session_id) return false; // assigned later when persisted
      const ts = Date.parse(n.created_at);
      return Number.isFinite(ts) && ts >= startMs && ts <= endMs + 60 * 60 * 1000;
    });

    const classified = classifyWorkKind({
      appSessions: apps,
      tabEvidence: overlappingTabs,
      events: windowEvents,
      notes: windowNotes,
    });

    const problems = (classified.meaningfulFailures || []).slice(0, 10).map((e) => ({
      factType: 'observed',
      label: e.type === 'error' ? 'Application error event' : 'Meaningful failure event',
      detail: e.app_name ? `Related app: ${e.app_name}` : 'Recorded without inventing the root cause',
      evidenceId: e.id,
      timestamp: e.timestamp,
    }));
    if (classified.unresolved) {
      problems.push({
        factType: classified.unresolved.factType,
        label: classified.unresolved.label,
        detail: classified.unresolved.detail,
      });
    }

    const tests = classified.category === 'testing'
      ? [{
        factType: 'inferred',
        label: 'Testing/verification activity inferred from tools and sites',
        detail: 'Not proof of pass/fail — add a note to confirm results.',
      }]
      : [];

    const fixes = [];
    if (classified.category === 'bug_fixing' || classified.category === 'debugging') {
      fixes.push({
        factType: 'inferred',
        label: classified.category === 'bug_fixing'
          ? 'Possible bug-fixing work'
          : 'Possible debugging/investigation',
        detail: 'Inferred from activity context. Whether the issue was resolved is unknown unless you add a note.',
      });
    }
    if (classified.outcome) {
      fixes.push({
        factType: classified.outcome.factType,
        label: classified.outcome.label,
        detail: classified.outcome.detail,
      });
    }

    const evidence = [];
    for (const item of g.items) {
      evidence.push({
        evidence_type: 'app_session',
        evidence_id: item.session.id,
        label: item.session.app_name || 'App',
        detail: item.session.bundle_identifier || null,
        fact_type: 'observed',
        started_at: new Date(item.startMs).toISOString(),
        ended_at: new Date(item.endMs).toISOString(),
        seconds: item.seconds,
      });
    }
    for (const t of overlappingTabs.slice(0, 20)) {
      // Privacy: store domain + generic site role, not full titles/URLs with filenames or prompts
      evidence.push({
        evidence_type: 'tab_session',
        evidence_id: t.id,
        label: t.domain || 'Website',
        detail: 'Browser visit (page contents not captured)',
        fact_type: 'observed',
        started_at: t.interval ? new Date(t.interval[0]).toISOString() : t.started_at,
        ended_at: t.interval ? new Date(t.interval[1]).toISOString() : t.ended_at,
        seconds: t.seconds,
      });
    }
    for (const e of (classified.meaningfulFailures || []).slice(0, 10)) {
      evidence.push({
        evidence_type: 'event',
        evidence_id: e.id,
        label: e.type,
        detail: 'Meaningful failure/error (details redacted in summary)',
        fact_type: 'observed',
        started_at: e.timestamp,
        ended_at: null,
        seconds: null,
      });
    }
    for (const sig of classified.signals.slice(0, 8)) {
      evidence.push({
        evidence_type: 'signal',
        evidence_id: null,
        label: sig.label,
        detail: null,
        fact_type: sig.factType,
        started_at: null,
        ended_at: null,
        seconds: null,
      });
    }
    for (const m of memories) {
      const ts = Date.parse(m.created_at);
      if (Number.isFinite(ts) && ts >= startMs && ts <= endMs + 2 * 60 * 60 * 1000) {
        evidence.push({
          evidence_type: 'memory',
          evidence_id: m.id,
          label: m.title,
          detail: m.body,
          fact_type: 'user_note',
          started_at: m.created_at,
          ended_at: null,
          seconds: null,
        });
      }
    }

    const incomplete = g.items.some((i) => i.incomplete);
    let confidence = classified.confidence;
    // Only user notes can raise confidence to high; nearby memories are supporting context only.
    if (windowNotes.length) {
      confidence = 'high';
    } else if (classified.category !== 'uncertain' && memories.some((m) => {
      const ts = Date.parse(m.created_at);
      return Number.isFinite(ts) && ts >= startMs && ts <= endMs;
    })) {
      if (confidence === 'low') confidence = 'medium';
    }

    return {
      id: `draft-${day}-${idx}`,
      day,
      title: classified.title,
      category: classified.category,
      started_at: new Date(startMs).toISOString(),
      ended_at: new Date(endMs).toISOString(),
      estimated_seconds: estimatedSeconds,
      summary: classified.description,
      problems,
      fixes,
      tests,
      status: incomplete ? 'open' : (classified.category === 'uncertain' ? 'uncertain' : 'inferred'),
      confidence,
      user_edited: 0,
      evidence,
      tools: classified.tools,
      outcome: classified.outcome,
      unresolved: classified.unresolved,
      kind_label: classified.kindLabel,
      fact_type: classified.factType,
      time: {
        appActiveSeconds: estimatedSeconds,
        browserSupportCount: overlappingTabs.length,
        unclassified: classified.category === 'uncertain',
      },
    };
  });

  // Idle / unknown as report metadata (not tasks)
  const idle = db.prepare(`
    SELECT COALESCE(SUM(duration_seconds),0) AS s FROM idle_periods
    WHERE started_at < ? AND (ended_at IS NULL OR ended_at > ?)
  `).get(toIso, fromIso).s;

  const gaps = db.prepare(`
    SELECT COUNT(*) AS c, COALESCE(SUM(duration_seconds),0) AS s FROM tracking_gaps
    WHERE started_at < ? AND ended_at > ?
  `).get(toIso, fromIso);

  return {
    day,
    range: { from: new Date(rangeFrom).toISOString(), to: new Date(rangeTo).toISOString() },
    sessions: workSessions,
    analytics: {
      totalTrackedAppSeconds: analytics.summary.totalTrackedAppSeconds,
      totalBrowserSeconds: analytics.summary.totalBrowserSeconds,
    },
    idle_seconds: idle,
    gap_seconds: gaps.s,
    gap_count: gaps.c,
    notes,
    disclaimer:
      'Work kinds are inferred from apps, websites, and your notes. Titles describe the type of work, not technical details. This does not invent accomplishments. Prompts, code, filenames, and private page contents are not captured.',
  };
}

/** Persist regenerated groups for a day (replaces non-user-edited drafts). */
export function rebuildWorkSessions(db, day, opts = {}) {
  // Always group the full calendar day. Hour-range filters belong to reports/queries only —
  // applying them here would delete out-of-range sessions for the day.
  const built = groupWorkActivity(db, day, { now: opts.now ?? Date.now() });

  // Keep user-edited sessions; remove prior inferred ones for this day
  const edited = db.prepare(`
    SELECT id FROM work_sessions WHERE day = ? AND user_edited = 1 AND merged_into_id IS NULL
  `).all(day);
  const editedIds = new Set(edited.map((r) => r.id));

  const old = db.prepare(`
    SELECT id FROM work_sessions WHERE day = ? AND user_edited = 0
  `).all(day);
  const delEv = db.prepare('DELETE FROM work_session_evidence WHERE work_session_id = ?');
  const delWs = db.prepare('DELETE FROM work_sessions WHERE id = ?');
  for (const row of old) {
    delEv.run(row.id);
    delWs.run(row.id);
  }

  const insertWs = db.prepare(`
    INSERT INTO work_sessions (
      id, day, title, category, started_at, ended_at, estimated_seconds,
      summary, problems_json, fixes_json, tests_json, status, confidence, user_edited
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `);
  const insertEv = db.prepare(`
    INSERT INTO work_session_evidence (
      id, work_session_id, evidence_type, evidence_id, label, detail, fact_type,
      started_at, ended_at, seconds
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const saved = [];
  for (const s of built.sessions) {
    // Skip drafts that heavily overlap a user-edited session
    const overlapsEdited = [...editedIds].some((eid) => {
      const e = db.prepare('SELECT started_at, ended_at FROM work_sessions WHERE id = ?').get(eid);
      if (!e) return false;
      const a0 = Date.parse(s.started_at);
      const a1 = Date.parse(s.ended_at);
      const b0 = Date.parse(e.started_at);
      const b1 = Date.parse(e.ended_at || e.started_at);
      return a0 < b1 && a1 > b0;
    });
    if (overlapsEdited) continue;

    const id = crypto.randomUUID();
    insertWs.run(
      id,
      day,
      s.title,
      s.category,
      s.started_at,
      s.ended_at,
      s.estimated_seconds,
      s.summary,
      JSON.stringify(s.problems),
      JSON.stringify(s.fixes),
      JSON.stringify(s.tests),
      s.status,
      s.confidence,
    );
    for (const ev of s.evidence) {
      insertEv.run(
        crypto.randomUUID(),
        id,
        ev.evidence_type,
        ev.evidence_id,
        ev.label,
        ev.detail,
        ev.fact_type,
        ev.started_at,
        ev.ended_at,
        ev.seconds,
      );
    }
    saved.push(getWorkSession(db, id));
  }

  // Include edited sessions in listing
  for (const eid of editedIds) {
    const row = getWorkSession(db, eid);
    if (row) saved.push(row);
  }
  saved.sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));

  return {
    ...built,
    sessions: saved,
    rebuilt_at: new Date().toISOString(),
  };
}

export function listWorkSessions(db, day) {
  const rows = db.prepare(`
    SELECT * FROM work_sessions
    WHERE day = ? AND merged_into_id IS NULL
    ORDER BY started_at ASC
  `).all(day);
  return rows.map((r) => hydrateWorkSession(db, r));
}

export function getWorkSession(db, id) {
  const row = db.prepare('SELECT * FROM work_sessions WHERE id = ?').get(id);
  if (!row) return null;
  return hydrateWorkSession(db, row);
}

function hydrateWorkSession(db, row) {
  const evidence = db.prepare(`
    SELECT * FROM work_session_evidence WHERE work_session_id = ? ORDER BY started_at ASC
  `).all(row.id);
  const notes = db.prepare(`
    SELECT * FROM work_notes WHERE work_session_id = ? ORDER BY created_at ASC
  `).all(row.id);
  const problems = safeJson(row.problems_json, []);
  const fixes = safeJson(row.fixes_json, []);
  const tests = safeJson(row.tests_json, []);
  const tools = {
    apps: [...new Set(evidence.filter((e) => e.evidence_type === 'app_session').map((e) => e.label).filter(Boolean))],
    domains: [...new Set(evidence.filter((e) => e.evidence_type === 'tab_session').map((e) => e.label).filter(Boolean))],
  };
  tools.label = [...tools.apps, ...tools.domains.slice(0, 4)].slice(0, 6).join(', ') || 'Unknown tools';
  const outcome = fixes.find((f) => /outcome/i.test(f.label || '')) || null;
  const unresolved = problems.find((p) => /unresolved/i.test(p.label || '')) || null;
  return {
    ...row,
    problems,
    fixes,
    tests,
    evidence,
    notes,
    tools,
    outcome,
    unresolved,
    kind_label: WORK_KIND_LABELS[row.category] || row.category,
    estimated_duration: formatDuration(row.estimated_seconds),
  };
}

function safeJson(raw, fallback) {
  try {
    return JSON.parse(raw || 'null') ?? fallback;
  } catch {
    return fallback;
  }
}

export function updateWorkSession(db, id, patch) {
  const cur = getWorkSession(db, id);
  if (!cur) return null;
  const title = patch.title != null ? String(patch.title).trim() || cur.title : cur.title;
  const category = patch.category != null ? String(patch.category) : cur.category;
  const status = patch.status != null ? String(patch.status) : cur.status;
  const summary = patch.summary != null ? String(patch.summary) : cur.summary;
  db.prepare(`
    UPDATE work_sessions
    SET title=?, category=?, status=?, summary=?, user_edited=1, confidence='high',
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=?
  `).run(title, category, status, summary, id);
  return getWorkSession(db, id);
}

export function addWorkNote(db, { day, body, workSessionId = null }) {
  const id = crypto.randomUUID();
  const text = String(body || '').trim();
  if (!text) throw new Error('note_required');
  const d = day || new Date().toISOString().slice(0, 10);
  db.prepare(`
    INSERT INTO work_notes (id, work_session_id, day, body) VALUES (?, ?, ?, ?)
  `).run(id, workSessionId, d, text);
  if (workSessionId) {
    db.prepare(`
      UPDATE work_sessions SET user_edited=1, confidence='high',
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=?
    `).run(workSessionId);
  }
  return db.prepare('SELECT * FROM work_notes WHERE id = ?').get(id);
}

export function mergeWorkSessions(db, ids) {
  const list = [...new Set(ids || [])].map((id) => getWorkSession(db, id)).filter(Boolean);
  if (list.length < 2) throw new Error('need_two_sessions');
  list.sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
  const primary = list[0];
  const rest = list.slice(1);
  const started = primary.started_at;
  const ended = list.map((s) => s.ended_at).sort().at(-1);
  const intervals = list.map((s) => [Date.parse(s.started_at), Date.parse(s.ended_at)]);
  const estimated = unionIntervalSeconds(intervals);
  const title = primary.user_edited ? primary.title : `Merged: ${list.map((s) => s.title).slice(0, 3).join(' + ')}`;
  db.prepare(`
    UPDATE work_sessions
    SET title=?, started_at=?, ended_at=?, estimated_seconds=?, user_edited=1, confidence='high',
        status='merged', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=?
  `).run(title, started, ended, estimated, primary.id);

  const moveEv = db.prepare(`
    UPDATE work_session_evidence SET work_session_id=? WHERE work_session_id=?
  `);
  const moveNotes = db.prepare(`
    UPDATE work_notes SET work_session_id=? WHERE work_session_id=?
  `);
  for (const s of rest) {
    moveEv.run(primary.id, s.id);
    moveNotes.run(primary.id, s.id);
    db.prepare(`
      UPDATE work_sessions SET merged_into_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=?
    `).run(primary.id, s.id);
  }
  return getWorkSession(db, primary.id);
}

export function splitWorkSession(db, id, atIso) {
  const cur = getWorkSession(db, id);
  if (!cur) return null;
  const at = Date.parse(atIso);
  const start = Date.parse(cur.started_at);
  const end = Date.parse(cur.ended_at);
  if (!Number.isFinite(at) || at <= start || at >= end) throw new Error('invalid_split_point');

  const leftEnd = new Date(at).toISOString();
  const rightStart = leftEnd;
  db.prepare(`
    UPDATE work_sessions
    SET ended_at=?, estimated_seconds=?, user_edited=1, confidence='high',
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=?
  `).run(leftEnd, Math.max(0, (at - start) / 1000), id);

  const rightId = crypto.randomUUID();
  db.prepare(`
    INSERT INTO work_sessions (
      id, day, title, category, started_at, ended_at, estimated_seconds,
      summary, problems_json, fixes_json, tests_json, status, confidence, user_edited
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', '[]', 'inferred', 'medium', 1)
  `).run(
    rightId,
    cur.day,
    `${cur.title} (part 2)`,
    cur.category,
    rightStart,
    cur.ended_at,
    Math.max(0, (end - at) / 1000),
    cur.summary,
  );

  // Move evidence that starts on/after split to the right session
  const evidence = db.prepare(`SELECT * FROM work_session_evidence WHERE work_session_id=?`).all(id);
  for (const ev of evidence) {
    const evStart = Date.parse(ev.started_at || '');
    if (Number.isFinite(evStart) && evStart >= at) {
      db.prepare(`UPDATE work_session_evidence SET work_session_id=? WHERE id=?`).run(rightId, ev.id);
    }
  }

  return { left: getWorkSession(db, id), right: getWorkSession(db, rightId) };
}

/**
 * On-demand daily work report.
 */
export function buildDailyWorkReport(db, day, { now = Date.now(), fromMs = null, toMs = null, rebuild = true } = {}) {
  // Persist full-day groups when requested; filter by hour range only for the report output.
  if (rebuild) {
    rebuildWorkSessions(db, day, { now });
  }

  const bounds = dayBoundsUtc(day);
  const rangeFrom = fromMs != null ? fromMs : bounds.fromMs;
  const rangeTo = toMs != null ? toMs : bounds.toMs;
  const meta = groupWorkActivity(db, day, { now, fromMs: rangeFrom, toMs: rangeTo });

  let sessions = listWorkSessions(db, day).filter((s) => !s.merged_into_id);
  if (fromMs != null || toMs != null) {
    const f = fromMs != null ? fromMs : -Infinity;
    const t = toMs != null ? toMs : Infinity;
    sessions = sessions.filter((s) => {
      const a = Date.parse(s.started_at);
      const b = Date.parse(s.ended_at || s.started_at);
      return Number.isFinite(a) && a < t && b > f;
    });
  }

  const grouped = {
    ...meta,
    sessions,
  };

  const timeline = sessions.map((s) => ({
    id: s.id,
    title: s.title,
    category: s.category,
    kind_label: s.kind_label || WORK_KIND_LABELS[s.category] || s.category,
    tools: s.tools?.label || null,
    started_at: s.started_at,
    ended_at: s.ended_at,
    estimated_seconds: s.estimated_seconds,
    estimated_duration: formatDuration(s.estimated_seconds),
    confidence: s.confidence,
    status: s.status,
    outcome: s.outcome || null,
    unresolved: s.unresolved || null,
    evidence_count: (s.evidence || []).length,
  }));

  const byCategory = {};
  for (const s of sessions) {
    const key = s.kind_label || WORK_KIND_LABELS[s.category] || s.category;
    byCategory[key] = (byCategory[key] || 0) + Number(s.estimated_seconds || 0);
  }

  const problems = sessions.flatMap((s) =>
    (s.problems || []).map((p) => ({ ...p, task: s.title, taskId: s.id })),
  );
  const tests = sessions.flatMap((s) =>
    (s.tests || []).map((t) => ({ ...t, task: s.title, taskId: s.id })),
  );
  const identified = sessions.filter((s) => s.category !== 'uncertain');
  const unidentified = sessions.filter((s) => s.category === 'uncertain');
  const incomplete = sessions.filter((s) =>
    s.status === 'open' || s.unresolved || (s.category !== 'uncertain' && /not auto-detected|not confirmed/i.test(s.outcome?.label || '')),
  );

  const taskSecondsExclusive = unionIntervalSeconds(
    sessions.map((s) => [Date.parse(s.started_at), Date.parse(s.ended_at)]),
  );

  const overallSummary = buildOverallWorkSummary(sessions);
  const unidentifiedSeconds = unidentified.reduce((a, s) => a + Number(s.estimated_seconds || 0), 0);

  const report = {
    day,
    generated_at: new Date(now).toISOString(),
    kind: 'work_report',
    disclaimer: grouped.disclaimer,
    overall_summary: overallSummary,
    identified_tasks: identified.map(taskPayload),
    unidentified_activity: {
      count: unidentified.length,
      estimated_seconds: unidentifiedSeconds,
      estimated_duration: formatDuration(unidentifiedSeconds),
      apps: [...new Set(unidentified.flatMap((s) => s.tools?.apps || []))].slice(0, 8),
      note: unidentified.length
        ? 'These blocks had app activity but not enough context (window title, engaged website, or note) to name the task.'
        : null,
      sessions: unidentified.map(taskPayload),
    },
    main_tasks: identified.map(taskPayload),
    timeline: timeline.filter((t) => t.category !== 'uncertain'),
    timeline_all: timeline,
    development_and_debugging: sessions.filter((s) =>
      ['coding', 'feature_development', 'bug_fixing', 'debugging', 'testing', 'development'].includes(s.category),
    ).map((s) => ({
      title: s.title,
      category: s.category,
      kind_label: s.kind_label || WORK_KIND_LABELS[s.category],
      summary: s.summary,
      problems: s.problems,
      fixes: s.fixes,
    })),
    tests_performed: tests,
    problems_and_resolutions: problems,
    incomplete_or_unresolved: incomplete.map((s) => ({
      id: s.id,
      title: s.title,
      status: s.status,
      note: s.unresolved?.detail
        || (s.status === 'open'
          ? 'Session still open or clipped when report was built.'
          : 'Work type or outcome still needs your confirmation.'),
    })),
    time: {
      appActiveSeconds: grouped.analytics.totalTrackedAppSeconds,
      browserElapsedSeconds: grouped.analytics.totalBrowserSeconds,
      estimatedTaskSecondsExclusive: taskSecondsExclusive,
      estimatedTaskSecondsSum: sessions.reduce((a, s) => a + Number(s.estimated_seconds || 0), 0),
      idleSeconds: grouped.idle_seconds,
      gapSeconds: grouped.gap_seconds,
      byCategory,
      note:
        'Task durations use exclusive unions within each task. Sum of task estimates can exceed exclusive task-span union when gaps exist between tasks; Overview app/browser totals remain the source of truth for whole-day elapsed time.',
    },
    unknown: [
      'Prompt contents, code diffs, filenames, and exact test results are not captured.',
      'Browser domains show visits, not what was accomplished on the page.',
      'Add a work note to record outcomes the tracker cannot observe.',
    ],
    text: formatWorkReportText({
      day,
      sessions,
      timeline,
      problems,
      tests,
      incomplete,
      overallSummary,
      time: {
        app: formatDuration(grouped.analytics.totalTrackedAppSeconds),
        browser: formatDuration(grouped.analytics.totalBrowserSeconds),
        tasks: formatDuration(taskSecondsExclusive),
        idle: formatDuration(grouped.idle_seconds),
      },
    }),
  };

  return report;
}

function taskPayload(s) {
  return {
    id: s.id,
    title: s.title,
    category: s.category,
    kind_label: s.kind_label || WORK_KIND_LABELS[s.category] || s.category,
    tools: s.tools?.label || null,
    estimated_seconds: s.estimated_seconds,
    estimated_duration: formatDuration(s.estimated_seconds),
    started_at: s.started_at,
    ended_at: s.ended_at,
    confidence: s.confidence,
    summary: s.summary,
    outcome: s.outcome || null,
    unresolved: s.unresolved || null,
    projects: s.tools?.apps ? undefined : undefined,
    factTypes: {
      observed: (s.evidence || []).filter((e) => e.fact_type === 'observed').length,
      user_note: (s.notes || []).length + (s.evidence || []).filter((e) => e.fact_type === 'user_note').length,
      inferred: (s.fixes || []).filter((f) => f.factType === 'inferred').length,
    },
  };
}

function buildOverallWorkSummary(sessions) {
  if (!sessions.length) {
    return 'No grouped work sessions for this day. Tracking may have been idle, or activity could not be classified.';
  }
  const identified = sessions.filter((s) => s.category !== 'uncertain');
  const uncertain = sessions.filter((s) => s.category === 'uncertain');
  if (!identified.length) {
    return `No clearly identified tasks yet (${uncertain.length} unidentified block(s)). Window titles and browser activity strengthen automatic detection.`;
  }
  const counts = {};
  for (const s of identified) {
    const label = s.kind_label || WORK_KIND_LABELS[s.category] || s.category;
    counts[label] = (counts[label] || 0) + 1;
  }
  const parts = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([label, n]) => `${n}× ${label}`);
  let text = `Identified work: ${parts.join('; ')}.`;
  if (uncertain.length) {
    text += ` ${uncertain.length} additional block(s) could not be identified and are listed separately.`;
  }
  return text;
}

function formatWorkReportText({ day, sessions, timeline, problems, tests, incomplete, overallSummary, time }) {
  const identified = sessions.filter((s) => s.category !== 'uncertain');
  const unidentified = sessions.filter((s) => s.category === 'uncertain');
  const lines = [
    `Daily work report for ${day}`,
    '',
    'Overall summary:',
    overallSummary || 'No summary available.',
    '',
    'Time (recorded):',
    `• App active: ${time.app}`,
    `• Browser elapsed: ${time.browser}`,
    `• Estimated task span (exclusive): ${time.tasks}`,
    `• Idle: ${time.idle}`,
    '',
    'Identified work:',
  ];
  if (!identified.length) {
    lines.push('• None yet — need window titles and/or engaged browser activity.');
  } else {
    for (const s of identified) {
      const kind = s.kind_label || WORK_KIND_LABELS[s.category] || s.category;
      const tools = s.tools?.label ? `; tools: ${s.tools.label}` : '';
      lines.push(
        `• [${kind}] ${s.title} (~${formatDuration(s.estimated_seconds)}, ${s.confidence}${tools})`,
      );
      if (s.summary) lines.push(`  ${s.summary}`);
    }
  }
  if (unidentified.length) {
    const secs = unidentified.reduce((a, s) => a + Number(s.estimated_seconds || 0), 0);
    lines.push('', `Could not identify: ${unidentified.length} block(s), ~${formatDuration(secs)} total (listed separately in the UI).`);
  }
  lines.push('', 'Chronological timeline (identified):');
  const tl = (timeline || []).filter((t) => t.category !== 'uncertain');
  if (!tl.length) lines.push('• None.');
  else for (const t of tl) {
    const kind = t.kind_label || t.category;
    lines.push(`• ${t.started_at} → ${t.ended_at}: [${kind}] ${t.title} (${t.estimated_duration})`);
  }
  if (problems.length) {
    lines.push('', 'Observed issues:');
    for (const p of problems.slice(0, 10)) lines.push(`• ${p.task}: ${p.label}`);
  }
  if (tests.length) {
    lines.push('', 'Possible testing:');
    for (const t of tests.slice(0, 8)) lines.push(`• ${t.task}: ${t.label}`);
  }
  lines.push(
    '',
    'Automatic summary from tracked evidence. Does not invent accomplishments.',
  );
  return lines.join('\n');
}

export { CATEGORY_LABELS, GAP_SPLIT_MS };
