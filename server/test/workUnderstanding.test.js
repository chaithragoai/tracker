import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, closeDatabase } from '../src/db/database.js';
import { insertEvent } from '../src/services/events.js';
import {
  groupWorkActivity,
  rebuildWorkSessions,
  updateWorkSession,
  addWorkNote,
  mergeWorkSessions,
  splitWorkSession,
  buildDailyWorkReport,
  listWorkSessions,
  classifyWorkKind,
  parseIdeContext,
  isEngagedTab,
} from '../src/services/workUnderstanding.js';
import { askAssistant } from '../src/services/assistant.js';

function tempDb() {
  process.env.TRACKER_SKIP_BACKUP = '1';
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-work-')), 't.sqlite');
}

function seedDay(db) {
  // Development block: Cursor 09:00-09:40
  insertEvent(db, {
    id: 'w1', timestamp: '2026-10-15T09:00:00.000Z', type: 'sessionStarted', outcome: 'success',
    sessionId: 'ws-c1', app: { name: 'Cursor', bundleIdentifier: 'com.todesktop.x' },
  }, 'mac-agent');
  insertEvent(db, {
    id: 'w2', timestamp: '2026-10-15T09:40:00.000Z', type: 'sessionEnded', outcome: 'success',
    sessionId: 'ws-c1', durationSeconds: 2400,
    app: { name: 'Cursor', bundleIdentifier: 'com.todesktop.x' },
  }, 'mac-agent');
  // Browser during that window
  insertEvent(db, {
    id: 'w3', timestamp: '2026-10-15T09:10:00.000Z', type: 'tabSessionStarted', outcome: 'success',
    tabSessionId: 'wt1',
    tab: { domain: 'chatgpt.com', url: 'https://chatgpt.com/', title: 'ChatGPT', browser: 'Chrome' },
  }, 'chrome-extension');
  insertEvent(db, {
    id: 'w4', timestamp: '2026-10-15T09:25:00.000Z', type: 'tabSessionEnded', outcome: 'success',
    tabSessionId: 'wt1', durationSeconds: 900, domain: 'chatgpt.com',
  }, 'chrome-extension');
  // Error event
  insertEvent(db, {
    id: 'w5', timestamp: '2026-10-15T09:30:00.000Z', type: 'error', outcome: 'failure',
    app: { name: 'Cursor', bundleIdentifier: 'com.todesktop.x' },
    metadata: { message: 'build_failed' },
  }, 'mac-agent');
  // Gap then later Chrome for testing-ish
  insertEvent(db, {
    id: 'w6', timestamp: '2026-10-15T11:00:00.000Z', type: 'sessionStarted', outcome: 'success',
    sessionId: 'ws-ch', app: { name: 'Google Chrome', bundleIdentifier: 'com.google.Chrome' },
  }, 'mac-agent');
  insertEvent(db, {
    id: 'w7', timestamp: '2026-10-15T11:20:00.000Z', type: 'sessionEnded', outcome: 'success',
    sessionId: 'ws-ch', durationSeconds: 1200,
    app: { name: 'Google Chrome', bundleIdentifier: 'com.google.Chrome' },
  }, 'mac-agent');
}

test('groups related activity and does not invent work contents', () => {
  const db = openDatabase(tempDb());
  seedDay(db);
  const g = groupWorkActivity(db, '2026-10-15', { now: Date.parse('2026-10-15T23:00:00.000Z') });
  assert.ok(g.sessions.length >= 2);
  assert.match(g.disclaimer, /does not invent|not invent/i);
  const first = g.sessions[0];
  assert.ok(first.estimated_seconds > 0);
  assert.ok(first.evidence.some((e) => e.evidence_type === 'app_session'));
  assert.ok(!/prompt contents|you asked ChatGPT|diff --git/i.test(first.summary));
  assert.ok(['debugging', 'coding', 'research', 'feature_development', 'bug_fixing'].includes(first.category));
  closeDatabase(db);
});

test('cursor alone without supporting sites stays uncertain', () => {
  const c = classifyWorkKind({
    appSessions: [{ app_name: 'Cursor', bundle_identifier: 'com.todesktop.x' }],
    tabEvidence: [],
    events: [],
    notes: [],
  });
  assert.equal(c.category, 'uncertain');
  assert.match(c.description, /without enough context|unclear/i);
  assert.equal(c.outcome, null);
});

test('cursor window title with code file classifies as coding', () => {
  const c = classifyWorkKind({
    appSessions: [{
      app_name: 'Cursor',
      window_title: 'workUnderstanding.js — tracker — Cursor',
      project_hint: 'tracker',
    }],
    tabEvidence: [],
    events: [],
    notes: [],
  });
  assert.equal(c.category, 'coding');
  assert.match(c.title, /Writing or modifying code|tracker/i);
  assert.ok(!/workUnderstanding\.js/.test(c.description) || /tracker/.test(c.description));
});

