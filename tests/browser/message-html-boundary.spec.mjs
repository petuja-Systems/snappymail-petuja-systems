import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { popupResult, showImagesMethod, signatureMethod, senderFormatterSource } from '../fixtures/message-html-boundary.mjs';

const origin = 'http://127.0.0.1:8787';
const imageOrigin = 'http://127.0.0.1:8788';
const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=';
const dataImage = 'data:image/png;base64,' + pixel;
const encoding = await readFile(new URL('../../dev/Common/HtmlEncoding.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../../dev/Common/Html.js', import.meta.url), 'utf8');
const dataModule = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
const sanitizerModule = dataModule([
	'import { encodeHtml } from ' + JSON.stringify(dataModule(encoding)) + ';',
	'export const fixtureState = { proxy: true, whitelist: "", allowStyles: false, removeColors: false };',
	'const tpl = document.createElement("template"), ComposeType = { Draft: "draft", EditAsNew: "edit" }; let oLastMessage;',
	'const Date = class { format(options) { return typeof options === "object" ? "synthetic date" : "synthetic time"; } };',
	'const emailArrayToStringLineHelper = ' + senderFormatterSource + ';',
	'const signatureFunction = ({' + signatureMethod + '}).setSignature;',
	'export function fixtureSignature(template, sender, insertBefore = false) { oLastMessage = { from: [{ email: "synthetic@example.test", toLine: () => sender }] }; let result; signatureFunction.call({ editor: callback => callback({ setSignature: (value, html, before) => { result = { value, html, before }; } }) }, { signature: () => template, signatureInsertBefore: () => insertBefore }, "reply"); return result; }',
	'const createElement = (name, attrs = {}) => { const node = document.createElement(name); Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value)); return node; };',
	'const forEachObjectEntry = (value, callback) => Object.entries(value).forEach(([key, item]) => callback(key, item));',
	'const isArray = Array.isArray, pInt = value => parseInt(value, 10) || 0;',
	'const SettingsUserStore = { maxBlockquotesLevel: () => 5, allowStyles: () => fixtureState.allowStyles, removeColors: () => fixtureState.removeColors, collapseBlockquotes: () => false, viewImagesWhitelist: () => fixtureState.whitelist };',
	'const SettingsGet = key => key === "proxyExternalImages" && fixtureState.proxy;',
	'const proxy = source => ' + JSON.stringify(origin + '/proxy?source=') + ' + encodeURIComponent(source);',
	// Markdown is not exercised. Every node, attribute and style uses the real browser DOM.
	'const TurndownService = class {}, rl = {};',
	html.replace(/^import[^\n]+\n/gm, '').replace(/^export \{ encodeHtml \};\n/m, ''),
	'export const fixtureShowImages = ({' + showImagesMethod + '}).showExternalImages;'
].join('\n'));

async function localPage(page) {
	const imageRequests = [], foreignRequests = [];
	await page.route('**/*', route => {
		const url = new URL(route.request().url());
		if (url.origin === origin && url.pathname === '/m77-fixture') {
			return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><title>M7.7 local HTML boundary fixture</title></head><body><main id="message"></main><button id="show-images">Show images</button></body></html>' });
		}
		if ((url.origin === imageOrigin && url.pathname.startsWith('/fixture-image/'))
			|| (url.origin === origin && url.pathname === '/proxy')) {
			imageRequests.push(url.href);
			return route.fulfill({ contentType: 'image/png', body: Buffer.from(pixel, 'base64') });
		}
		foreignRequests.push(url.href);
		return route.abort();
	});
	await page.goto(origin + '/m77-fixture');
	await expect(page).toHaveTitle('M7.7 local HTML boundary fixture');
	expect(page.url()).toBe(origin + '/m77-fixture');
	await page.evaluate(async uri => { window.m77 = await import(uri); }, sanitizerModule);
	return { imageRequests, foreignRequests };
}

