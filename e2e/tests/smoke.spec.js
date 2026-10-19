import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '../..');
const SCREEN_DIR = path.join(ROOT, 'test-results/screenshots');
fs.mkdirSync(SCREEN_DIR, { recursive: true });

const TABS = [
  { label: 'Overview', view: 'overview', title: 'Overview' },
  { label: 'App Usage', view: 'apps', title: 'App Usage' },
  { label: 'Browser Activity', view: 'browser', title: 'Browser Activity' },
  { label: 'Timeline', view: 'timeline', title: 'Timeline' },
  { label: 'Search', view: 'search', title: 'Search' },
  { label: 'Assistant', view: 'assistant', title: 'Assistant' },
  { label: 'Daily Briefing', view: 'briefing', title: 'Daily Briefing' },
  { label: 'Tasks', view: 'tasks', title: 'Tasks' },
  { label: 'Memories', view: 'memories', title: 'Memories' },
  { label: 'Activity History', view: 'history', title: 'Activity History' },
  { label: 'Reports & Privacy', view: 'reports', title: 'Reports & Privacy' },
  { label: 'Manager', view: 'manager', title: 'Manager' },
];

async function collectPageErrors(page) {
  const errors = [];
  const failed = [];
  page.on('pageerror', (e) => errors.push(String(e.message || e)));
  page.on('response', (res) => {
    if (res.url().includes('/api/') && res.status() >= 500) {
      failed.push(`${res.status()} ${res.url()}`);
    }
  });
  return { errors, failed };
}

