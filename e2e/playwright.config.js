import { defineConfig } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

export default defineConfig({
  testDir: path.join(__dirname, 'tests'),
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [
    ['list'],
    ['html', { outputFolder: path.join(root, 'test-results/playwright-html'), open: 'never' }],
    ['json', { outputFile: path.join(root, 'test-results/playwright-results.json') }],
  ],
  use: {
    baseURL: process.env.TRACKER_BASE_URL || 'http://127.0.0.1:8787',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  outputDir: path.join(root, 'test-results/artifacts'),
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