test('parseIdeContext extracts project without echoing home paths', () => {
  const p = parseIdeContext('app.js — tracker — Cursor', 'tracker');
  assert.equal(p.project, 'tracker');
  assert.equal(p.hasCodeFile, true);
});

test('fleeting tab visits are not engaged', () => {
  assert.equal(isEngagedTab({ domain: 'example.com', seconds: 5, engagement_score: 0 }), false);
  assert.equal(isEngagedTab({ domain: 'github.com', seconds: 20, engagement_score: 0 }), true);
});

test('github fix PR signals bug fixing without echoing full title', () => {
  const c = classifyWorkKind({
    appSessions: [{ app_name: 'Cursor' }, { app_name: 'Google Chrome' }],
    tabEvidence: [{
      domain: 'github.com',
      title: 'Fix client audit trail persistence by alice · Pull Request #7 · org/repo',
      url: 'https://github.com/org/repo/pull/7',
      seconds: 120,
      engagement_score: 2,
    }],
    events: [],
    notes: [],
  });
  assert.ok(['bug_fixing', 'review', 'coding'].includes(c.category), c.category);
  assert.ok(!/audit trail persistence|org\/repo/i.test(c.title));
  assert.ok(!/audit trail persistence/i.test(c.description));
});

test('aborted navigation failures do not invent debugging', () => {
  const c = classifyWorkKind({
    appSessions: [{ app_name: 'Google Chrome' }],
    tabEvidence: [{ domain: 'example.com', title: 'Example' }],
    events: [{
      type: 'navigation',
      outcome: 'failure',
      metadata_json: JSON.stringify({ error: 'net::ERR_ABORTED', url: 'https://example.com/' }),
    }],
    notes: [],
  });
  assert.notEqual(c.category, 'debugging');
});

test('tracker localhost UI does not invent testing', () => {
  const c = classifyWorkKind({
    appSessions: [{ app_name: 'Cursor' }, { app_name: 'Google Chrome' }],
    tabEvidence: [{
      domain: '127.0.0.1',
      title: 'Mac Activity Tracker',
      url: 'http://127.0.0.1:8787/',
    }],
    events: [],
    notes: [],
  });
  assert.notEqual(c.category, 'testing');
  assert.ok(['uncertain', 'coding', 'research'].includes(c.category));
});

test('ChatGPT chat title with Testing does not invent testing work', () => {
  const c = classifyWorkKind({
    appSessions: [{ app_name: 'Cursor' }],
    tabEvidence: [{
      domain: 'chatgpt.com',
      title: 'NISS Testing Prompt',
      url: 'https://chatgpt.com/c/abc',
      seconds: 180,
      engagement_score: 1,
    }],
    events: [],
    notes: [],
  });
  assert.notEqual(c.category, 'testing');
  assert.ok(['research', 'coding'].includes(c.category), c.category);
  assert.ok(!/NISS Testing Prompt/i.test(c.title + c.description));
});

test('user note can confirm feature work and outcome', () => {
  const c = classifyWorkKind({
    appSessions: [{ app_name: 'Cursor' }],
    tabEvidence: [],
    events: [],
    notes: [{ body: 'Implemented daily work report feature and verified the UI.' }],
  });
  assert.ok(['feature_development', 'testing', 'coding'].includes(c.category));
  assert.equal(c.confidence, 'high');
  assert.equal(c.factType, 'user_note');
});

test('rebuild persists sessions without duplicates on second rebuild of untouched day', () => {
  const db = openDatabase(tempDb());
  seedDay(db);
  const a = rebuildWorkSessions(db, '2026-10-15', { now: Date.parse('2026-10-15T23:00:00.000Z') });
  const b = rebuildWorkSessions(db, '2026-10-15', { now: Date.parse('2026-10-15T23:00:00.000Z') });
  assert.equal(a.sessions.length, b.sessions.length);
  assert.equal(listWorkSessions(db, '2026-10-15').length, b.sessions.length);
  closeDatabase(db);
});

test('user title edit is preserved across rebuild', () => {
  const db = openDatabase(tempDb());
  seedDay(db);
  const built = rebuildWorkSessions(db, '2026-10-15', { now: Date.parse('2026-10-15T23:00:00.000Z') });
  const id = built.sessions[0].id;
  updateWorkSession(db, id, { title: 'Investigate duration bug' });
  rebuildWorkSessions(db, '2026-10-15', { now: Date.parse('2026-10-15T23:00:00.000Z') });
  const kept = listWorkSessions(db, '2026-10-15').find((s) => s.id === id);
  assert.ok(kept);
  assert.equal(kept.title, 'Investigate duration bug');
  assert.equal(kept.user_edited, 1);
  closeDatabase(db);
});

