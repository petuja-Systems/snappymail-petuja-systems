import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect } from '@playwright/test';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const appRoot = path.join(repository, 'snappymail/v/0.0.0');
const origin = 'http://127.0.0.1:8789';
const read = relative => readFile(path.join(appRoot, relative), 'utf8');
const productVersion = JSON.parse(readFileSync(path.join(appRoot, 'app/petuja-product.json'), 'utf8')).version;
export const fixtureStaticBase = '/snappymail/v/0.0.0/static/petuja-email-' + productVersion + '/';
export function fixtureStaticFile(pathname) {
	if (!pathname.startsWith(fixtureStaticBase)) return null;
	const root = path.join(appRoot, 'static', 'petuja-email-' + productVersion);
	const file = path.resolve(root, decodeURIComponent(pathname.slice(fixtureStaticBase.length)));
	return file.startsWith(root + path.sep) ? file : null;
}

async function indexFixture(language, admin, reloadHref = admin ? '/?admin' : '/') {
	const catalog = {
		...JSON.parse(await read('app/localization/' + language + '/static.json')),
		...JSON.parse(await read('app/localization/' + language + '/' + (admin ? 'admin' : 'user') + '.json'))
	};
	let templates = '';
	for (const group of ['Components', admin ? 'Admin' : 'User', 'Common']) {
		for (const file of (await readdir(path.join(appRoot, 'app/templates/Views', group))).sort()) {
			if (file.endsWith('.html')) {
				const id = file.slice(0, -5) + (group === 'Components' ? 'Component' : '');
				const source = await read('app/templates/Views/' + group + '/' + file);
				templates += '<template id="' + id + '">' + source.replace(/<(\/?)script/gi, '<$1x-script') + '</template>';
			}
		}
	}
	const replacements = {
		BaseAppBootCss: await read('static/css/boot.min.css'),
		BaseAppMainCssLink: fixtureStaticBase + 'css/' + (admin ? 'admin' : 'app') + '.min.css',
		BaseAppManifestLink: fixtureStaticBase + 'manifest.json',
		BaseFavIconSvg: fixtureStaticBase + 'images/petuja-systems-logo.svg',
		BaseTemplates: templates,
		BaseAppBootScript: await read('static/js/boot.js'),
		BaseLanguage: 'rl.I18N=' + JSON.stringify(catalog) + ';',
		BaseAppAdmin: admin ? '1' : '0',
		ReloadHref: reloadHref.replace(/[&<>"']/g, character => ({
			'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
		})[character]),
		ReloadLabelEsc: String(catalog.BACK_LINK || 'Reload').replace(/[&<>"']/g, character => ({
			'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
		})[character]),
		LoadingDescriptionEsc: 'petuja.email'
	};
	return (await read('app/templates/Index.html'))
		.replace('<html class=', '<html lang="' + language + '" class=')
		.replace(/\{\{([^}]+)\}\}/g, (_, key) => replacements[key] ?? '');
}

