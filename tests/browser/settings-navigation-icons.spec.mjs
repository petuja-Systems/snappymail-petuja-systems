import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as playwrightTest } from '@playwright/test';
import { expect, test as authenticatedTest } from './authenticated-ui-fixture.mjs';
import { indexFixture } from './login-fixture.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const appRoot = path.join(repository, 'snappymail/v/0.0.0');
const adminOrigin = 'http://127.0.0.1:8793';

const userEntries = [
	['General', 'settings'],
	['Contacts', 'contact-round'],
	['Accounts', 'user-round'],
	['Filters', 'filter'],
	['Security', 'shield-check'],
	['Folders', 'folder']
];

const adminEntries = [
	['General', 'settings'],
	['Domains', 'globe'],
	['Login', 'key-round'],
	['Branding', 'palette'],
	['Contacts', 'contact-round'],
	['Security', 'shield-check'],
	['Config', 'wrench'],
	['About', 'info']
];

async function checkNavigation(page, nav, entries) {
	const links = nav.locator('a');
	await expect(links).toHaveText(entries.map(([label]) => label));
	const measurements = [];

	for (const [index, [label, icon]] of entries.entries()) {
		const link = links.nth(index);
		await expect(link).toHaveAccessibleName(label);
		await expect(link).toHaveAttribute('data-ui-icon', icon);
		expect(await link.evaluate(element => element.childElementCount)).toBe(0);
		expect(await link.evaluate(element => element.hasAttribute('tabindex'))).toBe(false);

		const pseudo = await link.evaluate(element => {
			const style = getComputedStyle(element, '::before');
			return {
				mask: [style.maskImage, style.webkitMaskImage].filter(value => value && value !== 'none').join(' '),
				width: style.width,
				height: style.height,
				marginInlineEnd: style.marginInlineEnd,
				color: getComputedStyle(element).color,
				background: style.backgroundColor
			};
		});
		expect(pseudo.mask).toContain(icon + '.svg');
		expect(pseudo.width).toBe(pseudo.height);
		expect(pseudo.marginInlineEnd).not.toBe('0px');
		expect(pseudo.background).toBe(pseudo.color);
		measurements.push(pseudo.width);
	}

	expect(new Set(measurements).size).toBe(1);
	return links;
}

async function checkNoNavOverflow(nav) {
	const dimensions = await nav.evaluate(element => ({
		navWidth: element.clientWidth,
		navScrollWidth: element.scrollWidth,
		navLeft: element.getBoundingClientRect().left,
		navRight: element.getBoundingClientRect().right,
		links: [...element.querySelectorAll('a')].map(link => {
			const rect = link.getBoundingClientRect();
			return { left: rect.left, right: rect.right, height: rect.height, width: link.clientWidth, scrollWidth: link.scrollWidth };
		})
	}));
	expect(dimensions.navScrollWidth).toBeLessThanOrEqual(dimensions.navWidth);
	for (const link of dimensions.links) {
		expect(link.left).toBeGreaterThanOrEqual(dimensions.navLeft - 1);
		expect(link.right).toBeLessThanOrEqual(dimensions.navRight + 1);
		expect(link.scrollWidth).toBeLessThanOrEqual(link.width);
		expect(link.height).toBe(dimensions.links[0].height);
	}
}