async function setMessage(page, value, message = true, useProxy = true) {
	return page.evaluate(({ value, message, useProxy, dataImage }) => {
		window.m77.fixtureState.proxy = useProxy;
		window.m77.fixtureState.whitelist = '';
		const attachments = { findByCid: cid => cid === 'known' ? {
			download: 'synthetic', linkPreview: () => dataImage, fileName: 'local.png',
			isInline: () => {}, isLinked: () => {}
		} : undefined };
		const result = window.m77.cleanHtml(value, attachments, message ? '#local-message' : undefined);
		const body = document.querySelector('#message');
		body.innerHTML = message ? result.html : '';
		let hasImages = result.hasExternals;
		window.m77Message = {
			body, from: [{ email: 'sender@example.test' }], spf: [], dkim: [], dmarc: [],
			hasImages: value => value === undefined ? hasImages : (hasImages = value)
		};
		document.querySelector('#show-images').onclick = () => window.m77.fixtureShowImages.call(window.m77Message);
		return result;
	}, { value, message, useProxy, dataImage });
}

test('M7.7 sender and nested attachment strings remain literal text in the real DOM', async ({ page }) => {
	const { imageRequests, foreignRequests } = await localPage(page);
	const sender = 'Local <em>Sender</em> & "Name"';
	const signature = await page.evaluate(sender => window.m77.fixtureSignature(':HTML:<p>Hello <strong>{{FROM-FULL}}</strong><br>{{FROM}}</p>', sender, true), sender);
	expect(signature.html).toBe(true);
	expect(signature.before).toBe(true);
	await page.locator('#message').evaluate((node, value) => { node.innerHTML = value; }, signature.value);
	await expect(page.locator('#message strong')).toHaveText(sender);
	await expect(page.locator('#message em')).toHaveCount(0);
	await expect(page.locator('#message br')).toHaveCount(1);
	const bare = await page.evaluate(() => window.m77.fixtureSignature(':HTML:<p id="full">{{FROM-FULL}}</p><p id="short">{{FROM}}</p>', 'robot@example.test'));
	await page.locator('#message').evaluate((node, value) => { node.innerHTML = value; }, bare.value);
	await expect(page.locator('#full')).toHaveText('robot@example.test');
	await expect(page.locator('#short')).toHaveText('robot');
	const literal = 'Local $& $1 ' + String.fromCharCode(36, 96) + " $' $$ {{FROM}} {{DATE}} {{TIME}} {{MOMENT:LL}}";
	const literalSignature = await page.evaluate(sender => window.m77.fixtureSignature(':HTML:<p>{{DATE}} / {{FROM-FULL}}</p>', sender), literal);
	await page.locator('#message').evaluate((node, value) => { node.innerHTML = value; }, literalSignature.value);
	await expect(page.locator('#message p')).toHaveText('synthetic date / ' + literal);
	const selected = imageOrigin + '/fixture-image/sender-name.png';
	const attributeSignature = await page.evaluate(sender => window.m77.fixtureSignature(':HTML:<p>{{FROM}}</p><a href="{{FROM-FULL}}" title="{{FROM}}">Contact</a><img src="{{FROM}}" srcset="{{FROM-FULL}} 2x"><style>/* {{FROM}} */</style>', sender), selected);
	await page.locator('#message').evaluate((node, value) => { node.innerHTML = value; }, attributeSignature.value);
	await expect(page.locator('#message p')).toHaveText(selected);
	await expect(page.locator('#message a')).not.toHaveAttribute('href');
	await expect(page.locator('#message a')).not.toHaveAttribute('title');
	await expect(page.locator('#message img')).not.toHaveAttribute('src');
	await expect(page.locator('#message img')).not.toHaveAttribute('srcset');
	await expect(page.locator('#message style')).toHaveJSProperty('textContent', '/* {{FROM}} */');
	await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
	expect(imageRequests).toEqual([]);
	// These parents serialize text literally; sender values must never be inserted there.
	for (const tag of ['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext', 'noscript']) {
		const raw = await page.evaluate(({ tag, sender }) => window.m77.fixtureSignature(':HTML:<' + tag + '>{{FROM}}</' + tag + '>', sender), { tag, sender: selected });
		expect(raw.value).toContain('{{FROM}}');
		expect(raw.value).not.toContain(selected);
	}
	const name = 'Local <b>Invoice & receipt</b> "copy".txt';
	const url = 'data:text/plain;name="local";base64,SGVsbG8=';
	await page.setContent(popupResult(name, url).html);
	await expect(page.locator('#attachments a')).toHaveText(name);
	await expect(page.locator('#attachments a')).toHaveAttribute('href', url);
	await expect(page.locator('#attachments b')).toHaveCount(0);
	expect(imageRequests).toEqual([]);
	expect(foreignRequests).toEqual([]);
});

