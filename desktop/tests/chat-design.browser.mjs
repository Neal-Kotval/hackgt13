import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir, realpath } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';

const desktop = fileURLToPath(new URL('..', import.meta.url));
const root = path.dirname(desktop.replace(/\/$/, ''));
const artifacts = path.join(root, 'artifacts/hac-154');
await mkdir(artifacts, { recursive: true });
const server = await createServer({ configFile: false, root: desktop, publicDir: path.join(root, 'public'), resolve: { dedupe: ['react', 'react-dom', '@radix-ui/react-select', '@phosphor-icons/react'], alias: { '@agentcloud-tokens': path.join(root, 'app/tokens.css') } }, server: { host: '127.0.0.1', port: 0, fs: { allow: [root, await realpath(path.join(root, 'node_modules'))] } }, esbuild: { jsx: 'automatic' } });
let browser;
try {
  await server.listen();
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript({ path: path.join(desktop, 'tests/chat-design.fixture.js') });
  await page.goto(base);
  await expect(page.getByText("Replies come from this project's agent via alto.", { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Tasks', exact: true })).toHaveCount(0);
  await expect(page.getByText('What can I help with?', { exact: true })).toHaveCount(0);
  async function layout(state) {
    for (const width of [375, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await page.locator('.conversation').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      const composer = await page.locator('.composer-row').boundingBox();
      expect(composer.y + composer.height).toBeLessThanOrEqual(900);
      await page.screenshot({ path: path.join(artifacts, `${state}-${width}.png`) });
    }
  }
  await layout('empty');
  const input = page.getByRole('textbox', { name: 'Message', exact: true });
  await input.fill('Review notes');
  await input.press('Shift+Enter');
  await input.pressSequentially('Keep the API stable.');
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
  await expect(input).toHaveValue('Review notes\nKeep the API stable.');
  await page.getByLabel('Choose text context files').setInputFiles({ name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('Use cursor pagination.') });
  await expect(page.getByRole('button', { name: 'Remove notes.md' })).toBeVisible();
  await page.getByRole('button', { name: 'Remove notes.md' }).click();
  await expect(page.getByRole('button', { name: 'Remove notes.md' })).toHaveCount(0);
  await page.getByLabel('Choose text context files').setInputFiles({ name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('Use cursor pagination.') });
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.getByRole('button', { name: 'Copy code', exact: true }).waitFor();
  const originalText = await page.evaluate(() => window.__test.sends[0].text);
  expect(originalText).toContain('Attached context: notes.md\nUse cursor pagination.');
  await expect(page.locator('.hljs-keyword')).toHaveCount(1);
  await page.getByRole('button', { name: 'Copy code', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('// bounded results\nconst message = "ready";');
  await layout('active');
  // A lost Retry response must retain its idempotency key, and never consume an unrelated draft.
  await input.fill('Unrelated unsent draft');
  await page.evaluate(() => { window.__test.loseResponse = true; });
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByText('Test response lost', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('.message[data-role="user"]')).toHaveCount(2);
  const requests = await page.evaluate(() => window.__test.sends);
  expect(requests[1].requestId).toBe(requests[2].requestId);
  await expect(input).toHaveValue('Unrelated unsent draft');
  await page.evaluate(() => { window.__test.fail = true; });
  await page.getByRole('button', { name: 'Retry', exact: true }).last().click();
  await expect(page.getByRole('button', { name: 'Send as a new turn' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  await page.evaluate(() => { window.__test.fail = false; });
  await page.getByRole('button', { name: 'Send as a new turn' }).click();
  await expect(page.getByRole('button', { name: 'Send as a new turn' })).toHaveCount(0);
  expect(await page.evaluate(() => window.__test.sends.at(-1).text)).toBe(originalText);
  await expect(input).toHaveValue('Unrelated unsent draft');
  // State alone never invents command results, a GPU, or an SSH connection.
  await page.evaluate(() => { window.__test.sessions[0].status = 'running'; window.__test.events.s1.push({ id: 'command', kind: 'command', text: 'Command running. Output is not saved.', updatedAt: new Date().toISOString() }); });
  await expect(page.getByText('Responding…', { exact: true })).toBeVisible();
  await expect(page.locator('.codex-streaming-cursor')).toHaveCount(1);
  await expect(input).toHaveValue('Unrelated unsent draft');
  await layout('streaming');
  await page.locator('.codex-command summary').click();
  await expect(page.locator('.codex-command')).toHaveAttribute('open', '');
  await page.getByRole('button', { name: 'Stop response' }).click();
  await expect(page.getByText('Turn interrupted', { exact: true })).toBeVisible();
  await expect(input).toHaveValue('Unrelated unsent draft');
  for (const width of [375, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await page.keyboard.press('Meta+k');
    const search = page.getByRole('searchbox', { name: 'Search chats' });
    await expect(search).toBeFocused();
    await search.fill('no match');
    await expect(page.getByText('No chats match “no match”', { exact: true })).toBeVisible();
    await search.fill('');
    await page.getByRole('button', { name: 'Sign out' }).focus();
    await page.keyboard.press('Tab');
    await expect(page.locator('.shell-close')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeFocused();
  }
  await expect(input).toHaveValue('Unrelated unsent draft');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByLabel('Choose text context files').setInputFiles({ name: 'draft.md', mimeType: 'text/markdown', buffer: Buffer.from('Preserve this attachment.') });
  await page.locator('.chat-context-toolbar').getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name: 'review-agent', exact: true }).click();
  await expect(input).toHaveAttribute('placeholder', 'Ask review-agent to work on UI verification');
  await expect(input).toHaveValue('');
  await page.locator('.chat-context-empty').getByRole('combobox', { name: 'Agent', exact: true }).click();
  await page.getByRole('option', { name: 'desktop-chat', exact: true }).click();
  await expect(input).toHaveValue('Unrelated unsent draft');
  await expect(page.getByRole('button', { name: 'Remove draft.md' })).toBeVisible();
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await expect(page.getByText('Choose an agent to open its conversation.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  // Removed Tasks links route truthfully; never connect to an origin from a link.
  await page.evaluate(() => window.__test.deepLink({ ok: true, target: { projectId: 'p1', taskRunBoxId: 'box-1' } }));
  await expect(page.getByRole('heading', { name: 'Environment terminal', exact: true })).toBeVisible();
  await expect(page.getByText('Error · Test SSH unavailable', { exact: true })).toBeVisible();
  await page.evaluate(() => window.__test.deepLink({ ok: true, target: { projectId: 'p1', environmentId: 'legacy-catalog' } }));
  await expect(page.getByText('This legacy link names a catalog resource. Select its environment from the list below.', { exact: true })).toBeVisible();
  await page.evaluate(() => window.__test.deepLink({ ok: true, target: { projectId: 'p1', serverUrl: 'https://other.example.invalid' } }));
  await expect(page.getByText(/This link came from a different alto server/)).toBeVisible();
  await page.goto(`${base}/?no-projects`);
  await expect(page.getByText('Choose a project to get started.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  await expect(page.getByRole('link', { name: 'Set up agent on website' })).toBeVisible();
  expect(errors).toEqual([]);
  console.log('PASS: responsive empty/active/streaming, safe context sending, Markdown copy, retry dedup/recovery, drafts, search/focus, session selection, legacy links and empty projects.');
} finally { await browser?.close(); await server.close(); }
