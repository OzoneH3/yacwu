import { expect, test, type Page } from '@playwright/test';

async function mockApi(page: Page) {
	await page.route('**/api/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
		if (path === '/api/threads') return route.fulfill({ json: { data: [], defaultCwd: '/tmp' } });
		await route.fulfill({ json: {} });
	});
}

test('the session list footer shows the build and offers a reload after a new one', async ({ page }) => {
	await mockApi(page);
	await page.goto('/');
	const footer = page.locator('.sidebar .hint');
	await expect(footer.getByText('0 sessions')).toBeVisible();
	await expect(footer.locator('.build-version')).toHaveText(/^[0-9a-f]{7,}\+?$|^unknown$/);
	await expect(footer.getByRole('button', { name: 'New version · Reload' })).toHaveCount(0);

	await page.route('**/_app/version.json', (route) => route.fulfill({ json: { version: 'f00dbab@2030-01-01T00:00:00.000Z' } }));
	await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
	const reload = footer.getByRole('button', { name: 'New version · Reload' });
	await expect(reload).toBeVisible();
	await expect(footer.locator('.build-version')).toHaveCount(0);

	await page.unroute('**/_app/version.json');
	await reload.click();
	await expect(footer.locator('.build-version')).toBeVisible();
});
