import { test, expect } from './login-fixture.mjs';

const widths = [320, 375, 390];
const heights = [240, 320, 400, 480, 568, 667, 720, 844];
const variants = {
	short: { main: 'Authentication failed.', additional: '' },
	server: { main: 'Authentication failed.', additional: 'Authentication failed.' },
	multiline: {
		main: 'Authentication failed. Please check your account details and try again.',
		additional: 'The mail server rejected this login attempt. Please check your credentials before trying again.'
	},
	token: { main: 'Authentication failed.', additional: 'ServerIdentifierWithoutSpaces'.repeat(8) },
	hidden: { main: '', additional: '' }
};

async function geometry(login, label) {
	await login.settle();
	const result = await login.page.evaluate(() => {
		const root = document.querySelector('#V-Login'), alert = root.querySelector(':scope > .alert');
		const brand = root.querySelector('.login-brand h1');
		const rect = element => {
			const r = element.getBoundingClientRect();
			return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
		};
		const textRects = element => {
			const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT), boxes = [];
			while (walker.nextNode()) {
				const node = walker.currentNode;
				if (!node.textContent.trim() || node.parentElement.closest('.close')) continue;
				const range = document.createRange();
				range.selectNodeContents(node);
				for (const r of range.getClientRects()) {
					if (r.width && r.height) boxes.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
				}
			}
			return boxes;
		};
		const style = getComputedStyle(alert), a = rect(alert);
		const value = name => parseFloat(style[name]) || 0;
		return {
			viewport: { width: innerWidth, height: innerHeight, visualHeight: visualViewport?.height, scale: visualViewport?.scale },
			root: { ...rect(root), scrollWidth: root.scrollWidth, clientWidth: root.clientWidth,
				scrollHeight: root.scrollHeight, clientHeight: root.clientHeight, scrollTop: root.scrollTop },
			brand: {
				...rect(brand), clientWidth: brand.clientWidth,
				scrollWidth: brand.scrollWidth, text: textRects(brand)
			},
			alert: a, hidden: alert.hidden,
			content: {
				left: a.left + value('borderLeftWidth') + value('paddingLeft'),
				right: a.right - value('borderRightWidth') - value('paddingRight'),
				top: a.top + value('borderTopWidth') + value('paddingTop'),
				bottom: a.bottom - value('borderBottomWidth') - value('paddingBottom')
			},
			text: textRects(alert), desc: rect(root.querySelector('.descWrapper')),
			descText: textRects(root.querySelector('.descWrapper')), form: rect(root.querySelector('form')),
			fontSize: style.fontSize, lineHeight: style.lineHeight, flexShrink: style.flexShrink,
			additionalVisible: getComputedStyle(alert.querySelector('p')).display !== 'none'
		};
	});
	login.measurements.push({ label, ...result });
	return result;
}

function contained(result, { enlarged = false, additionalExpected = true } = {}) {
	const tolerance = 1; // CSS-pixel rounding differs between browser engines.
	if (result.hidden) {
		expect(result.alert.height, 'Hidden alert must reserve no space').toBe(0);
		expect(result.text).toHaveLength(0);
	} else {
		expect(result.text.length, 'Visible alert must contain measured text').toBeGreaterThan(0);
		expect(result.additionalVisible, 'Additional server message visibility').toBe(additionalExpected);
		for (const text of result.text) {
			expect(text.top, 'Text above alert content box').toBeGreaterThanOrEqual(result.content.top - tolerance);
			expect(text.bottom, 'Text below alert content box').toBeLessThanOrEqual(result.content.bottom + tolerance);
			expect(text.left, 'Text left of alert content box').toBeGreaterThanOrEqual(result.content.left - tolerance);
			expect(text.right, 'Text right of alert content box').toBeLessThanOrEqual(result.content.right + tolerance);
		}
		expect(result.alert.bottom, 'Alert overlaps form').toBeLessThanOrEqual(result.form.top + tolerance);
	}
	const nextTop = result.hidden ? result.form.top : result.alert.top;
	for (const text of result.descText) {
		expect(text.bottom, 'Description overlaps next item').toBeLessThanOrEqual(nextTop + tolerance);
	}
	expect(result.brand.left, 'Brand heading begins outside the login panel').toBeGreaterThanOrEqual(result.root.left - tolerance);
	expect(result.brand.right, 'Brand heading ends outside the login panel').toBeLessThanOrEqual(result.root.right + tolerance);
	expect(result.brand.scrollWidth, 'Brand heading text overflows its box').toBeLessThanOrEqual(result.brand.clientWidth + tolerance);
	for (const text of result.brand.text) {
		expect(text.left, 'Brand heading text begins outside the login panel').toBeGreaterThanOrEqual(result.root.left - tolerance);
		expect(text.right, 'Brand heading text ends outside the login panel').toBeLessThanOrEqual(result.root.right + tolerance);
	}
	if (!enlarged) expect(result.root.scrollWidth, 'Horizontal page overflow').toBeLessThanOrEqual(result.root.clientWidth + tolerance);
	expect(result.alert.width).toBeLessThanOrEqual(result.form.width + tolerance);
}

