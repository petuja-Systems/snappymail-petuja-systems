import { test, expect } from './authenticated-ui-fixture.mjs';
import { indexFixture } from './login-fixture.mjs';

test.use({ trace: 'off', screenshot: 'off' });

const origin = 'http://127.0.0.1:8791';
const imageOrigin = 'https://images.example.test';
const cspNonce = 'c3ludGhldGljLXJlY2VpdmVkLW1lc3NhZ2UtY3Nw';
const messageViewCsp = [
	"base-uri 'self'",
	"default-src 'self' data:",
	"script-src 'self' 'unsafe-eval' 'nonce-" + cspNonce + "'",
	"img-src 'self' data: https: http:",
	"media-src 'self' data:",
	"style-src 'self' 'unsafe-inline'",
	"connect-src 'self' data: keys.openpgp.org"
].join('; ');
const imagePath = '/synthetic/remote-image.png';
const messageHash = 'synthetic-message-42';
const subject = 'Synthetic received message';
const senderName = 'Rae Example';
const attachmentName = 'forwarded-message.eml';
const safeLinks = [
	'<a id="safe-http" href="http://safe.example.test/path">HTTP link</a>',
	'<a id="safe-https" href="https://safe.example.test/path">HTTPS link</a>',
	'<a id="safe-mailto" href="mailto:help@example.test">Mail link</a>',
	'<a id="safe-tel" href="tel:+15550100">Phone link</a>',
	'<a id="safe-relative" href="/synthetic-safe-path">Relative link</a>',
	'<a id="safe-fragment" href="' + origin + '/#synthetic-fragment">Fragment link</a>',
	'<a id="no-href-link">Plain anchor text</a>',
	'<a id="safe-tracked-link" href="https://safelinks.protection.outlook.com/?url=https%3A%2F%2Fsafe.example.test%2Ftracked">Safe tracked link</a>',
	'<a id="unsafe-scheme-tracked-link" href="javascript:safelinks.protection.outlook.com/?url=https%3A%2F%2Fevil.example.test%2Fpage">Unsafe SafeLinks wrapper link</a>',
	'<a id="unsafe-scheme-normalized-link" href="  JaVaScRiPt:safelinks.protection.outlook.com/?url=https%3A%2F%2Fevil.example.test%2Fpage">Unsafe normalized wrapper link</a>',
	'<a id="unsafe-scheme-copernica-link" data-x-href-tracking="javascript:alert(2)" href="javascript:wrapper.example/https%253A%252F%252Fevil.example.test%252Fpage">Unsafe Copernica wrapper link</a>'
].join('');
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64');
const startupActions = new Set([
	'Folders', 'AccountsAndIdentities', 'SMimeGetCertificates', 'SettingsUpdate', 'FolderInformation',
	'FolderInformationMultiply', 'SystemFoldersUpdate', 'AppDelayStart', 'TwoFactorState'
]);
const allowedActions = new Set([...startupActions, 'MessageList', 'Message']);
const linkWithText = (container, text) => container.locator('a').filter({
	hasText: new RegExp('^' + text + '$')
});

const receivedMessage = {
	'@Object': 'Object/Message',
	folder: 'INBOX',
	uid: 42,
	hash: messageHash,
	subject,
	from: [{ '@Object': 'Object/Email', name: senderName, email: 'rae@example.test', dkimStatus: 'none' }],
	to: [{ '@Object': 'Object/Email', name: '', email: 'demo@example.test', dkimStatus: 'none' }],
	cc: [], bcc: [], sender: [], replyTo: [], deliveredTo: [],
	flags: ['\\seen'],
	dateTimestamp: 1792440000,
	dateTimestampSource: 'header',
	messageId: '<synthetic-42@example.test>',
	preview: 'Safe synthetic body',
	size: 512,
	plain: 'Safe synthetic body',
	html: [
		'<p>Safe <strong>message body</strong>.</p>',
		'<script>window.__receivedMessageHtmlExecuted = true</script>',
		'<iframe src="https://frame.example.test/">untrusted frame</iframe>',
		'<p onclick="window.__receivedMessageHandlerExecuted = true">Handler must be removed.</p>',
		'<a id="unsafe-link" href="javascript:window.__receivedMessageLinkExecuted = true">Unsafe link</a>',
		'<a id="tracked-unsafe-link" href="https://safelinks.protection.outlook.com/?url=javascript%3Aalert%281%29">Unsafe tracked link</a>',
		safeLinks,
		'<img id="remote-image" src="' + imageOrigin + imagePath + '"',
		'srcset="' + imageOrigin + '/synthetic/retina.png 2x" sizes="100vw"',
		'onerror="window.__receivedMessageImageHandlerExecuted = true" alt="Remote image">'
	].join(''),
	attachments: [{
		'@Object': 'Object/Attachment', folder: 'INBOX', uid: 42,
		mimeIndex: '2', mimeType: 'message/rfc822', fileName: attachmentName,
		estimatedSize: 384, cId: '', contentLocation: '', isInline: false
	}],
	spf: [], dkim: [], dmarc: []
};