export const test = base.extend({
	login: async ({ page, browserName }, use, testInfo) => {
		const consoleErrors = [], unexpectedRequests = [], actions = [], measurements = [];
		let response = { additional: 'Authentication failed.' }, factor = false;
		page.on('pageerror', error => consoleErrors.push(error.message));
		page.on('console', message => {
			if (['error', 'warning'].includes(message.type())) consoleErrors.push(message.text());
		});
		await page.addInitScript(() => {
			addEventListener('rl-view-model', event => {
				if ('submitError' in event.detail) window.__loginLayoutView = event.detail;
			});
		});

		const fixture = {
			page, actions, measurements,
			async open({ language = 'en', admin = false, step = 'primary', additional = 'Authentication failed.' } = {}) {
				response = { additional };
				factor = step === 'factor';
				const html = await indexFixture(language, admin);
				await page.unroute('**/*');
				await page.route('**/*', async route => {
					const request = route.request(), url = new URL(request.url());
					if (url.origin !== origin) {
						unexpectedRequests.push(url.origin + url.pathname);
						return route.abort();
					}
					if (url.pathname === '/' && !url.search) {
						return route.fulfill({ contentType: 'text/html', body: html });
					}
					if (url.pathname === '/' && /^\?\/(Admin)?AppData\//.test(url.search)) {
						return route.fulfill({ json: {
							Auth: false, title: 'petuja.email', language, clientLanguage: language,
							hourCycle: 'h23', allowLanguagesOnLogin: true, signMe: 1,
							loadingDescription: 'petuja.email', DevEmail: '', DevPassword: '',
							StaticLibsJs: fixtureStaticBase + 'js/min/libs.min.js',
							Admin: { allowed: true, host: true, path: '' },
							System: {
								languages: ['en', 'de', 'ar'], version: '0.0.0', webVersionPath: '/', webStaticPath: fixtureStaticBase,
								petujaEmailVersion: 'fixture', petujaEmailSnappyMailVersion: '2.38.2',
								petujaEmailSourceUrl: 'https://example.test/source',
								token: 'synthetic-layout-fixture'
							}
						} });
					}
					if (url.pathname === '/' && url.search.startsWith('?/Json')) {
						const data = request.postDataJSON(), action = data.Action;
						// Keep diagnostics free of passwords, codes, cookies and request bodies.
						actions.push(action);
						if (factor && action === 'TwoFactorLoginBegin') {
							return route.fulfill({ json: { Action: action, Result: {
								RequiresTwoFactor: true, Challenge: 'A'.repeat(43),
								Account: 'demo@example.test', ExpiresAt: Math.floor(Date.now() / 1000) + 600
							} } });
						}
						if (['TwoFactorLoginBegin', 'TwoFactorLoginVerify', 'AdminLogin'].includes(action)) {
							return route.fulfill({ json: {
								Action: action, Result: false, code: 102,
								message: '', messageAdditional: response.additional
							} });
						}
						unexpectedRequests.push('Unexpected fixture action: ' + action);
						return route.fulfill({ status: 400, body: 'Unexpected fixture action' });
					}
					// Only production-built static assets from the development tree.
					const file = fixtureStaticFile(url.pathname);
					if (file) {
						try { return await route.fulfill({ path: file }); } catch {}
					}
					unexpectedRequests.push(url.pathname + url.search);
					return route.fulfill({ status: 404, body: 'Fixture resource missing' });
				});
				await page.goto(origin + '/');
				await expect(page.locator(admin ? '#V-AdminLogin.LoginView' : '#V-Login.LoginView')).toBeVisible();
				await expect(page.locator('#rl-loading-error')).toBeHidden();
				await expect(page.locator('#rl-loading-error-reload')).toHaveCount(1);
				await expect(page).toHaveTitle('petuja.email');
				await fixture.settle();
				if (admin) return;
				await expect(page.locator('#login-email')).toBeVisible();
				if (step === 'factor') {
					await fixture.submitPrimary();
					await expect(page.locator('#login-factor-code')).toBeFocused();
				}
			},
			async settle() {
				await page.evaluate(async () => {
					await document.fonts.ready;
					await Promise.all(document.getAnimations().filter(animation =>
						animation.effect?.getComputedTiming().iterations !== Infinity
					).map(animation => animation.finished.catch(() => {})));
					await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
				});
			},
			async submitPrimary() {
				await page.locator('#login-email').fill('demo@example.test');
				await page.locator('#login-password').fill('synthetic-layout-password');
				await page.locator('#V-Login button[type=submit]').click();
				await expect.poll(() => page.evaluate(() => window.__loginLayoutView.submitRequest())).toBe(false);
				await fixture.settle();
			},
			async fail(step) {
				if (step === 'factor') {
					await page.locator('#login-factor-code').fill('123456');
					await page.locator('#V-Login button[type=submit]').click();
					await expect(page.locator('#V-Login > .alert')).toBeVisible();
					await expect(page.locator('#login-factor-code')).toBeFocused();
					await expect(page.locator('#login-factor-code')).toHaveValue('');
				} else {
					await fixture.submitPrimary();
					await expect(page.locator('#V-Login > .alert')).toBeVisible();
				}
				await fixture.settle();
			},
			async text(main, additional) {
				// Geometry variants use the real text bindings; request/focus flows are exercised separately.
				await page.evaluate(({ main, additional }) => {
					window.__loginLayoutView.submitError(main);
					window.__loginLayoutView.submitErrorAdditional(additional);
				}, { main, additional });
				await fixture.settle();
			}
		};
		try {
			await use(fixture);
			expect(consoleErrors, 'Browser console / runtime errors').toEqual([]);
			expect(unexpectedRequests, 'Unmocked or external requests').toEqual([]);
		} finally {
			const diagnostics = testInfo.outputPath('layout-measurements.json');
			await mkdir(path.dirname(diagnostics), { recursive: true });
			await writeFile(diagnostics, JSON.stringify({ browserName, version: page.context().browser().version(),
				viewport: page.viewportSize(), actions, measurements, consoleErrors, unexpectedRequests }, null, 2));
			await testInfo.attach('layout-measurements', {
				path: diagnostics,
				contentType: 'application/json'
			});
		}
	}
});

export { expect, indexFixture };