test('M7.7 received responsive images cannot escape Block, Ask, match or the proxy', async ({ page }) => {
	const { imageRequests, foreignRequests } = await localPage(page);
	const direct = imageOrigin + '/fixture-image/ordinary.png';
	const responsive = imageOrigin + '/fixture-image/responsive.png';
	const result = await setMessage(page, '<img SRCSET="' + responsive + ' 1x, ' + direct + ' 2x" sizes="100vw" alt="Local image">');
	expect(result.hasExternals).toBe(false);
	await expect(page.locator('#message img')).not.toHaveAttribute('srcset');
	await expect(page.locator('#message img')).not.toHaveAttribute('sizes');
	await expect(page.locator('#message img')).not.toHaveAttribute('src');
	await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
	expect(imageRequests).toEqual([]);

	for (const useProxy of [true, false]) {
		const before = imageRequests.length;
		const deferred = await setMessage(page, '<img src="' + direct + '" srcset="' + responsive + ' 2x" sizes="100vw" alt="Local image">', true, useProxy);
		expect(deferred.hasExternals).toBe(true);
		await expect(page.locator('#message img')).not.toHaveAttribute('srcset');
		await expect(page.locator('#message img')).not.toHaveAttribute('sizes');
		await expect(page.locator('#message img')).not.toHaveAttribute('src');
		await expect(page.locator('#message img')).toHaveAttribute('data-x-src', direct);
		// A nonmatching whitelist must leave the source blocked.
		await page.evaluate(() => {
			window.m77.fixtureState.whitelist = 'other@example.test';
			window.m77.fixtureShowImages.call(window.m77Message, 1);
		});
		await expect(page.locator('#message img')).not.toHaveAttribute('src');
		expect(imageRequests.length).toBe(before);
		await page.locator('#show-images').click();
		const expected = useProxy ? origin + '/proxy?source=' + encodeURIComponent(direct) : direct;
		await expect(page.locator('#message img')).toHaveAttribute('src', expected);
		await page.locator('#message img').scrollIntoViewIfNeeded();
		await expect.poll(() => imageRequests.slice(before).includes(expected)).toBe(true);
	}
	expect(imageRequests.some(url => url === responsive)).toBe(false);
	expect(foreignRequests).toEqual([]);
});

test('M7.7 sanitizer preserves ordinary CID/data and editor paste behavior', async ({ page }) => {
	const { imageRequests, foreignRequests } = await localPage(page);
	await setMessage(page, '<img src="cid:known"><img src="cid:missing"><img src="' + dataImage + '">');
	const images = page.locator('#message img');
	await expect(images).toHaveCount(3);
	await expect(images.nth(0)).toHaveAttribute('src', dataImage);
	await expect(images.nth(1)).not.toHaveAttribute('src');
	await expect(images.nth(1)).toHaveAttribute('data-x-src-cid', 'missing');
	await expect(images.nth(2)).toHaveAttribute('src', dataImage);
	await setMessage(page, '<picture><source srcset="' + imageOrigin + '/fixture-image/source.png"><img src="' + dataImage + '"></picture>');
	await expect(page.locator('#message picture, #message source, #message img')).toHaveCount(0);
	const background = imageOrigin + '/fixture-image/background.png';
	const styled = await setMessage(page, '<div style="background-image:url(' + background + ')">Local text</div>');
	expect(styled.hasExternals).toBe(false);
	await expect(page.locator('#message div')).not.toHaveAttribute('data-x-style-url');
	expect(await page.locator('#message div').evaluate(node => node.style.backgroundImage)).toBe('');
	const paste = await setMessage(page, '<img src="' + dataImage + '" srcset="' + dataImage + ' 1x" sizes="100vw">', false);
	expect(paste.html).toContain('srcset=');
	expect(paste.html).toContain('sizes=');
	expect(imageRequests).toEqual([]);
	expect(foreignRequests).toEqual([]);
});

