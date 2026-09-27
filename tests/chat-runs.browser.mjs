import { chromium, expect } from '@playwright/test';
const base = process.env.RUNS_TEST_URL || 'http://127.0.0.1:3003';
const projectId = process.env.RUNS_TEST_PROJECT;
const storageState = process.env.RUNS_TEST_STORAGE;
if (!projectId || !storageState) throw new Error('Set RUNS_TEST_PROJECT and RUNS_TEST_STORAGE to an authorized local test session.');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  for (const width of [375, 768, 1440]) {
    const context = await browser.newContext({ storageState, viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let status = 200;
    let run = { id: 'chat:request', sessionId: 'chat', projectId, runBoxId: 'box-test-1234', prompt: 'Review the signup flow', status: 'running', startedAt: '2026-09-27T04:00:00Z', finishedAt: null, actorName: 'Test member', environment: { provider: 'docker-local', state: 'ready' }, events: [] };
    let runs = [run];
    // Browser-only fixtures: no records or model activity are created.
    await page.route('**/api/chat-runs?*', route => route.fulfill({ status, json: status === 200 ? { runs } : { error: 'unavailable' } }));
    await page.goto(`${base}/projects/${projectId}/runs`);
    const item = page.getByRole('link', { name: /Review the signup flow/ });
    await expect(item).toContainText('In progress');
    await item.click();
    await expect(page.getByRole('heading', { name: 'Conversation details', exact: true })).toBeFocused();
    await expect(page.getByRole('link', { name: 'Open chat in desktop' })).toHaveAttribute('href', /codexSessionId=chat/);
    run.status = 'completed'; run.finishedAt = '2026-09-27T04:01:00Z'; run.environment.state = 'stopped';
    run.events = [{ id: 'reply', kind: 'assistant', text: 'The review is complete.', createdAt: run.finishedAt }, { id: 'command', kind: 'command', text: 'Checked the signup form.', createdAt: run.finishedAt }];
    await expect(item).toContainText('Completed', { timeout: 10000 }); // automatic refresh
    await expect(page.getByText('The review is complete.')).toBeVisible();
    await page.getByText('Work details (1)', { exact: true }).press('Enter');
    await expect(page.getByText('Checked the signup form.')).toBeVisible();
    const followup = { ...run, id: 'chat:followup', prompt: 'Now fix the signup flow', status: 'running', startedAt: '2026-09-27T04:02:00Z', finishedAt: null, events: [] };
    runs = [followup, run];
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(item).toContainText('In progress');
    await expect(page.locator('a[href*="?conversation="]')).toHaveCount(1);
    await expect(page.getByText('Now fix the signup flow', { exact: true })).toBeVisible();
    await page.getByText('Earlier messages (1)', { exact: true }).press('Enter');
    await expect(page.getByText('The review is complete.', { exact: false })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open chat in desktop' })).toHaveAttribute('href', /codexSessionId=chat/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('link', { name: 'Close conversation details' }).click();
    await expect(page.getByRole('heading', { name: 'Conversation details', exact: true })).toHaveCount(0);
    await page.getByRole('combobox', { name: 'Filter conversations by status' }).click();
    await page.getByRole('option', { name: 'Needs attention', exact: true }).click();
    await expect(page.getByText('No conversations match this status.', { exact: false })).toBeVisible();
    await page.getByRole('combobox', { name: 'Filter conversations by status' }).click();
    await page.getByRole('option', { name: 'All conversations', exact: true }).click();
    status = 503;
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Conversations' }).getByRole('alert')).toContainText('couldn’t update');
    await expect(item).toBeVisible(); // retain last successful data
    status = 200; runs = [];
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Your conversations will appear here' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Conversations' }).getByRole('alert')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
    await context.close();
  }
  console.log('Conversations: grouped follow-ups, retained replies, live updates, details, exact-chat link, keyboard access, filtering, stale/error/empty states and 375/768/1440 layouts passed.');
} finally { await browser.close(); }
