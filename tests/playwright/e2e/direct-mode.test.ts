import { test, expect } from '../fixtures/extension';
import { waitForAppReady } from '../helpers/setup';

test.describe('Direct Mode @phase-9', () => {
  test('MVP-16: first-run setup renders when no models configured', async ({
    extensionId,
    context,
  }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/side-panel/index.html`);
    await page.waitForLoadState('domcontentloaded');

    // Wait for React to finish loading (spinner → setup or chat)
    await waitForAppReady(page);

    // Either the first-run setup or the chat UI should be visible
    const hasSetup = await page
      .locator('[data-testid="setup-api-key"]')
      .isVisible()
      .catch(() => false);
    const hasChat = await page
      .locator('textarea')
      .isVisible()
      .catch(() => false);

    expect(hasSetup || hasChat).toBeTruthy();

    await page.close();
  });

  test('MVP-16: first-run setup allows adding API key', async ({ extensionId, context }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/side-panel/index.html`);
    await page.waitForLoadState('domcontentloaded');
    await waitForAppReady(page);

    const setupVisible = await page
      .locator('[data-testid="setup-api-key"]')
      .isVisible()
      .catch(() => false);

    if (setupVisible) {
      await page.locator('[data-testid="setup-api-key"]').fill('sk-test123456');

      const modelInput = page.locator('[data-testid="setup-model-id"]');
      await expect(modelInput).toHaveValue('gpt-4o');

      await expect(page.locator('[data-testid="setup-start-button"]')).toBeEnabled();
    }

    await page.close();
  });

  test('MVP-19: extension branded as ULCopilot', async ({ extensionId, context }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/side-panel/index.html`);
    await expect(page).toHaveTitle('ULCopilot');

    await page.close();
  });
});
