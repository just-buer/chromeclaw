import { test, expect } from '../fixtures/extension';
import type { Page } from '@playwright/test';

/** Helper: navigate to Options page > Skills tab and wait for skills to load.
 *  First visits the side panel to seed predefined skills into IndexedDB. */
const openSkillsTab = async (page: Page, extensionId: string) => {
  // Seed predefined skills by briefly visiting the side panel (seeding runs on mount)
  await page.goto(`chrome-extension://${extensionId}/side-panel/index.html`);
  await page.waitForLoadState('domcontentloaded');
  // Wait just long enough for the seed effect to run
  await page.waitForTimeout(2000);

  // Now navigate to Options > Skills tab
  await page.goto(`chrome-extension://${extensionId}/options/index.html`);
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator('h1')).toContainText('ULCopilot Settings', { timeout: 10000 });
  await page.locator('nav button', { hasText: 'Skills' }).click();
  await expect(page.locator('button', { hasText: 'New Skill' })).toBeVisible({ timeout: 10000 });
  // Wait for skills to load from IndexedDB
  await expect(page.locator('text=Loading skills')).not.toBeVisible({ timeout: 15000 });
};

test.describe('Skill System — Options Page', () => {
  test('Skills tab shows bundled skills with descriptions', async ({ extensionId, context }) => {
    const page = await context.newPage();
    await openSkillsTab(page, extensionId);

    // The bundled skills should show their display names from frontmatter
    const bundledSkills = ['Daily Journal'];
    for (const skillName of bundledSkills) {
      await expect(page.getByText(skillName, { exact: true }).first()).toBeVisible();
    }

    // Each should have the ZapIcon (amber) — verify via svg
    const skillIcons = page.locator('svg.lucide-zap');
    // Card header + 1 skill row = at least 2 ZapIcons
    const count = await skillIcons.count();
    expect(count).toBeGreaterThanOrEqual(2);

    await page.close();
  });

  test('user can toggle a skill enabled/disabled', async ({ extensionId, context }) => {
    const page = await context.newPage();
    await openSkillsTab(page, extensionId);

    // Find the first ON/OFF toggle button
    const toggleBtn = page.locator('button', { hasText: /^(ON|OFF)$/ }).first();
    await expect(toggleBtn).toBeVisible();
    const initialText = (await toggleBtn.textContent())?.trim();

    await toggleBtn.click();

    // Wait for the toggle state to update (async storage write + re-render)
    const expectedText = initialText === 'ON' ? 'OFF' : 'ON';
    await expect(toggleBtn).toHaveText(expectedText, { timeout: 5000 });

    // Toggle back to restore original state
    await toggleBtn.click();
    await expect(toggleBtn).toHaveText(initialText!, { timeout: 5000 });

    await page.close();
  });

  test('user can edit a skill file inline', async ({ extensionId, context }) => {
    const page = await context.newPage();
    await openSkillsTab(page, extensionId);

    // Click the edit button on the first skill (the button after the ON/OFF toggle in each row)
    // Each skill row has: [ON/OFF toggle] [edit button] [optional delete button]
    const firstSkillRow = page.locator('.divide-y > div').first();
    const editBtn = firstSkillRow.locator('button').nth(-1); // last button in predefined row is edit
    await editBtn.click();

    // Inline editor should open with a textarea containing skill content
    const textarea = page.locator('textarea');
    await expect(textarea).toBeVisible();

    // The textarea should contain frontmatter from the skill
    const content = await textarea.inputValue();
    expect(content).toContain('name:');
    expect(content).toContain('description:');

    // Cancel and Save buttons should be present
    await expect(page.locator('button', { hasText: 'Cancel' })).toBeVisible();
    await expect(page.locator('button', { hasText: 'Save' })).toBeVisible();

    await page.close();
  });

  test('user can create a new custom skill', async ({ extensionId, context }) => {
    const page = await context.newPage();
    await openSkillsTab(page, extensionId);

    // Click "New Skill" button
    const newSkillBtn = page.locator('button', { hasText: 'New Skill' });
    await expect(newSkillBtn).toBeVisible();
    await newSkillBtn.click();

    // Inline editor should open with the skill template
    const textarea = page.locator('textarea');
    await expect(textarea).toBeVisible();
    const content = await textarea.inputValue();
    expect(content).toContain('name:');
    expect(content).toContain('description:');

    await page.close();
  });

  test('user can delete a custom skill', async ({ extensionId, context }) => {
    const page = await context.newPage();
    await openSkillsTab(page, extensionId);

    // First create a custom skill
    const newSkillBtn = page.locator('button', { hasText: 'New Skill' });
    await newSkillBtn.click();

    // Cancel the editor to go back to the list
    const cancelBtn = page.locator('button', { hasText: 'Cancel' });
    await cancelBtn.click();

    // The custom "Untitled" skill should now be in the list (frontmatter name)
    await expect(page.getByText('Untitled', { exact: true }).first()).toBeVisible();

    // Click the delete button for the custom skill
    // Custom skills have an extra delete button that predefined skills don't
    // Find the row with "Untitled" and get its last button (delete)
    const untitledRow = page.locator('.divide-y > div').filter({ hasText: 'Untitled' });
    const deleteBtn = untitledRow.locator('button').last();
    await expect(deleteBtn).toBeVisible();

    // Accept the confirmation dialog
    page.on('dialog', dialog => dialog.accept());
    await deleteBtn.click();

    await page.close();
  });

  test('predefined skills have no delete button', async ({ extensionId, context }) => {
    const page = await context.newPage();
    await openSkillsTab(page, extensionId);

    // Predefined skill rows should have exactly 2 buttons each (ON/OFF + edit, no delete)
    // Verify that each predefined row has no more than 2 buttons
    const skillRows = page.locator('.divide-y > div');
    const rowCount = await skillRows.count();
    for (let i = 0; i < rowCount; i++) {
      const btnCount = await skillRows.nth(i).locator('button').count();
      expect(btnCount).toBeLessThanOrEqual(2);
    }

    await page.close();
  });

  test('import zip button exists with file input', async ({ extensionId, context }) => {
    const page = await context.newPage();
    await openSkillsTab(page, extensionId);

    // Verify Import Zip button exists
    const importBtn = page.locator('button', { hasText: 'Import Zip' });
    await expect(importBtn).toBeVisible();

    // Verify the hidden file input accepts .zip
    const fileInput = page.locator('input[type="file"][accept=".zip"]');
    await expect(fileInput).toHaveCount(1);

    await page.close();
  });

  test('importing invalid zip shows error toast', async ({ extensionId, context }) => {
    const page = await context.newPage();
    await openSkillsTab(page, extensionId);

    // Set up a non-zip file via the hidden input
    const fileInput = page.locator('input[type="file"][accept=".zip"]');

    // Create a fake file (not a valid zip) and trigger the input
    await fileInput.setInputFiles({
      name: 'invalid.zip',
      mimeType: 'application/zip',
      buffer: Buffer.from('not a valid zip file'),
    });

    // An error toast should appear
    const toastEl = page.locator('[data-sonner-toast][data-type="error"]');
    await expect(toastEl).toBeVisible({ timeout: 5000 });

    await page.close();
  });
});