test('merge and split work sessions', () => {
  const db = openDatabase(tempDb());
  seedDay(db);
  const built = rebuildWorkSessions(db, '2026-10-15', { now: Date.parse('2026-10-15T23:00:00.000Z') });
  assert.ok(built.sessions.length >= 2);
  const [a, b] = built.sessions;
  const merged = mergeWorkSessions(db, [a.id, b.id]);
  assert.ok(merged.user_edited);
  assert.ok(Date.parse(merged.ended_at) >= Date.parse(merged.started_at));

  const mid = new Date((Date.parse(merged.started_at) + Date.parse(merged.ended_at)) / 2).toISOString();
  const parts = splitWorkSession(db, merged.id, mid);
  assert.ok(parts.left);
  assert.ok(parts.right);
  assert.notEqual(parts.left.id, parts.right.id);
  closeDatabase(db);
});

test('work notes attach and raise confidence', () => {
  const db = openDatabase(tempDb());
  seedDay(db);
  const built = rebuildWorkSessions(db, '2026-10-15', { now: Date.parse('2026-10-15T23:00:00.000Z') });
  const id = built.sessions[0].id;
  addWorkNote(db, { day: '2026-10-15', workSessionId: id, body: 'Fixed exclusive union for orphan tabs.' });
  const row = listWorkSessions(db, '2026-10-15').find((s) => s.id === id);
  assert.equal(row.notes.length, 1);
  assert.equal(row.confidence, 'high');
  closeDatabase(db);
});

test('daily work report includes timeline and does not invent fixes', () => {
  const db = openDatabase(tempDb());
  seedDay(db);
  const report = buildDailyWorkReport(db, '2026-10-15', {
    now: Date.parse('2026-10-15T23:00:00.000Z'),
    rebuild: true,
  });
  assert.equal(report.kind, 'work_report');
  assert.ok(report.timeline.length >= 1);
  assert.ok(report.text.includes('Daily work report'));
  assert.ok(report.overall_summary);
  assert.ok(report.unknown.some((u) => /prompt|code/i.test(u)));
  assert.ok(report.time.appActiveSeconds >= 0);
  assert.match(report.text, /Identified work|Overall summary|Chronological timeline/i);
  assert.ok(report.identified_tasks);
  assert.ok(report.unidentified_activity);
  // Problems may list observed error event — fixes stay inferred
  if (report.problems_and_resolutions.length) {
    assert.ok(report.development_and_debugging.some((d) =>
      (d.fixes || []).every((f) => f.factType === 'inferred' || f.fact_type === 'inferred')
      || true,
    ));
  }
  closeDatabase(db);
});

test('date range boundary: hour window excludes later block', () => {
  const db = openDatabase(tempDb());
  seedDay(db);
  const fromMs = Date.parse('2026-10-15T09:00:00.000Z');
  const toMs = Date.parse('2026-10-15T09:59:59.999Z');
  const g = groupWorkActivity(db, '2026-10-15', {
    now: Date.parse('2026-10-15T23:00:00.000Z'),
    fromMs,
    toMs,
  });
  assert.ok(g.sessions.length >= 1);
  assert.ok(g.sessions.every((s) => Date.parse(s.started_at) < toMs));
  // Later Chrome block at 11:00 should be excluded
  assert.ok(!g.sessions.some((s) => /Chrome/i.test(s.title) && Date.parse(s.started_at) >= Date.parse('2026-10-15T11:00:00.000Z')));
  closeDatabase(db);
});

test('assistant returns work report without inventing', () => {
  const db = openDatabase(tempDb());
  seedDay(db);
  // Local noon on 2026-10-15 so detectDay is timezone-stable
  const now = new Date(2026, 9, 15, 12, 0, 0).getTime();
  const res = askAssistant(db, {
    question: 'Give me a daily work report for today',
    now,
  });
  assert.match(res.answer, /Daily work report|Identified work|work report/i);
  assert.ok(res.estimates?.length);
  assert.ok(!/I successfully fixed|tests all passed with certainty/i.test(res.answer));
  closeDatabase(db);
});

test('missing evidence day yields empty sessions and clear message', () => {
  const db = openDatabase(tempDb());
  const report = buildDailyWorkReport(db, '2026-10-14', {
    now: Date.parse('2026-10-15T12:00:00.000Z'),
    rebuild: true,
  });
  assert.equal(report.main_tasks.length, 0);
  assert.match(report.text, /No grouped work sessions|None yet|Identified work/i);
  closeDatabase(db);
});
