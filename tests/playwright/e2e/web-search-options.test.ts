import { test } from '../fixtures/extension';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/** Navigate to options and wait for the page to be ready. */
const openOptions = async (page: Page, extensionId: string) => {
  await page.goto(`chrome-extension://${extensionId}/options/index.html`);
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator('h1')).toContainText('ULCopilot Settings', { timeout: 10000 });
};

/** Click a tab in the options page nav. */
const clickTab = async (page: Page, tabName: string) => {
  await page.locator('nav button', { hasText: tabName }).click();
};

test.describe('Web Search Provider Config @phase-10', () => {
  test('provider dropdown appears when web search is enabled', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await openOptions(page, extensionId);
    await clickTab(page, 'Tool');

    // Enable web search
    const wsCheckbox = page.locator('#tool-websearch');
    if (!(await wsCheckbox.isChecked())) {
      await wsCheckbox.check();
    }

    // Provider dropdown should be visible
    await expect(page.locator('#search-provider')).toBeVisible();

    await page.close();
  });

  test('selecting Tavily shows API key input', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await openOptions(page, extensionId);
    await clickTab(page, 'Tool');

    // Enable web search
    const wsCheckbox = page.locator('#tool-websearch');
    if (!(await wsCheckbox.isChecked())) {
      await wsCheckbox.check();
    }

    // Tavily is default — API key input should be visible
    await expect(page.locator('#search-api-key')).toBeVisible();
    // Engine selector should NOT be visible
    await expect(page.locator('#search-engine')).not.toBeVisible();

    await page.close();
  });

  test('selecting Browser shows engine dropdown and no-API-key text', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await openOptions(page, extensionId);
    await clickTab(page, 'Tool');

    // Enable web search
    const wsCheckbox = page.locator('#tool-websearch');
    if (!(await wsCheckbox.isChecked())) {
      await wsCheckbox.check();
    }

    // Switch to Browser provider
    await page.locator('#search-provider').click();
    await page.locator('[role="option"]', { hasText: 'Browser' }).click();

    // Engine dropdown should be visible
    await expect(page.locator('#search-engine')).toBeVisible();
    // API key input should NOT be visible
    await expect(page.locator('#search-api-key')).not.toBeVisible();
    // Info text should be visible
    await expect(page.locator('text=No API key needed')).toBeVisible();

    await page.close();
  });

  test('browser engine selection shows Google/Bing/DuckDuckGo options', async ({
    context,
    extensionId,
  }) => {
    const page = await context.newPage();
    await openOptions(page, extensionId);
    await clickTab(page, 'Tool');

    // Enable web search
    const wsCheckbox = page.locator('#tool-websearch');
    if (!(await wsCheckbox.isChecked())) {
      await wsCheckbox.check();
    }

    // Switch to Browser provider
    await page.locator('#search-provider').click();
    await page.locator('[role="option"]', { hasText: 'Browser' }).click();

    // Open engine dropdown
    await page.locator('#search-engine').click();

    // All three engines should be available
    await expect(page.locator('[role="option"]', { hasText: 'Google' })).toBeVisible();
    await expect(page.locator('[role="option"]', { hasText: 'Bing' })).toBeVisible();
    await expect(page.locator('[role="option"]', { hasText: 'DuckDuckGo' })).toBeVisible();

    await page.close();
  });
});