const messageList = {
	'@Object': 'Collection/MessageCollection',
	'@Collection': [receivedMessage],
	totalEmails: 1, totalThreads: null, threadUid: 0, newMessages: [],
	offset: 0, limit: 25, search: '', sort: '', limited: false,
	folder: { name: 'INBOX', uidNext: 43, uidValidity: 1, totalEmails: 1, unreadEmails: 0, etag: 'synthetic-inbox' }
};

const secondMessage = {
	...receivedMessage,
	uid: 43,
	hash: 'synthetic-message-43',
	subject: 'Synthetic next message',
	messageId: '<synthetic-43@example.test>',
	plain: 'Safe synthetic next-message body',
	html: '<p>Safe synthetic next-message body.</p>',
	attachments: []
};

const nestedMime = [
	'From: Nested Sender <nested@example.test>',
	'To: Demo User <demo@example.test>',
	'Subject: Nested synthetic message',
	'MIME-Version: 1.0',
	'Content-Type: multipart/alternative; boundary="synthetic-boundary"',
	'',
	'--synthetic-boundary',
	'Content-Type: text/plain; charset=utf-8',
	'Content-Transfer-Encoding: 7bit',
	'',
	'Nested plain body.',
	'--synthetic-boundary',
	'Content-Type: text/html; charset=utf-8',
	'Content-Transfer-Encoding: 7bit',
	'',
	'<p>Nested <strong>safe body</strong>.</p>',
	'<script>window.__nestedMessageHtmlExecuted = true</script>',
	'<img src="' + imageOrigin + '/synthetic/nested-image.png" srcset="' + imageOrigin + '/synthetic/nested-retina.png 2x" sizes="100vw" onerror="window.__nestedMessageHandlerExecuted = true">',
	'<a href="javascript:window.__nestedMessageLinkExecuted = true">Nested unsafe link</a>',
	'<a id="nested-tracked-unsafe-link" href="https://safelinks.protection.outlook.com/?url=javascript%3Aalert%281%29">Nested unsafe tracked link</a>',
	safeLinks,
	'--synthetic-boundary--',
	''
].join('\r\n');

const apiResponse = (Action, Result) => ({ Action, Result });

async function installMessageRoutes(page, state) {
	await page.route('**/*', async route => {
		const request = route.request(), url = new URL(request.url());

		if (url.origin === imageOrigin) {
			state.externalImagePaths.push(url.pathname);
			if ('GET' === request.method() && [imagePath, '/synthetic/nested-image.png'].includes(url.pathname)) {
				return route.fulfill({ contentType: 'image/png', body: pixel });
			}
			state.unexpectedExternalRequests.push(url.origin);
			return route.abort();
		}

		if (url.origin === origin && '/' === url.pathname && !url.search) {
			const html = await indexFixture('en', false);
			return route.fulfill({
				contentType: 'text/html; charset=utf-8',
				headers: { 'Content-Security-Policy': messageViewCsp },
				body: html.replace(/nonce=""/g, 'nonce="' + cspNonce + '"')
			});
		}

		if (url.origin === origin && '/' === url.pathname && url.search.startsWith('?/Json')) {
			let action = '';
			if ('POST' === request.method()) {
				try { action = request.postDataJSON()?.Action || ''; } catch {}
			} else if (url.search.includes('/MessageList/')) {
				action = 'MessageList';
			} else if (url.search.includes('/Message/')) {
				action = 'Message';
			}
			if ('MessageList' === action) {
				state.actions.push(action);
				return route.fulfill({ json: apiResponse(action, state.messageList || messageList) });
			}
			if ('Message' === action) {
				state.actions.push(action);
				let requestedUid = 0;
				try {
					const encoded = url.search.slice(url.search.lastIndexOf('/') + 1).split('?')[0],
						decoded = encoded.replace(/-/g, '+').replace(/_/g, '/');
					requestedUid = JSON.parse(Buffer.from(decoded, 'base64').toString('utf8'))[1];
				} catch {}
				const message = state.messages?.find(item => item.uid === requestedUid) || receivedMessage;
				if (message.uid === state.deferMessageUid) {
					await state.messageBodyGate;
				}
				return route.fulfill({ json: apiResponse(action, message) });
			}
			if (!startupActions.has(action)) {
				state.unexpectedActions.push(action || 'unparseable');
				return route.abort();
			}
		}

		if (url.origin === origin && '/' === url.pathname
			&& 'GET' === request.method()
			&& url.search.startsWith('?/Raw/') && url.search.includes('/Download/')) {
			state.rawDownloads++;
			return route.fulfill({ contentType: 'text/plain; charset=utf-8', body: nestedMime });
		}

		return route.fallback();
	});
}

