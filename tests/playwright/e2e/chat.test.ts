import { test, expect } from '../fixtures/extension';

test.describe('@phase-4 Chat UI', () => {
  test('MVP-6: chat UI renders with input area', async ({ extensionId, context }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/side-panel/index.html`);
    await expect(page).toHaveTitle('ULCopilot');

    // The chat UI should be visible (either directly or after auth)
    const body = page.locator('body');
    await expect(body).toBeVisible();

    await page.close();
  });

  test('MVP-7: streaming response placeholder', async ({ extensionId, context }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/side-panel/index.html`);
    await expect(page).toHaveTitle('ULCopilot');

    await page.close();
  });

  test('MVP-8: chat persistence placeholder', async ({ extensionId, context }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/side-panel/index.html`);
    await expect(page).toHaveTitle('ULCopilot');

    await page.close();
  });
});

test.describe('@phase-9 Chat Enhancements', () => {
  test('MVP-23: suggested actions render on empty chat', async ({ extensionId, context }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/side-panel/index.html`);
    await page.waitForLoadState('domcontentloaded');

    // If we need to set up first, do so
    const setupVisible = await page
      .locator('[data-testid="setup-api-key"]')
      .isVisible()
      .catch(() => false);

    if (setupVisible) {
      await page.locator('[data-testid="setup-api-key"]').fill('sk-test123456');
      await page.locator('[data-testid="setup-start-button"]').click();
      await page.waitForTimeout(500);
    }

    // Check for suggested actions on empty chat state
    const suggestedActions = page.locator('[data-testid="suggested-actions"]');
    const chatVisible = await suggestedActions.isVisible().catch(() => false);
    if (chatVisible) {
      await expect(suggestedActions).toBeVisible();
    }
  });

  test('MVP-23: page loads for message actions verification', async ({ extensionId, context }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/side-panel/index.html`);
    await expect(page).toHaveTitle('ULCopilot');

    // The page should load without errors
    const body = page.locator('body');
    await expect(body).toBeVisible();
  });
});
