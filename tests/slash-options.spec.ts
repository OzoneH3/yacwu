import { expect, test } from '@playwright/test';
test('slash arguments filter and fill by click, Tab and Enter without submitting', async ({ page }) => {
    const thread = { id: 'options', cwd: '/project', status: { type: 'idle' }, turns: [] };
    let submissions = 0, profileReads = 0;
    await page.route('**/api/**', async (route) => {
        const url = new URL(route.request().url()), path = url.pathname;
        if (route.request().method() === 'POST' && /\/(?:message|fork|model|profile|file-access)$/.test(path))
            submissions++;
        if (path === '/api/events')
            return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
        let data: object = {};
        if (path === '/api/hosts')
            data = { hosts: [{ name: 'local', kind: 'local', provider: 'codex', state: 'connected' }, { name: 'oc', kind: 'backend', provider: 'opencode', state: 'connected' }] };
        else if (path === '/api/threads')
            data = { data: url.searchParams.get('host') === 'oc' ? [] : [thread], defaultCwd: '/project' };
        else if (path.endsWith('/model'))
            data = { model: 'gpt-6-luna', effort: 'medium', models: [{ id: 'gpt-6-luna', displayName: 'GPT-6 Luna', efforts: ['low', 'medium'], defaultEffort: 'medium' }], efforts: ['low', 'medium'] };
        else if (path.endsWith('/profile')) {
            profileReads++;
            data = { profile: null, profiles: [{ name: 'fast', model: 'gpt-6-luna' }, { name: 'deep review', model: 'gpt-6-luna' }] };
        }
        else if (path.endsWith('/file-access'))
            data = { mode: 'read-write', readOnlySupported: true };
        else if (path.endsWith('/history'))
            data = { turns: [], cursor: null };
        else if (path.startsWith('/api/threads/'))
            data = { thread };
        await route.fulfill({ json: data });
    });
    await page.goto('/s/options');
    const box = page.locator('.composer textarea');
    const list = page.getByRole('listbox', { name: 'Slash command options' });
    await box.fill('/fork ');
    await expect(list.getByRole('option')).toHaveCount(2);
    await box.fill('/fork op');
    await expect(list.getByRole('option')).toHaveCount(1);
    await list.getByRole('option', { name: /opencode/ }).click();
    await expect(box).toHaveValue('/fork opencode');
    await expect(list).toHaveCount(0);
    // Leave the popup before switching to keyboard selection: a stationary
    // pointer can hover a newly mounted option and replace the arrow selection.
    await page.mouse.move(0, 0);
    await box.fill('/mode ');
    await expect(list.getByRole('option')).toHaveCount(2);
    await box.press('ArrowDown');
    await expect(list.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true');
    await box.press('Enter');
    await expect(box).toHaveValue('/mode rw');
    await expect(list).toHaveCount(0);
    await box.fill('/mode r');
    await box.press('Escape');
    await expect(list).toHaveCount(0);
    await box.fill('/mode rw');
    await expect(list).toBeVisible();
    await box.press('Tab');
    await expect(box).toHaveValue('/mode rw');
    await expect(list).toHaveCount(0);
    await box.fill('/model --effort ');
    await expect(list.getByRole('option')).toHaveCount(2);
    await box.fill('/model --effort lo');
    await box.press('Enter');
    await expect(box).toHaveValue('/model --effort low');
    await box.fill('/profile ');
    await expect(list.getByRole('option', { name: /deep review/ })).toBeVisible();
    await box.fill('/profile d');
    await box.fill('/profile deep');
    await expect(list.getByRole('option')).toHaveCount(1);
    await list.getByRole('option').click();
    await expect(box).toHaveValue('/profile deep review');
    expect(profileReads).toBe(1);
    expect(submissions).toBe(0);
});