test('received message view sanitizes HTML, gates external images, and parses nested RFC822 safely', async ({ authenticated }) => {
	const { page } = authenticated;
	const state = {
		actions: [], unexpectedActions: [],
		externalImagePaths: [], unexpectedExternalRequests: [], rawDownloads: 0
	};
	await authenticated.open();
	await page.evaluate(() => {
		const clientSettings = JSON.parse(localStorage.getItem('rlcsc') || '{}');
		clientSettings.p10 = true; // ClientSideKeyNameMessageAttachmentControls
		localStorage.setItem('rlcsc', JSON.stringify(clientSettings));
	});
	await installMessageRoutes(page, state);

	// Reload after installing the narrow overrides so the real app boot flow receives the synthetic mailbox.
	const response = await page.reload();
	const scriptPolicy = response.headers()['content-security-policy'].split('; ')
		.find(directive => directive.startsWith('script-src '));
	expect(scriptPolicy).toBe("script-src 'self' 'unsafe-eval' 'nonce-" + cspNonce + "'");
	await expect(page.locator('.messageListItem')).toHaveCount(1);
	await page.locator('.messageListItem').click();

	const messageBody = page.locator('#rl-msg-' + messageHash);
	await expect(messageBody).toBeVisible();
	await expect(page.locator('#V-MailMessageView .messageItemHeader .subject')).toHaveText(subject);
	await expect(page.locator('#V-MailMessageView .messageItemHeader .from')).toContainText(senderName);
	await expect(page.locator('.attachmentName').filter({ hasText: attachmentName })).toHaveText(attachmentName);
	await expect(page.locator('.attachmentsPlace .checkboxAttachment')).toHaveAccessibleName(attachmentName);
	await expect(messageBody.locator('p strong')).toHaveText('message body');
	await expect(messageBody.locator('script, iframe')).toHaveCount(0);
	await expect(messageBody.locator('[onclick], [onerror]')).toHaveCount(0);
	const unsafeLink = linkWithText(messageBody, 'Unsafe link');
	const trackedUnsafeLink = linkWithText(messageBody, 'Unsafe tracked link');
	await expect(unsafeLink).not.toHaveAttribute('href');
	await expect(unsafeLink).toHaveText('Unsafe link');
	await expect(trackedUnsafeLink).not.toHaveAttribute('href');
	await expect(trackedUnsafeLink).not.toHaveAttribute('data-x-href-tracking');
	await expect(trackedUnsafeLink).toHaveText('Unsafe tracked link');
	await expect(linkWithText(messageBody, 'HTTP link')).toHaveAttribute('href', 'http://safe.example.test/path');
	await expect(linkWithText(messageBody, 'HTTPS link')).toHaveAttribute('href', 'https://safe.example.test/path');
	await expect(linkWithText(messageBody, 'Mail link')).toHaveAttribute('href', 'mailto:help@example.test');
	await expect(linkWithText(messageBody, 'Phone link')).toHaveAttribute('href', 'tel:+15550100');
	await expect(linkWithText(messageBody, 'Relative link')).toHaveAttribute('href', origin + '/synthetic-safe-path');
	await expect(linkWithText(messageBody, 'Fragment link')).toHaveAttribute('href', origin + '/#synthetic-fragment');
	await expect(linkWithText(messageBody, 'Plain anchor text')).not.toHaveAttribute('href');
	const safeTrackedLink = linkWithText(messageBody, 'Safe tracked link');
	const unsafeSafeLinksWrapper = linkWithText(messageBody, 'Unsafe SafeLinks wrapper link');
	const unsafeNormalizedWrapper = linkWithText(messageBody, 'Unsafe normalized wrapper link');
	const unsafeCopernicaWrapper = linkWithText(messageBody, 'Unsafe Copernica wrapper link');
	await expect(safeTrackedLink).toHaveAttribute('href', 'https://safe.example.test/tracked');
	await expect(safeTrackedLink).toHaveAttribute('data-x-href-tracking', 'https://safelinks.protection.outlook.com/?url=https%3A%2F%2Fsafe.example.test%2Ftracked');
	await expect(unsafeSafeLinksWrapper).not.toHaveAttribute('href');
	await expect(unsafeSafeLinksWrapper).not.toHaveAttribute('data-x-href-tracking');
	await expect(unsafeNormalizedWrapper).not.toHaveAttribute('href');
	await expect(unsafeNormalizedWrapper).not.toHaveAttribute('data-x-href-tracking');
	await expect(unsafeCopernicaWrapper).not.toHaveAttribute('href');
	await expect(unsafeCopernicaWrapper).not.toHaveAttribute('data-x-href-tracking');
	const remoteImage = messageBody.locator('img[alt="Remote image"]');
	await expect(remoteImage).not.toHaveAttribute('srcset');
	await expect(remoteImage).not.toHaveAttribute('sizes');
	await expect(remoteImage).not.toHaveAttribute('src');
	await expect(remoteImage).toHaveAttribute('data-x-src', imageOrigin + imagePath);
	const showImagesButton = page.getByRole('button', { name: 'Display external images', exact: true });
	await expect(showImagesButton).toBeVisible();
	await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
	expect(state.externalImagePaths).toEqual([]);
	expect(state.unexpectedExternalRequests).toEqual([]);

	await showImagesButton.click();
	await expect.poll(() => state.externalImagePaths).toEqual([imagePath]);
	await expect(remoteImage).toHaveAttribute('src', imageOrigin + imagePath);
	await page.locator('button[data-bind*="showTracking"]').click();
	await expect(safeTrackedLink).toHaveAttribute('href', 'https://safelinks.protection.outlook.com/?url=https%3A%2F%2Fsafe.example.test%2Ftracked');
	await expect(unsafeSafeLinksWrapper).not.toHaveAttribute('href');
	await expect(unsafeSafeLinksWrapper).not.toHaveAttribute('data-x-href-tracking');
	await expect(unsafeNormalizedWrapper).not.toHaveAttribute('href');
	await expect(unsafeNormalizedWrapper).not.toHaveAttribute('data-x-href-tracking');
	await expect(unsafeCopernicaWrapper).not.toHaveAttribute('href');
	await expect(unsafeCopernicaWrapper).not.toHaveAttribute('data-x-href-tracking');
	expect(await page.evaluate(() => ({
		script: window.__receivedMessageHtmlExecuted,
		handler: window.__receivedMessageHandlerExecuted,
		link: window.__receivedMessageLinkExecuted
	}))).toEqual({ script: undefined, handler: undefined, link: undefined });

	const popupPromise = page.waitForEvent('popup');
	const attachmentIcon = page.locator('.attachmentsPlace .attachmentIcon');
	await expect(attachmentIcon).toBeVisible();
	await attachmentIcon.click();
	const popup = await popupPromise;
	await expect(popup.locator('header h1')).toHaveText('Nested synthetic message');
	await expect(popup.locator('header')).toContainText('Nested Sender');
	await expect(popup.locator('body script, body iframe')).toHaveCount(0);
	await expect(popup.locator('body strong')).toHaveText('safe body');
	await expect(popup.locator('body img')).toHaveCount(1);
	await expect(popup.locator('body img')).not.toHaveAttribute('srcset');
	await expect(popup.locator('body img')).not.toHaveAttribute('sizes');
	await expect(popup.locator('body img')).not.toHaveAttribute('src');
	const nestedUnsafeLink = linkWithText(popup.locator('body'), 'Nested unsafe link');
	const nestedTrackedUnsafeLink = linkWithText(popup.locator('body'), 'Nested unsafe tracked link');
	await expect(nestedUnsafeLink).not.toHaveAttribute('href');
	await expect(nestedUnsafeLink).toHaveText('Nested unsafe link');
	await expect(nestedTrackedUnsafeLink).not.toHaveAttribute('href');
	await expect(nestedTrackedUnsafeLink).not.toHaveAttribute('data-x-href-tracking');
	await expect(nestedTrackedUnsafeLink).toHaveText('Nested unsafe tracked link');
	await expect(linkWithText(popup.locator('body'), 'HTTP link')).toHaveAttribute('href', 'http://safe.example.test/path');
	await expect(linkWithText(popup.locator('body'), 'HTTPS link')).toHaveAttribute('href', 'https://safe.example.test/path');
	await expect(linkWithText(popup.locator('body'), 'Mail link')).toHaveAttribute('href', 'mailto:help@example.test');
	await expect(linkWithText(popup.locator('body'), 'Phone link')).toHaveAttribute('href', 'tel:+15550100');
	await expect(linkWithText(popup.locator('body'), 'Relative link')).toHaveAttribute('href', origin + '/synthetic-safe-path');
	await expect(linkWithText(popup.locator('body'), 'Fragment link')).toHaveAttribute('href', origin + '/#synthetic-fragment');
	await expect(linkWithText(popup.locator('body'), 'Plain anchor text')).not.toHaveAttribute('href');
	const nestedSafeTrackedLink = linkWithText(popup.locator('body'), 'Safe tracked link');
	await expect(nestedSafeTrackedLink).toHaveAttribute('href', 'https://safe.example.test/tracked');
	await expect(nestedSafeTrackedLink).toHaveAttribute('data-x-href-tracking', 'https://safelinks.protection.outlook.com/?url=https%3A%2F%2Fsafe.example.test%2Ftracked');
	const nestedUnsafeSafeLinksWrapper = linkWithText(popup.locator('body'), 'Unsafe SafeLinks wrapper link');
	const nestedUnsafeNormalizedWrapper = linkWithText(popup.locator('body'), 'Unsafe normalized wrapper link');
	const nestedUnsafeCopernicaWrapper = linkWithText(popup.locator('body'), 'Unsafe Copernica wrapper link');
	await expect(nestedUnsafeSafeLinksWrapper).not.toHaveAttribute('href');
	await expect(nestedUnsafeSafeLinksWrapper).not.toHaveAttribute('data-x-href-tracking');
	await expect(nestedUnsafeNormalizedWrapper).not.toHaveAttribute('href');
	await expect(nestedUnsafeNormalizedWrapper).not.toHaveAttribute('data-x-href-tracking');
	await expect(nestedUnsafeCopernicaWrapper).not.toHaveAttribute('href');
	await expect(nestedUnsafeCopernicaWrapper).not.toHaveAttribute('data-x-href-tracking');
	expect(state.rawDownloads).toBe(1);
	expect(state.externalImagePaths).toEqual([imagePath]);
	expect(state.unexpectedExternalRequests).toEqual([]);
	expect(await popup.evaluate(() => ({
		script: window.__nestedMessageHtmlExecuted,
		handler: window.__nestedMessageHandlerExecuted,
		link: window.__nestedMessageLinkExecuted
	}))).toEqual({ script: undefined, handler: undefined, link: undefined });
	await popup.close();

	expect(state.actions).toEqual(['MessageList', 'Message']);
	expect(state.unexpectedActions).toEqual([]);
	expect(authenticated.actions.every(action => allowedActions.has(action))).toBe(true);
});

