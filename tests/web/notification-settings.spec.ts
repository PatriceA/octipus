import { test, expect } from './fixtures/auth';
import { json, stubAllDefaults } from './fixtures/api-stubs';

const labels = ['Agent completion notifications', 'Permission request notifications', 'Pipeline approval notifications', 'Error notifications'];
const keys = ['notifications.agentCompletion', 'notifications.permissionRequest', 'notifications.pipelineApproval', 'notifications.errors'];

test('notification checkboxes load saved values and retain changes after leaving and reloading', async ({ authenticatedPage: page }) => {
  await stubAllDefaults(page);
  // Opposite to the defaults: the old response-shape bug displayed every one incorrectly.
  const values: Record<string, boolean> = Object.fromEntries(keys.map((key, index) => [key, index === 3]));
  const writes: unknown[] = [];
  await page.route('**/api/settings', route => json(route, 200, {
    categories: ['notifications'], settings: { notifications: keys.map(key => ({ key, value: values[key] })) },
  }));
  await page.route('**/api/settings/notifications.*', route => {
    const key = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!);
    const body = route.request().postDataJSON();
    values[key] = body.value;
    writes.push({ key, ...body });
    return json(route, 200, { success: true, key });
  });
  await page.goto('/settings?tab=notifications');
  for (let index = 0; index < keys.length; index++) {
    const checkbox = page.getByRole('checkbox', { name: new RegExp(labels[index]) });
    await expect(checkbox).toBeChecked({ checked: index === 3 });
    await checkbox.click();
    await expect(checkbox).toBeEnabled();
  }
  await expect.poll(() => writes.length).toBe(4);
  await page.getByRole('button', { name: 'All settings', exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await page.getByRole('button', { name: 'Profile', exact: true }).click();
  await expect(page).toHaveURL(/tab=general/);
  await page.getByRole('button', { name: 'All settings', exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await page.getByRole('main').getByRole('button', { name: 'Notifications', exact: true }).click();
  await expect(page).toHaveURL(/tab=notifications/);
  for (let index = 0; index < keys.length; index++) {
    await expect(page.getByRole('checkbox', { name: new RegExp(labels[index]) })).toBeChecked({ checked: index !== 3 });
  }
  await page.reload();
  for (let index = 0; index < keys.length; index++) {
    await expect(page.getByRole('checkbox', { name: new RegExp(labels[index]) })).toBeChecked({ checked: index !== 3 });
  }
});

test('notification save errors returned with HTTP 200 are visible and roll back the checkbox', async ({ authenticatedPage: page }) => {
  await stubAllDefaults(page);
  await page.route('**/api/settings', route => json(route, 200, {
    categories: ['notifications'], settings: { notifications: [{ key: keys[0], value: false }] },
  }));
  await page.route('**/api/settings/notifications.*', route => json(route, 200, { error: 'Setting could not be saved' }));
  await page.goto('/settings?tab=notifications');
  const checkbox = page.getByRole('checkbox', { name: /Agent completion notifications/ });
  await expect(checkbox).not.toBeChecked();
  await checkbox.click();
  await expect(page.getByRole('alert')).toHaveText('Setting could not be saved');
  await expect(checkbox).not.toBeChecked();
});

test('notification load errors are shown instead of editable default preferences', async ({ authenticatedPage: page }) => {
  await stubAllDefaults(page);
  await page.route('**/api/settings', route => json(route, 200, { error: 'Admin access required' }));
  await page.goto('/settings?tab=notifications');
  await expect(page.getByRole('alert')).toHaveText('Admin access required');
  await expect(page.getByRole('checkbox', { name: /Agent completion notifications/ })).toBeDisabled();
});
