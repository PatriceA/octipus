import { expect, test } from './fixtures/auth';
import { json } from './fixtures/api-stubs';

test('native selects use workspace surfaces with readable text', async ({ authenticatedPage: page }) => {
  await page.route('**/api/models/', route => json(route, 200, {
    models: [{ id: 'deepsea-model', name: 'Deepsea model', modelId: 'deepsea-model' }],
  }));
  await page.goto('/eval');

  const select = page.locator('select').first();
  await expect(select).toBeVisible();
  await select.focus();
  const colors = await select.evaluate((element) => {
    const control = getComputedStyle(element);
    const option = element.querySelector('option:not(:checked)') ?? element.querySelector('option');
    const optionStyle = option ? getComputedStyle(option) : null;
    return {
      colorScheme: control.colorScheme,
      controlBackground: control.backgroundColor,
      controlColor: control.color,
      controlBorder: control.borderTopColor,
      optionBackground: optionStyle?.backgroundColor,
      optionColor: optionStyle?.color,
      outlineColor: control.outlineColor,
      outlineStyle: control.outlineStyle,
      outlineWidth: control.outlineWidth,
    };
  });

  expect(colors).toEqual({
    colorScheme: 'light',
    controlBackground: 'rgb(238, 243, 245)',
    controlColor: 'rgb(32, 50, 61)',
    controlBorder: 'rgb(38, 94, 89)',
    optionBackground: 'rgb(255, 255, 255)',
    optionColor: 'rgb(32, 50, 61)',
    outlineColor: 'rgb(38, 94, 89)',
    outlineStyle: 'solid',
    outlineWidth: '2px',
  });
});