test('message-view toolbar actions follow the selected message without shifting the pane', async ({ authenticated }) => {
	const { page } = authenticated;
	await authenticated.open();
	await page.setViewportSize({ width: 1600, height: 900 });
	let releaseMessageBody;
	const state = {
		actions: [], unexpectedActions: [],
		externalImagePaths: [], unexpectedExternalRequests: [], rawDownloads: 0,
		messageList: {
			...messageList,
			'@Collection': [receivedMessage, secondMessage],
			totalEmails: 2,
			folder: { ...messageList.folder, uidNext: 44, totalEmails: 2 }
		},
		messages: [receivedMessage, secondMessage],
		deferMessageUid: secondMessage.uid,
		messageBodyGate: new Promise(resolve => { releaseMessageBody = resolve; })
	};
	await installMessageRoutes(page, state);
	await page.reload();
	try {
		await expect(page.locator('.messageListItem')).toHaveCount(2);
		await page.locator('html').evaluate(root => {
			root.classList.remove('sm-msgView-bottom', 'rl-fullscreen');
			root.classList.add('sm-msgView-side');
		});

		const viewer = page.locator('#V-MailMessageView'),
			toolbar = viewer.locator('.top-toolbar'),
			groups = toolbar.locator('.message-view-toolbar-actions'),
			close = toolbar.locator('.buttonClose'),
			messageView = viewer.locator('.messageView');
		await expect(page.locator('#rl-right')).not.toHaveClass(/message-selected/);
		await expect(viewer).toBeVisible();
		await expect(groups).toHaveCount(4);
		for (let i = 0; i < 4; i++) {
			await expect(groups.nth(i)).toHaveCSS('display', 'none');
		}
		await expect(toolbar).toHaveCSS('min-height', '50px');
		const emptyGeometry = await page.evaluate(() => {
			const toolbar = document.querySelector('#V-MailMessageView .top-toolbar'),
				messageView = document.querySelector('#V-MailMessageView .messageView');
			return { toolbarHeight: toolbar.getBoundingClientRect().height, messageTop: messageView.getBoundingClientRect().top, messageHeight: messageView.getBoundingClientRect().height };
		});
		expect(emptyGeometry.toolbarHeight).toBeCloseTo(50, 0);

		await page.locator('.messageListItem').nth(0).click();
		await expect(close).toBeVisible();
		await expect(viewer.locator('.messageItemHeader .subject')).toHaveText(subject);
		await expect(toolbar.locator('.buttonUp')).toBeVisible();
		await expect(toolbar.locator('.buttonDown')).toBeVisible();
		await expect(toolbar.locator('button[data-ui-icon="trash-2"]')).toBeVisible();
		await expect(toolbar.locator('.buttonEdit')).toBeHidden();
		const selectedGeometry = await page.evaluate(() => {
			const toolbar = document.querySelector('#V-MailMessageView .top-toolbar'),
				messageView = document.querySelector('#V-MailMessageView .messageView');
			return { toolbarHeight: toolbar.getBoundingClientRect().height, messageTop: messageView.getBoundingClientRect().top, messageHeight: messageView.getBoundingClientRect().height };
		});
		expect(selectedGeometry.toolbarHeight).toBeCloseTo(emptyGeometry.toolbarHeight, 0);
		expect(selectedGeometry.messageTop).toBeCloseTo(emptyGeometry.messageTop, 0);
		expect(selectedGeometry.messageHeight).toBeCloseTo(emptyGeometry.messageHeight, 0);

		await toolbar.locator('.buttonDown').click();
		await expect.poll(() => state.actions.filter(action => 'Message' === action).length).toBe(2);
		await expect(page.locator('#rl-right')).toHaveClass(/message-selected/);
		await expect(close).toBeVisible();
		const loadingGeometry = await page.evaluate(() => document.querySelector('#V-MailMessageView .top-toolbar').getBoundingClientRect().height);
		expect(loadingGeometry).toBeCloseTo(emptyGeometry.toolbarHeight, 0);
		releaseMessageBody();
		await expect(viewer.locator('.messageItemHeader .subject')).toHaveText(secondMessage.subject);
		await toolbar.locator('.buttonUp').click();
		await expect(viewer.locator('.messageItemHeader .subject')).toHaveText(subject);
		await expect(close).toBeVisible();

		await close.focus();
		await expect(close).toBeFocused();
		await close.click();
		for (let i = 0; i < 4; i++) {
			await expect(groups.nth(i)).toHaveCSS('display', 'none');
		}
		await expect(page.locator('#V-MailMessageList .b-content')).toBeFocused();
		await expect(toolbar).toHaveCSS('min-height', '50px');
		expect((await toolbar.boundingBox()).height).toBeCloseTo(50, 0);

		await page.setViewportSize({ width: 1400, height: 900 });
		await expect(toolbar).toHaveCSS('visibility', 'hidden');
		await expect(toolbar).toHaveCSS('min-height', '50px');
	} finally {
		releaseMessageBody();
	}

	expect(state.unexpectedActions).toEqual([]);
	expect(state.unexpectedExternalRequests).toEqual([]);
});
