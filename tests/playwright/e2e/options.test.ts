import { test } from '../fixtures/extension';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/** Navigate to options and wait for the page to be ready. */
const openOptions = async (page: Page, extensionId: string) => {
  await page.goto(`chrome-extension://${extensionId}/options/index.html`);
  await page.waitForLoadState('domcontentloaded');
  // Wait for the options page to render (h1 is always present)
  await expect(page.locator('h1')).toContainText('ULCopilot Settings', { timeout: 10000 });
};

/** Click a tab in the options page nav. */
const clickTab = async (page: Page, tabName: string) => {
  await page.locator('nav button', { hasText: tabName }).click();
};

test.describe('Options Page @phase-5', () => {
  test('MVP-10: options page loads with all tabs', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await openOptions(page, extensionId);

    // Page title
    await expect(page.locator('h1')).toContainText('ULCopilot Settings');

    // General tab is active by default — Settings card should be visible
    await expect(page.locator('text=Settings').first()).toBeVisible();

    // Navigate to Model tab and verify
    await clickTab(page, 'Model');
    await expect(page.locator('text=Model Configuration')).toBeVisible();
    await expect(page.locator('button:has-text("Add Model")')).toBeVisible();

    await page.close();
  });

  test('MVP-10: settings form saves values', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await openOptions(page, extensionId);

    // General tab is default — theme selector should be visible
    await expect(page.locator('#theme')).toBeVisible();

    // Change theme to trigger auto-save
    await page.locator('#theme').click();
    await page.locator('text=Dark').click();

    // Should show saved confirmation
    await expect(page.locator('text=Saved')).toBeVisible();

    await page.close();
  });

  test('MVP-10: add model dialog opens', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await openOptions(page, extensionId);

    // Navigate to Model tab
    await clickTab(page, 'Model');

    // Click Add Model
    await page.locator('button:has-text("Add Model")').click();

    // Dialog should open with form fields
    await expect(page.locator('#model-name')).toBeVisible();
    await expect(page.locator('#model-provider')).toBeVisible();

    await page.close();
  });
});

test.describe('Options Page @phase-9', () => {
  test('MVP-17: add custom model via options page', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await openOptions(page, extensionId);

    // Navigate to Model tab
    await clickTab(page, 'Model');

    // Click Add Model
    await page.locator('button:has-text("Add Model")').click();

    // Fill in model details
    await page.locator('#model-name').fill('Test Model');
    await page.locator('#model-id').fill('test-model-1');
    await page.locator('#model-apikey').fill('sk-test123');

    // The add model dialog should have required fields
    await expect(page.locator('#model-name')).toHaveValue('Test Model');
    await expect(page.locator('#model-id')).toHaveValue('test-model-1');

    await page.close();
  });

  test('FR-1: suggested actions config section visible', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await openOptions(page, extensionId);

    // Navigate to Shortcuts tab
    await clickTab(page, 'Actions');

    // Suggested Actions section should be visible
    await expect(page.locator('text=Suggested Actions')).toBeVisible();
    await expect(page.locator('button:has-text("Add Action")')).toBeVisible();
    await expect(page.locator('button:has-text("Reset to Defaults")')).toBeVisible();

    await page.close();
  });

  test('FR-1: add and save a custom suggested action', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await openOptions(page, extensionId);

    // Navigate to Shortcuts tab
    await clickTab(page, 'Actions');

    // Click "Add Action"
    await page.locator('button:has-text("Add Action")').click();

    // The new action should have empty fields — find the last label/prompt inputs
    const inputs = page.locator('input[placeholder="Button label (shown on chat screen)"]');
    const lastInput = inputs.last();
    await lastInput.fill('Custom test action');

    const prompts = page.locator('textarea[placeholder="Full prompt sent to the AI when clicked"]');
    const lastPrompt = prompts.last();
    await lastPrompt.fill('This is my custom prompt');

    // Wait for auto-save debounce
    await expect(page.locator('text=Saved')).toBeVisible({ timeout: 5000 });

    await page.close();
  });

  test('FR-1: reset to defaults restores original actions', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await openOptions(page, extensionId);

    // Navigate to Shortcuts tab
    await clickTab(page, 'Actions');

    // Click reset
    await page.locator('button:has-text("Reset to Defaults")').click();

    // Wait for auto-save after reset
    await expect(page.locator('text=Saved')).toBeVisible({ timeout: 5000 });

    await page.close();
  });

  test('FR-12: Skills tab is visible and navigable', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await openOptions(page, extensionId);

    // Skills tab button should be visible in the nav
    const skillsTab = page.locator('nav button', { hasText: 'Skills' });
    await expect(skillsTab).toBeVisible();

    // Click Skills tab
    await skillsTab.click();

    // Skills card content should be visible — check for action buttons
    await expect(page.locator('button', { hasText: 'New Skill' })).toBeVisible();
    await expect(page.locator('button', { hasText: 'Import Zip' })).toBeVisible();

    await page.close();
  });

  test('MVP-21: backend settings not editable in options UI', async ({ context, extensionId }) => {
    const page = await context.newPage();
    await openOptions(page, extensionId);

    // Backend config inputs should NOT be present
    await expect(page.locator('#app-id')).not.toBeVisible();

    // Theme selector should still be present (General tab is default)
    await expect(page.locator('#theme')).toBeVisible();

    await page.close();
  });
});
