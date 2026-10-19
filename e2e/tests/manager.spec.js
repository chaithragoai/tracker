import { test, expect } from '@playwright/test';

test.describe('Manager Dashboard', () => {
  test('manager tab loads with summary cards and device table', async ({ page, request }) => {
    const api = await request.get('/api/manager/devices');
    expect(api.ok(), 'manager API must be authorized in local mode').toBeTruthy();
    const body = await api.json();
    expect(body.thresholds).toBeTruthy();
    expect(Array.isArray(body.devices)).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain('device_secret');
    expect(JSON.stringify(body)).not.toContain('secret_hash');

    await page.goto('/');
    await page.locator('.nav-item[data-view="manager"]').click();
    await expect(page.locator('#view-title')).toHaveText('Manager');
    await expect(page.locator('#view-manager')).toBeVisible();
    await expect(page.locator('#mgr-total')).toBeVisible();
    await expect(page.locator('#manager-table')).toBeVisible();

    if (body.devices.length === 0) {
      await expect(page.locator('#manager-empty')).toBeVisible();
    } else {
      await expect(page.locator('#manager-tbody tr').first()).toBeVisible({ timeout: 10_000 });
    }
  });

  test('manager detail opens for first enrolled device when present', async ({ page, request }) => {
    const api = await request.get('/api/manager/devices');
    const body = await api.json();
    test.skip(!body.devices?.length, 'No enrolled devices in this environment');

    await page.goto('/');
    await page.locator('.nav-item[data-view="manager"]').click();
    await page.locator('#manager-tbody tr').first().click();
    await expect(page.locator('#manager-detail-card')).toBeVisible();
    await expect(page.locator('#manager-detail-title')).not.toHaveText('Loading device…');
    await page.locator('#btn-mgr-back').click();
    await expect(page.locator('#manager-list-card')).toBeVisible();
  });

  test('existing Overview tab still works after Manager added', async ({ page }) => {
    await page.goto('/');
    await page.locator('.nav-item[data-view="manager"]').click();
    await page.locator('.nav-item[data-view="overview"]').click();
    await expect(page.locator('#view-title')).toHaveText('Overview');
    await expect(page.locator('#view-overview')).toBeVisible();
  });
});