async function reachable(login) {
	const page = login.page;
	await page.locator('#V-Login').evaluate(element => { element.scrollTop = 0; });
	await login.settle();
	const start = await page.locator('#V-Login .login-brand').boundingBox();
	expect(start.y, 'First item must be scroll-reachable').toBeGreaterThanOrEqual(-1);
	expect(start.y, 'First item below viewport').toBeLessThan(page.viewportSize().height);
	expect(start.y + start.height, 'First item above viewport').toBeGreaterThan(0);
	await page.locator('#V-Login').evaluate(element => { element.scrollTop = element.scrollHeight; });
	await login.settle();
	const end = await page.locator('.login-product-version').boundingBox();
	expect(end.y + end.height, 'Last item must be scroll-reachable').toBeLessThanOrEqual(page.viewportSize().height + 1);
	expect(end.y, 'Last item below viewport').toBeLessThan(page.viewportSize().height);
	expect(end.y + end.height, 'Last item above viewport').toBeGreaterThan(0);
	for (const selector of ['#V-Login button[type=submit]', '.login-footer a']) {
		const items = page.locator(selector);
		for (let i = 0; i < await items.count(); i++) {
			const item = items.nth(i);
			await item.focus();
			await expect(item).toBeFocused();
			await login.settle();
			const box = await item.boundingBox();
			expect(box.y + box.height, 'Focused control above viewport').toBeGreaterThan(0);
			expect(box.y, 'Focused control below viewport').toBeLessThan(page.viewportSize().height);
		}
	}
}

for (const step of ['primary', 'factor']) {
	for (const [name, text] of Object.entries(variants)) {
		test(step + ': ' + name + ' error at narrow widths and short heights', async ({ login }) => {
			await login.open({ step });
			if (name !== 'hidden') await login.fail(step);
			await login.text(text.main, text.additional);
			for (const width of widths) {
				for (const height of heights) {
					await login.page.setViewportSize({ width, height });
					contained(await geometry(login, width + 'x' + height), { additionalExpected: Boolean(text.additional) });
					await reachable(login);
				}
			}
		});
	}
	test(step + ': real error response, close, and retry', async ({ login }, testInfo) => {
		await login.page.setViewportSize({ width: 375, height: 480 });
		await login.open({ step });
		await login.fail(step);
		await expect(login.page.locator('#V-Login > .alert p')).toContainText('Authentication failed.');
		contained(await geometry(login, 'real-response'));
		await login.page.locator('#V-Login').evaluate(element => { element.scrollTop = 0; });
		const screenshot = testInfo.outputPath('login-error.png');
		await login.page.screenshot({ path: screenshot });
		await testInfo.attach('login-error', { path: screenshot, contentType: 'image/png' });
		expect(login.actions).toEqual(step === 'factor'
			? ['TwoFactorLoginBegin', 'TwoFactorLoginVerify'] : ['TwoFactorLoginBegin']);
		await login.page.locator('#V-Login > .alert .close').click();
		await expect(login.page.locator('#V-Login > .alert')).toBeHidden();
		contained(await geometry(login, 'closed'));
		await login.fail(step);
		contained(await geometry(login, 'retry'));
		await reachable(login);
	});
}

for (const language of ['en', 'de', 'ar']) {
	for (const step of ['primary', 'factor']) {
		test(language + ': ' + step + ' enlarged text and localized server errors', async ({ login }) => {
			await login.open({ language, step });
			await login.fail(step);
			await expect(login.page.locator('html')).toHaveAttribute('dir', language === 'ar' ? 'rtl' : 'ltr');
			for (const fontSize of [16, 20, 32]) {
				await login.page.evaluate(size => { document.documentElement.style.fontSize = size + 'px'; }, fontSize);
				for (const width of widths) {
					await login.page.setViewportSize({ width, height: 320 });
					contained(await geometry(login, language + ':' + width + ':font-' + fontSize), { enlarged: fontSize > 16 });
					await reachable(login);
				}
			}
		});
	}
}

test('tablet, desktop and landscape retain centered or scrollable content', async ({ login }) => {
	await login.open();
	await login.fail('primary');
	for (const viewport of [
		{ width: 768, height: 1024 }, { width: 1440, height: 900 },
		{ width: 844, height: 390 }, { width: 667, height: 320 }
	]) {
		await login.page.setViewportSize(viewport);
		contained(await geometry(login, 'wide:' + viewport.width + 'x' + viewport.height));
		await reachable(login);
	}
});

test('admin login retains the shared absolute alert layout', async ({ login }) => {
	await login.open({ admin: true });
	await login.page.locator('#V-AdminLogin input[name=Login]').fill('synthetic-admin');
	await login.page.locator('#V-AdminLogin input[name=Password]').fill('synthetic-layout-password');
	await login.page.locator('#V-AdminLogin button').click();
	await expect(login.page.locator('#V-AdminLogin .alert')).toHaveText(/.+/);
	await login.settle();
	const metrics = await login.page.locator('#V-AdminLogin').evaluate(root => {
		const style = getComputedStyle(root.querySelector('.alert'));
		return { display: getComputedStyle(root).display, position: style.position,
			flexShrink: style.flexShrink, overflowWrap: style.overflowWrap };
	});
	expect(metrics).toEqual({ display: 'block', position: 'absolute', flexShrink: '1', overflowWrap: 'normal' });
});

test.describe('normal motion', () => {
	test.use({ reducedMotion: 'no-preference' });
	test('2FA failure settles without overlap or changing focus', async ({ login }) => {
		await login.page.setViewportSize({ width: 320, height: 480 });
		await login.open({ step: 'factor' });
		await login.fail('factor');
		contained(await geometry(login, 'normal-motion'));
		await expect(login.page.locator('#login-factor-code')).toBeFocused();
		await login.page.keyboard.press('Tab');
		await expect(login.page.locator('#V-Login button[type=submit]')).toBeFocused();
	});
});
