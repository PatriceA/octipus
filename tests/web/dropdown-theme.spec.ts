import { expect, test } from './fixtures/auth';
import { json } from './fixtures/api-stubs';

test('native selects use Deep Sea surfaces and light text', async ({ authenticatedPage: page }) => {
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
    colorScheme: 'dark',
    controlBackground: 'rgb(20, 48, 59)',
    controlColor: 'rgb(237, 245, 243)',
    controlBorder: 'rgb(146, 201, 197)',
    optionBackground: 'rgb(13, 37, 48)',
    optionColor: 'rgb(237, 245, 243)',
    outlineColor: 'rgb(146, 201, 197)',
    outlineStyle: 'solid',
    outlineWidth: '2px',
  });
});