authenticatedTest('User Settings icons preserve labels, order, active state, keyboard focus, themes, RTL, and narrow layout', async ({ authenticated }) => {
	const { page } = authenticated;
	await authenticated.open({ capabilities: { AdditionalAccounts: true, Identities: true, Sieve: true } });
	await page.locator('#top-system-dropdown-id').click();
	await page.locator('#V-SystemDropDown a[data-bind*="settingsClick"]').click();
	await page.locator('#V-SettingsPane .toggleLeft').click();

	const nav = page.locator('#V-SettingsMenu nav');
	await expect(nav).toBeVisible();
	const links = await checkNavigation(page, nav, userEntries);
	await expect(links.nth(0)).toHaveClass(/selected/);

	await links.nth(0).focus();
	await page.keyboard.press('Tab');
	await expect(links.nth(1)).toBeFocused();
	expect(await links.nth(1).evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none');
	await page.keyboard.press('Shift+Tab');
	await expect(links.nth(0)).toBeFocused();
	await links.nth(1).focus();
	await page.keyboard.press('Enter');
	await expect(page).toHaveURL(/#\/settings\/contacts$/);
	await expect(links.nth(1)).toHaveClass(/selected/);

	for (const scheme of ['light', 'dark']) {
		await page.locator('html').evaluate((element, value) => element.setAttribute('data-appearance-scheme', value), scheme);
		const colors = await links.nth(0).evaluate(element => ({
			link: getComputedStyle(element).color,
			icon: getComputedStyle(element, '::before').backgroundColor
		}));
		expect(colors.icon).toBe(colors.link);
	}
	for (const [width, direction] of [[320, 'ltr'], [375, 'rtl'], [1280, 'ltr']]) {
		await page.setViewportSize({ width, height: 720 });
		await page.locator('html').evaluate((element, value) => { element.dir = value; }, direction);
		await checkNoNavOverflow(nav);
	}
});

playwrightTest('Admin Settings icons preserve labels, order, active state, keyboard focus, RTL, and narrow layout', async ({ page }) => {
	const consoleErrors = [], unexpectedRequests = [];
	page.on('pageerror', error => consoleErrors.push(error.message));
	page.on('console', message => {
		if ('error' === message.type()) consoleErrors.push(message.text());
	});
	const adminHtml = await indexFixture('en', true);
	await page.route('**/*', async route => {
		const request = route.request(), url = new URL(request.url());
		if (url.origin !== adminOrigin) {
			unexpectedRequests.push(url.origin);
			return route.abort();
		}
		if ('/' === url.pathname && !url.search) {
			return route.fulfill({ contentType: 'text/html', body: adminHtml });
		}
		if ('/fixture-manifest.json' === url.pathname) {
			return route.fulfill({ json: { name: 'petuja.email synthetic Admin settings fixture', start_url: '/', display: 'standalone' } });
		}
		if ('/' === url.pathname && /^\?\/AdminAppData\//.test(url.search)) {
			return route.fulfill({ json: {
				Auth: true,
				title: 'petuja.email',
				language: 'en',
				clientLanguage: 'en',
				hourCycle: 'h23',
				loadingDescription: 'petuja.email',
				StaticLibsJs: '/static/js/min/libs.min.js',
				Admin: { allowed: true, host: true, path: '', language: 'en', languages: ['en'], clientLanguage: 'en' },
				System: {
					languages: ['en'], version: '0.0.0', webVersionPath: '/', token: 'synthetic-admin-settings-token',
					folderSpecLimit: 50, allowAppendMessage: false, attachmentsActions: []
				}
			} });
		}
		if ('/' === url.pathname && url.search.startsWith('?/Json')) {
			const { Action } = request.postDataJSON();
			return route.fulfill({ json: { Action, Result: true } });
		}
		if (url.pathname.startsWith('/static/')) {
			const file = path.resolve(appRoot, '.' + decodeURIComponent(url.pathname));
			if (file.startsWith(path.join(appRoot, 'static') + path.sep)) {
				try { return await route.fulfill({ path: file }); } catch {}
			}
		}
		unexpectedRequests.push(url.pathname + url.search);
		return route.fulfill({ status: 404, body: 'Synthetic Admin fixture resource missing' });
	});

	await page.goto(adminOrigin + '/');
	await expect(page.locator('#V-AdminPane')).toBeVisible();
	await page.locator('#V-AdminPane .toggleLeft').click();
	const nav = page.locator('#rl-left nav');
	await expect(nav).toBeVisible();
	const links = await checkNavigation(page, nav, adminEntries);
	await expect(links.nth(0)).toHaveClass(/selected/);

	await links.nth(0).focus();
	await page.keyboard.press('Tab');
	await expect(links.nth(1)).toBeFocused();
	expect(await links.nth(1).evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none');
	await links.nth(2).focus();
	await page.keyboard.press('Enter');
	await expect(page).toHaveURL(/#\/login$/);
	await expect(links.nth(2)).toHaveClass(/selected/);

	for (const [width, direction] of [[320, 'ltr'], [375, 'rtl'], [1280, 'ltr']]) {
		await page.setViewportSize({ width, height: 720 });
		await page.locator('html').evaluate((element, value) => { element.dir = value; }, direction);
		await checkNoNavOverflow(nav);
	}
	expect(consoleErrors).toEqual([]);
	expect(unexpectedRequests).toEqual([]);
});