async function shot(page, name) {
  const file = path.join(SCREEN_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

async function openTab(page, tab) {
  const btn = page.locator(`.nav-item[data-view="${tab.view}"]`);
  await expect(btn).toBeVisible();
  await btn.click();
  await expect(page.locator('#view-title')).toHaveText(tab.title);
  await expect(page.locator(`#view-${tab.view}`)).toBeVisible();
  await expect(btn).toHaveClass(/active/);
}

test.describe('Activity Tracker E2E smoke', () => {
  test('00 environment: health API and dashboard load', async ({ page, request }) => {
    const health = await request.get('/api/health');
    expect(health.ok(), 'Backend /api/health must be up').toBeTruthy();
    const body = await health.json();
    expect(body.ok).toBe(true);

    const track = await request.get('/api/tracking/health');
    expect(track.ok()).toBeTruthy();

    const { errors } = await collectPageErrors(page);
    await page.goto('/');
    await expect(page.locator('.brand-name')).toHaveText('Activity Assistant');
    await expect(page.locator('#view-overview')).toBeVisible();
    await shot(page, '00-dashboard-home');
    expect(errors, `Unexpected page errors: ${errors.join('; ')}`).toEqual([]);
  });

  for (const tab of TABS) {
    test(`tab visible and opens: ${tab.label}`, async ({ page }) => {
      const { errors, failed } = await collectPageErrors(page);
      await page.goto('/');
      await openTab(page, tab);
      // Not blank: section has content height / children
      const box = await page.locator(`#view-${tab.view}`).boundingBox();
      expect(box?.height || 0).toBeGreaterThan(40);
      await shot(page, `tab-${tab.view}`);
      expect(errors, errors.join('; ')).toEqual([]);
      expect(failed, failed.join('; ')).toEqual([]);
    });
  }

  test('overview: date filters and refresh', async ({ page }) => {
    await page.goto('/');
    await openTab(page, TABS[0]);
    await expect(page.locator('#metric-total-app')).toBeVisible();
    await expect(page.locator('#chart-apps')).toBeVisible();

    await page.locator('.chip[data-range="yesterday"]').click();
    await expect(page.locator('.chip[data-range="yesterday"]')).toHaveClass(/active/);
    await page.waitForTimeout(500); // brief settle for fetch
    await expect(page.locator('#range-label')).not.toHaveText(/Loading range/);

    await page.locator('.chip[data-range="7d"]').click();
    await expect(page.locator('.chip[data-range="7d"]')).toHaveClass(/active/);

    await page.locator('.chip[data-range="today"]').click();
    await page.locator('#btn-refresh').click();
    await expect(page.locator('#status-pill')).toBeVisible();
    await shot(page, 'overview-filters');
  });

  test('overview: analytics API returns real structure', async ({ request }) => {
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    const res = await request.get(`/api/analytics?from=${from.toISOString()}&to=${new Date().toISOString()}`);
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data).toHaveProperty('summary');
    expect(data).toHaveProperty('applications');
    expect(data).toHaveProperty('websites');
    expect(typeof data.summary.totalTrackedAppSeconds).toBe('number');
    // Soft check: if there is data it should have items; empty is allowed
    expect(Array.isArray(data.applications.items)).toBeTruthy();
  });

  test('search: empty and matching queries', async ({ page }) => {
    await page.goto('/');
    await openTab(page, TABS.find((t) => t.view === 'search'));
    await page.locator('#search-q').fill('zzz-no-such-activity-xyz');
    await page.locator('#btn-search').click();
    await expect(page.locator('#search-results')).toContainText(/No matches|No matches in recorded/i);

    await page.locator('#search-q').fill('chrome');
    await page.locator('#btn-search').click();
    await page.waitForTimeout(800);
    const text = await page.locator('#search-results').innerText();
    // Either matches or honest empty — both acceptable; fail only on crash
    expect(text.length).toBeGreaterThan(0);
    await shot(page, 'search-results');
  });

  test('assistant: ask returns an answer', async ({ page }) => {
    await page.goto('/');
    await openTab(page, TABS.find((t) => t.view === 'assistant'));
    await page.locator('#ask-q').fill('What apps did I use today?');
    await page.locator('#btn-ask').click();
    await expect(page.locator('#ask-answer')).not.toContainText('Ask about apps', { timeout: 15_000 });
    const answer = await page.locator('#ask-answer').innerText();
    expect(answer.length).toBeGreaterThan(10);
    await shot(page, 'assistant-answer');
  });

  test('briefing: generate shows facts', async ({ page }) => {
    await page.goto('/');
    await openTab(page, TABS.find((t) => t.view === 'briefing'));
    await page.locator('#btn-briefing').click();
    await expect(page.locator('#briefing-out')).toContainText(/Briefing for|Recorded|facts|disclaimer|app time/i, {
      timeout: 15_000,
    });
    await shot(page, 'briefing');
  });

  test('briefing: work report and timeline API', async ({ page, request }) => {
    const day = new Date().toISOString().slice(0, 10);
    const report = await request.post('/api/work/report', {
      data: { day, rebuild: true },
    });
    expect(report.ok()).toBeTruthy();
    const body = await report.json();
    expect(body.kind).toBe('work_report');
    expect(body).toHaveProperty('timeline');
    expect(body).toHaveProperty('main_tasks');
    expect(String(body.disclaimer || '')).toMatch(/does not invent|inferred|does not read/i);

    await page.goto('/');
    await openTab(page, TABS.find((t) => t.view === 'briefing'));
    await expect(page.locator('#btn-work-report')).toBeVisible();
    await expect(page.locator('#briefing-metrics')).toBeVisible();
    await expect(page.locator('#work-needs-confirm')).toBeAttached();
    await expect(page.locator('#work-unidentified-wrap')).toBeAttached();
    // Opening Daily Briefing auto-generates the report
    await expect(page.locator('#work-report-out')).toContainText(/Work report|Identified|Could not identify|No tasks/i, {
      timeout: 20_000,
    });
    await expect(page.locator('#work-timeline')).toBeVisible();
    await expect(page.locator('#work-chrono')).toBeVisible();
    await expect(page.locator('#briefing-metrics .metric-value').first()).toBeVisible();
    await expect(page.locator('#work-report-out pre')).toHaveCount(0);
    await shot(page, 'work-report');
  });

  test('tasks: add task appears in list', async ({ page }) => {
    await page.goto('/');
    await openTab(page, TABS.find((t) => t.view === 'tasks'));
    const title = `Smoke task ${Date.now()}`;
    await page.locator('#task-title').fill(title);
    await page.locator('#btn-task-add').click();
    await expect(page.locator('#task-list')).toContainText(title, { timeout: 10_000 });
    await shot(page, 'tasks-add');
  });

  test('memories: save memory appears', async ({ page }) => {
    await page.goto('/');
    await openTab(page, TABS.find((t) => t.view === 'memories'));
    const title = `Smoke memory ${Date.now()}`;
    await page.locator('#mem-title').fill(title);
    await page.locator('#mem-body').fill('E2E smoke note — not sensitive');
    await page.locator('#btn-mem-add').click();
    await expect(page.locator('#mem-list')).toContainText(title, { timeout: 10_000 });
    await shot(page, 'memories-add');
  });

  test('history: filters render and apply', async ({ page }) => {
    await page.goto('/');
    await openTab(page, TABS.find((t) => t.view === 'history'));
    await expect(page.locator('#filter-type')).toBeVisible();
    await page.locator('#filter-type').selectOption('sessionStarted');
    await page.locator('#btn-apply').click();
    await expect(page.locator('#events')).toBeVisible();
    await shot(page, 'history-filter');
  });

  test('reports: export links and privacy controls visible', async ({ page }) => {
    await page.goto('/');
    await openTab(page, TABS.find((t) => t.view === 'reports'));
    await expect(page.locator('#btn-csv')).toBeVisible();
    await expect(page.locator('#btn-json')).toBeVisible();
    await expect(page.locator('#btn-html')).toBeVisible();
    await expect(page.locator('#btn-backup')).toBeVisible();
    await expect(page.locator('#btn-save-settings')).toBeVisible();

    const csv = await page.locator('#btn-csv').getAttribute('href');
    expect(csv).toContain('/api/export/csv');

    const htmlDownloadPromise = page.waitForEvent('download', { timeout: 15000 });
    await page.locator('#btn-html').click();
    const htmlFile = await htmlDownloadPromise;
    expect(htmlFile.suggestedFilename()).toMatch(/daily-report-.*\.html/);
    const htmlSave = path.join(SCREEN_DIR, htmlFile.suggestedFilename());
    await htmlFile.saveAs(htmlSave);
    const htmlBody = fs.readFileSync(htmlSave, 'utf8');
    expect(htmlBody).toMatch(/<!DOCTYPE html>/i);
    await expect(page.locator('#reports-msg')).toContainText(/Downloaded/i);

    const bakDownloadPromise = page.waitForEvent('download', { timeout: 20000 });
    await page.locator('#btn-backup').click();
    const bakFile = await bakDownloadPromise;
    expect(bakFile.suggestedFilename()).toMatch(/\.db$/);
    const bakSave = path.join(SCREEN_DIR, bakFile.suggestedFilename());
    await bakFile.saveAs(bakSave);
    const bakBuf = fs.readFileSync(bakSave);
    expect(bakBuf.subarray(0, 15).toString('utf8')).toBe('SQLite format 3');
    await expect(page.locator('#reports-msg')).toContainText(/Downloaded/i);

    await shot(page, 'reports-privacy');
  });

  test('tracking data: events and status APIs have real payloads', async ({ request }) => {
    const status = await (await request.get('/api/status')).json();
    expect(status).toHaveProperty('status');

    const events = await (await request.get('/api/events?limit=5')).json();
    expect(Array.isArray(events.events)).toBeTruthy();
    // Do not invent — if empty, still PASS structure; note in report via console
    if (events.events.length === 0) {
      console.warn('NOTE: No events in DB yet — tracking may be idle, not a UI failure');
    } else {
      expect(events.events[0]).toHaveProperty('type');
      expect(events.events[0]).toHaveProperty('timestamp');
      expect(events.events[0]).toHaveProperty('source');
    }

    const health = await (await request.get('/api/tracking/health')).json();
    expect(health).toHaveProperty('extension_connected');
  });

  test('navigation: switching tabs updates active state', async ({ page }) => {
    await page.goto('/');
    await openTab(page, TABS.find((t) => t.view === 'apps'));
    await openTab(page, TABS.find((t) => t.view === 'browser'));
    await openTab(page, TABS.find((t) => t.view === 'overview'));
    await expect(page.locator('.nav-item[data-view="overview"]')).toHaveClass(/active/);
    await expect(page.locator('#view-overview')).toBeVisible();
  });

  test('refresh returns to default Overview (SPA has no deep routes)', async ({ page }) => {
    await page.goto('/');
    await openTab(page, TABS.find((t) => t.view === 'tasks'));
    await page.reload();
    await expect(page.locator('#view-overview')).toBeVisible();
    await expect(page.locator('#view-title')).toHaveText('Overview');
  });

  test('edge: custom date range controls visible', async ({ page }) => {
    await page.goto('/');
    await page.locator('.chip[data-range="custom"]').click();
    await expect(page.locator('#custom-range')).toBeVisible();
    await expect(page.locator('#from-date')).toBeVisible();
    await expect(page.locator('#to-date')).toBeVisible();
    await expect(page.locator('#btn-apply-custom')).toBeVisible();
  });
});