test('M7-F1 removes untrusted CSS resources while retaining inline formatting', async ({ page }) => {
	const { imageRequests, foreignRequests } = await localPage(page);
	const cssImage = imageOrigin + '/fixture-image/css.png';
	for (const allowStyles of [false, true]) {
		await page.evaluate(value => { window.m77.fixtureState.allowStyles = value; }, allowStyles);
		for (const style of [
			'background-image:url("' + cssImage + '")',
			'background:url("' + cssImage + '") navy',
			'background-image:image-set("' + cssImage + '" 1x)',
			'background-image:url("' + dataImage + '"),url("' + cssImage + '")',
			'border-image-source:url("' + cssImage + '")',
			'list-style-image:url("' + cssImage + '")',
			'content:url("' + cssImage + '")',
			'mask-image:url("' + cssImage + '");-webkit-mask-image:url("' + cssImage + '")',
			'background-image:u\\72l("' + cssImage + '")',
			'--local-image:url("' + cssImage + '");background-image:var(--local-image)',
			'background-image:url("cid:known")'
		]) {
			const value = '<style>.local { background-image:url("' + cssImage + '") }</style>'
				+ '<div class="local" width="400" height="30" background="' + cssImage + '" style=\'' + style
				+ ';color:navy;font-size:16px;margin:4px;border:1px solid black\'>Local text</div>';
			const result = await setMessage(page, value);
			expect(result.hasExternals).toBe(false);
			await expect(page.locator('#message style')).toHaveCount(0);
			const node = page.locator('#message div');
			await expect(node).not.toHaveAttribute('class');
			await expect(node).not.toHaveAttribute('background');
			await expect(node).not.toHaveAttribute('data-x-style-url');
			const styles = await node.evaluate(node => ({
				text: node.style.cssText, color: node.style.color, fontSize: node.style.fontSize,
				margin: node.style.margin, borderWidth: node.style.borderTopWidth,
				width: node.style.width, maxWidth: node.style.maxWidth, maxHeight: node.style.maxHeight
			}));
			expect(styles.text).not.toMatch(/url\(|image-set\(|--local-image|mask-image|content:|border-image/i);
			expect(styles.color).toBe('navy');
			expect(styles.fontSize).toBe('16px');
			expect(styles.margin).toBe('4px');
			expect(styles.borderWidth).toBe('1px');
			expect(styles.width).toBe('100%');
			expect(styles.maxWidth).toBe('400px');
			expect(styles.maxHeight).toBe('30px');
			await page.locator('#show-images').click();
		}
	}
	// The shared editor sanitizer removes CSS images too; its IMG contract stays separate.
	const editor = await setMessage(page,
		'<p style="border-image-source:url(' + cssImage + ');color:navy">Editor text</p>', false);
	expect(editor.html).not.toContain('border-image');
	expect(editor.html).toContain('color: navy');
	await page.evaluate(() => { window.m77.fixtureState.removeColors = true; });
	await setMessage(page, '<p style="color:navy;background-color:white;font-weight:bold">Readable text</p>');
	const colors = await page.locator('#message p').evaluate(node => ({
		color: node.style.color, background: node.style.backgroundColor, weight: node.style.fontWeight
	}));
	expect(colors).toEqual({ color: '', background: '', weight: 'bold' });
	await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
	expect(imageRequests).toEqual([]);
	expect(foreignRequests).toEqual([]);
});
