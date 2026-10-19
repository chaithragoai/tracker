#!/usr/bin/env node
/**
 * Builds Markdown + HTML smoke summary from Playwright JSON results.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '../..');
const resultsPath = path.join(ROOT, 'test-results/playwright-results.json');
const outMd = path.join(ROOT, 'test-results/E2E_SMOKE_SUMMARY.md');
const outHtml = path.join(ROOT, 'test-results/E2E_SMOKE_REPORT.html');
const screenDir = path.join(ROOT, 'test-results/screenshots');

const TABS = 11;

if (!fs.existsSync(resultsPath)) {
  console.error('Missing playwright-results.json — run tests first');
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
const suites = raw.suites || [];
const tests = [];

function walk(suite, prefix = '') {
  for (const s of suite.suites || []) walk(s, prefix);
  for (const spec of suite.specs || []) {
    for (const t of spec.tests || []) {
      const result = (t.results || [])[0] || {};
      const status = result.status === 'passed' ? 'PASS'
        : result.status === 'skipped' ? 'SKIPPED'
          : result.status === 'timedOut' ? 'FAIL'
            : result.status === 'failed' ? 'FAIL' : String(result.status || 'NOT RUN').toUpperCase();
      tests.push({
        title: spec.title,
        status,
        error: result.error?.message || result.errors?.[0]?.message || '',
        duration: result.duration || 0,
      });
    }
  }
}
for (const s of suites) walk(s);

const passed = tests.filter((t) => t.status === 'PASS').length;
const failed = tests.filter((t) => t.status === 'FAIL').length;
const skipped = tests.filter((t) => t.status === 'SKIPPED').length;
const blocked = tests.filter((t) => t.status === 'BLOCKED').length;
const screenshots = fs.existsSync(screenDir)
  ? fs.readdirSync(screenDir).filter((f) => f.endsWith('.png'))
  : [];

const md = `# E2E Smoke Test Summary — Activity Tracker

**Generated:** ${new Date().toISOString()}  
**Base URL:** http://127.0.0.1:8787

## Counts

| Metric | Value |
|--------|-------|
| Tabs/pages discovered | ${TABS} |
| Smoke tests executed | ${tests.length} |
| PASS | ${passed} |
| FAIL | ${failed} |
| SKIPPED | ${skipped} |
| BLOCKED | ${blocked} |

## Notes

- App is a single-page dashboard (no per-tab URLs). Refresh returning to Overview is **expected**.
- No Playwright existed before; suite lives under \`e2e/\`.
- Product code was not modified to make tests pass.
- Auth / multi-device pages: **NOT RUN** (not present in app).

## Results

| Status | Test |
|--------|------|
${tests.map((t) => `| ${t.status} | ${t.title.replace(/\|/g, '/')} |`).join('\n')}

## Failures

${failed === 0 ? '_None._' : tests.filter((t) => t.status === 'FAIL').map((t) => `### ${t.title}\n\n\`\`\`\n${t.error}\n\`\`\`\n`).join('\n')}

## Artifacts

- Playwright HTML: \`test-results/playwright-html/index.html\`
- Screenshots: \`test-results/screenshots/\` (${screenshots.length} files)
- This summary: \`test-results/E2E_SMOKE_SUMMARY.md\`
- HTML report: \`test-results/E2E_SMOKE_REPORT.html\`
`;

fs.writeFileSync(outMd, md);

const rows = tests.map((t) => {
  const color = t.status === 'PASS' ? '#0a7a45' : t.status === 'FAIL' ? '#b42318' : '#667';
  return `<tr><td style="color:${color};font-weight:600">${t.status}</td><td>${escape(t.title)}</td><td>${t.duration}ms</td><td><pre>${escape(t.error || '')}</pre></td></tr>`;
}).join('\n');

const shots = screenshots.map((f) => `<figure><img src="screenshots/${f}" alt="${f}" style="max-width:100%;border:1px solid #ddd"/><figcaption>${f}</figcaption></figure>`).join('\n');

const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><title>E2E Smoke Report</title>
<style>
body{font-family:system-ui,sans-serif;margin:2rem;color:#142033;background:#f7f8fb}
h1{margin-bottom:.25rem}.muted{color:#667}
table{border-collapse:collapse;width:100%;background:#fff;margin:1rem 0}
th,td{border:1px solid #d7dee8;padding:.5rem;vertical-align:top;text-align:left}
th{background:#eef3f9}
.cards{display:flex;gap:1rem;flex-wrap:wrap}
.card{background:#fff;border:1px solid #d7dee8;padding:1rem 1.25rem;min-width:120px}
pre{white-space:pre-wrap;font-size:12px;margin:0;max-width:420px}
</style></head><body>
<h1>Activity Tracker — E2E Smoke Report</h1>
<p class="muted">${new Date().toISOString()} · http://127.0.0.1:8787</p>
<div class="cards">
  <div class="card"><strong>${TABS}</strong><div class="muted">Tabs</div></div>
  <div class="card"><strong>${tests.length}</strong><div class="muted">Executed</div></div>
  <div class="card"><strong>${passed}</strong><div class="muted">PASS</div></div>
  <div class="card"><strong>${failed}</strong><div class="muted">FAIL</div></div>
  <div class="card"><strong>${skipped}</strong><div class="muted">SKIPPED</div></div>
</div>
<h2>Results</h2>
<table><thead><tr><th>Status</th><th>Test</th><th>Duration</th><th>Error</th></tr></thead><tbody>
${rows}
</tbody></table>
<h2>Screenshots</h2>
${shots || '<p class="muted">No screenshots captured.</p>'}
<p class="muted">Playwright detailed report: playwright-html/index.html</p>
</body></html>`;

fs.writeFileSync(outHtml, html);
console.log('Wrote', outMd);
console.log('Wrote', outHtml);

function escape(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
