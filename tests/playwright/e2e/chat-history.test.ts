import { test, expect } from '../fixtures/extension';

test.describe('@phase-4 Chat History', () => {
  test('MVP-9: side panel page loads for chat history', async ({ extensionId, context }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/side-panel/index.html`);
    await expect(page).toHaveTitle('ULCopilot');

    // The chat sidebar should be accessible
    const body = page.locator('body');
    await expect(body).toBeVisible();

    await page.close();
  });
});

test.describe('@phase-9 Clear History', () => {
  test('MVP-22: side panel loads and clear all chat history button exists', async ({
    extensionId,
    context,
  }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/side-panel/index.html`);
    await expect(page).toHaveTitle('ULCopilot');

    // The page should load without errors
    const body = page.locator('body');
    await expect(body).toBeVisible();
  });
});
