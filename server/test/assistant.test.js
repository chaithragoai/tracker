import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, closeDatabase } from '../src/db/database.js';
import { insertEvent } from '../src/services/events.js';
import { searchActivity } from '../src/services/search.js';
import { buildDailyBriefing } from '../src/services/briefing.js';
import { askAssistant } from '../src/services/assistant.js';
import { createTask, listTasks, suggestTasksFromActivity } from '../src/services/tasks.js';
import { createMemory, listMemories } from '../src/services/memories.js';

function tempDb() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-asst-')), 't.sqlite');
}

function seed(db) {
  insertEvent(db, {
    id: 'a1',
    timestamp: '2026-10-15T09:00:00.000Z',
    type: 'sessionStarted',
    outcome: 'success',
    sessionId: 's1',
    app: { name: 'Cursor', bundleIdentifier: 'com.todesktop.x' },
  }, 'mac-agent');
  insertEvent(db, {
    id: 'a2',
    timestamp: '2026-10-15T09:30:00.000Z',
    type: 'sessionEnded',
    outcome: 'success',
    sessionId: 's1',
    durationSeconds: 1800,
    app: { name: 'Cursor', bundleIdentifier: 'com.todesktop.x' },
  }, 'mac-agent');
  insertEvent(db, {
    id: 't1',
    timestamp: '2026-10-15T09:10:00.000Z',
    type: 'tabSessionStarted',
    outcome: 'success',
    tabSessionId: 'tb1',
    title: 'Example Domain',
    domain: 'example.com',
    url: 'https://example.com/',
    browser: 'Chrome',
    tab: { title: 'Example Domain', domain: 'example.com', url: 'https://example.com/', browser: 'Chrome' },
  }, 'chrome-extension');
  insertEvent(db, {
    id: 't2',
    timestamp: '2026-10-15T09:20:00.000Z',
    type: 'tabSessionEnded',
    outcome: 'success',
    tabSessionId: 'tb1',
    durationSeconds: 600,
    domain: 'example.com',
  }, 'chrome-extension');
}

test('search finds recorded domain and app', () => {
  const db = openDatabase(tempDb());
  seed(db);
  const found = searchActivity(db, { q: 'example', from: '2026-10-15T00:00:00.000Z', to: '2026-10-15T23:59:59.000Z' });
  assert.ok(found.results.some((r) => String(r.snippet || r.title).includes('example.com') || String(r.title).includes('Example')));
  closeDatabase(db);
});

test('briefing uses real totals and labels estimates', () => {
  const db = openDatabase(tempDb());
  seed(db);
  const b = buildDailyBriefing(db, '2026-10-15', { now: Date.parse('2026-10-15T23:00:00.000Z') });
  assert.equal(b.kind, 'deterministic');
  assert.ok(b.facts.length > 0);
  assert.ok(b.disclaimer.includes('recorded'));
  assert.ok(b.analytics_summary.totalTrackedAppSeconds >= 1800);
  closeDatabase(db);
});

test('assistant answers app time from records without inventing', () => {
  const db = openDatabase(tempDb());
  seed(db);
  const res = askAssistant(db, {
    question: 'How much time did I spend in Cursor today?',
    now: Date.parse('2026-10-15T18:00:00.000Z'),
  });
  assert.match(res.answer, /Cursor/i);
  assert.equal(res.mode, 'deterministic');
  assert.ok(res.note.includes('Cloud AI is not used'));

  const missing = askAssistant(db, {
    question: 'How much time did I spend in Photoshop today?',
    now: Date.parse('2026-10-15T18:00:00.000Z'),
  });
  assert.match(missing.answer, /no recorded/i);
  closeDatabase(db);
});

test('tasks suggestions require confirmation flag', () => {
  const db = openDatabase(tempDb());
  seed(db);
  const suggestions = suggestTasksFromActivity(db, '2026-10-15');
  assert.ok(suggestions.length >= 1);
  assert.equal(suggestions[0].confirmed, false);
  const task = createTask(db, { title: suggestions[0].title, details: suggestions[0].details, source: 'ai_suggestion', confirmed: false });
  assert.equal(task.confirmed, 0);
  const listed = listTasks(db);
  assert.ok(listed.some((t) => t.confirmed === 0));
  closeDatabase(db);
});

test('memories are curated and searchable', () => {
  const db = openDatabase(tempDb());
  createMemory(db, { title: 'Pref', body: 'I prefer local-first tools' });
  assert.equal(listMemories(db).length, 1);
  const found = searchActivity(db, { q: 'local-first' });
  assert.ok(found.results.some((r) => r.kind === 'memory'));
  closeDatabase(db);
});
