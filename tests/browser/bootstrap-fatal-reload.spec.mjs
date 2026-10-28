import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { indexFixture } from './login-fixture.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../snappymail/v/0.0.0'),
	origin = 'http://127.0.0.1:8789';

test('bootstrap failure exposes one localized keyboard and touch accessible safe GET retry', async ({ page }) => {
	const html = await indexFixture('de', false, '/mail/'),
		requests = [], appDataRequests = [];
	page.on('request', request => requests.push({
		url: request.url(), method: request.method(), postData: request.postData()
	}));
	await page.route('**/*', async route => {
		const request = route.request(), url = new URL(request.url());
		if (url.origin !== origin) return route.abort();
		if (url.pathname === '/fixture-start') {
			return route.fulfill({ contentType: 'text/html', body: '<form method="post" action="/mail/"><input name="synthetic_mutation" value="must-not-replay"><button id="simulate-post">Continue</button></form>' });
		}
		if (url.pathname === '/mail/' && !url.search) {
			return route.fulfill({ contentType: 'text/html', body: html });
		}
		if (url.pathname === '/mail/' && url.search.startsWith('?/AppData/')) {
			appDataRequests.push(request);
			return route.fulfill({ status: 503, contentType: 'text/html', body: '<img src=x onerror="window.__serverBodyExecuted=true">/private/test/path' });
		}
		if (url.pathname === '/fixture-manifest.json') {
			return route.fulfill({ json: { name: 'petuja.email fatal fixture', start_url: '/mail/', display: 'standalone' } });
		}
		if (url.pathname.startsWith('/static/')) {
			const file = path.resolve(appRoot, '.' + decodeURIComponent(url.pathname));
			if (file.startsWith(path.join(appRoot, 'static') + path.sep)) {
				try { return await route.fulfill({ path: file }); } catch {}
			}
		}
		return route.abort();
	});

	await page.goto(origin + '/fixture-start');
	const failedPost = page.waitForRequest(request =>
		request.url() === origin + '/mail/' && request.method() === 'POST');
	await page.locator('#simulate-post').click();
	const postRequest = await failedPost;
	await expect(page.locator('#rl-loading-error')).toBeVisible();
	const error = page.locator('#rl-loading-error'), link = error.getByRole('link', { name: 'Aktualisieren' });
	await expect(error.locator('#rl-loading-error-reload')).toHaveCount(1);
	await expect(link).toHaveAccessibleName('Aktualisieren');
	await expect(error.locator('img')).toHaveCount(0);
	await expect(error).not.toContainText('/private/test/path');
	await expect(page.locator('meta[http-equiv="refresh"]')).toHaveCount(0);
	await expect(error.locator('script')).toHaveCount(0);
	const href = await link.getAttribute('href');
	expect(href).toBe('/mail/');
	const target = new URL(href, page.url());
	expect(target.origin).toBe(origin);
	expect(postRequest.postData()).toContain('must-not-replay');
	const linkAttributes = await link.evaluate(element => [...element.attributes].map(attribute => attribute.name));
	expect(linkAttributes.some(name => /^on/i.test(name))).toBe(false);
	const box = await link.boundingBox();
	expect(box?.height).toBeGreaterThanOrEqual(44);

	await page.keyboard.press('Tab');
	await expect(link).toBeFocused();
	const outlineWidth = await link.evaluate(element => parseFloat(getComputedStyle(element).outlineWidth));
	expect(outlineWidth).toBeGreaterThanOrEqual(2);
	const retry = page.waitForRequest(request =>
		request.url() === target.href && request.method() === 'GET');
	await page.keyboard.press('Enter');
	const retryRequest = await retry;
	expect(retryRequest.postData()).toBeNull();
	await expect(page.locator('#rl-loading-error')).toBeVisible();
	expect(appDataRequests).toHaveLength(2);
	expect(requests.filter(request => request.url === target.href).map(request => request.method)).toEqual(['POST', 'GET']);
});
