import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, fixtureContact } from './authenticated-ui-fixture.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function openContactsFromAccountMenu(page) {
	await page.locator('#top-system-dropdown-id').click();
	await page.locator('#V-SystemDropDown a[data-bind*="contactsClick"]').click();
}

async function openSettingsNavigation(page) {
	await page.locator('#V-SettingsPane .toggleLeft').click();
	await expect(page.locator('#V-SettingsMenu nav')).toBeVisible();
}

async function closeSettingsNavigation(page) {
	await page.locator('#V-SettingsMenu .toggleLeft').click();
	await expect(page.locator('#V-SettingsMenu nav')).toBeHidden();
}

test('German mailbox and settings titles retain the petuja.email brand', async ({ authenticated }) => {
	const { page } = authenticated;
	await authenticated.open({ language: 'de' });
	await expect(page).toHaveTitle(/^\s*demo@example\.test - Postfach - petuja\.email$/);

	await page.locator('#top-system-dropdown-id').click();
	await page.locator('#V-SystemDropDown a[data-bind*="settingsClick"]').click();
	await expect(page).toHaveTitle('demo@example.test - Einstellungen - petuja.email');
});

test('English mailbox and settings titles retain a configured deployment title', async ({ authenticated }) => {
	const { page } = authenticated;
	await authenticated.open({ language: 'en', title: 'Example deployment' });
	await expect(page).toHaveTitle(/^\s*demo@example\.test - MailBox - Example deployment$/);

	await page.locator('#top-system-dropdown-id').click();
	await page.locator('#V-SystemDropDown a[data-bind*="settingsClick"]').click();
	await expect(page).toHaveTitle('demo@example.test - Settings - Example deployment');
});

test('authenticated mailbox and blank compose controls render at phone width', async ({ authenticated }) => {
	const { page, actions } = authenticated;
	await authenticated.open();
	await authenticated.openFolderNavigation();

	const inbox = page.locator('#V-MailFolderList .b-folders-system a');
	await expect(inbox).toContainText('Inbox');
	await page.locator('#V-MailFolderList .b-footer .toggleLeft').click();
	await expect(page.locator('#V-MailFolderList')).toBeHidden();
	await expect(page.locator('#V-MailMessageList .listEmptyMessage')).toBeVisible();
	const messageList = page.locator('#V-MailMessageList .b-content');
	await messageList.click();
	await expect(messageList).toBeFocused();
	await page.keyboard.press('c');

	const compose = page.locator('#V-PopupsCompose');
	await expect(compose).toBeVisible();
	await expect(compose.locator('input[name="subject"]')).toBeVisible();
	const recipientInput = compose.getByRole('row', { name: 'To' }).getByRole('combobox');
	await expect(recipientInput).toBeVisible();
	await expect(recipientInput).toBeFocused();
	await expect(compose.locator('button[data-bind*="command: sendCommand"]')).toBeVisible();

	const more = compose.locator('button.dropdown-toggle');
	await more.click();
	const menu = compose.locator('menu[role="menu"]');
	await expect(menu).toBeVisible();
	const ltrBounds = await menu.boundingBox();
	expect(ltrBounds?.x).toBeGreaterThanOrEqual(0);
	expect((ltrBounds?.x || 0) + (ltrBounds?.width || 0)).toBeLessThanOrEqual(page.viewportSize().width);
	const bcc = compose.locator('menu[role="menu"] a[role="menuitemcheckbox"]').first();
	await expect(bcc).toHaveAttribute('aria-checked', 'false');
	await bcc.click();
	await expect(compose.locator('.bcc-row')).toBeVisible();
	await page.locator('html').evaluate(root => { root.dir = 'rtl'; });
	await more.click();
	await expect(menu).toBeVisible();
	const rtlBounds = await menu.boundingBox();
	expect(rtlBounds?.x).toBeGreaterThanOrEqual(0);
	expect((rtlBounds?.x || 0) + (rtlBounds?.width || 0)).toBeLessThanOrEqual(page.viewportSize().width);
	await expect(actions).not.toContain('SendEmail');
	await expect(actions).not.toContain('SaveMessage');
});

test('message-view toolbar actions stay hidden without a message while list actions remain available', async ({ authenticated }) => {
	const { page, actions } = authenticated;
	await authenticated.open();
	await expect(page.locator('#V-MailMessageList .listEmptyMessage')).toBeVisible();
	await page.setViewportSize({ width: 1600, height: 900 });
	await page.locator('html').evaluate(root => {
		root.classList.remove('sm-msgView-bottom');
		root.classList.add('sm-msgView-side');
	});

	const viewer = page.locator('#V-MailMessageView'),
		toolbar = viewer.locator('.top-toolbar'),
		actionGroups = toolbar.locator('.message-view-toolbar-actions'),
		listToolbar = page.locator('#V-MailMessageList > .btn-toolbar'),
		listMore = page.locator('#more-list-dropdown-id');
	await expect(page.locator('#rl-right')).not.toHaveClass(/message-selected/);
	await expect(viewer).toBeVisible();
	await expect(actionGroups).toHaveCount(4);
	for (let i = 0; i < 4; i++) {
		await expect(actionGroups.nth(i)).toHaveCSS('display', 'none');
	}
	await expect(toolbar).toHaveCSS('min-height', '50px');
	expect((await toolbar.boundingBox()).height).toBeCloseTo(50, 0);

	const firstViewerButton = toolbar.locator('button').first();
	await firstViewerButton.evaluate(button => button.focus());
	expect(await page.evaluate(() => document.activeElement?.closest('#V-MailMessageView .message-view-toolbar-actions'))).toBeNull();

	await expect(listToolbar).toBeVisible();
	await expect(listMore).toBeVisible();
	await listMore.click();
	await expect(page.locator('#V-MailMessageList menu[aria-labelledby="more-list-dropdown-id"]')).toBeVisible();
	await listMore.click();
	await expect(page.locator('#V-MailMessageList menu[aria-labelledby="more-list-dropdown-id"]')).toBeHidden();

	const previousListRequests = actions.filter(action => 'MessageList' === action).length;
	await page.locator('#V-MailMessageList button[data-bind*="click: reload"]').click();
	await expect.poll(() => actions.filter(action => 'MessageList' === action).length).toBeGreaterThan(previousListRequests);
});

test('folder toolbar Compose fills the expanded rail, centers its content, and stays compact when collapsed', async ({ authenticated }) => {
	const { page } = authenticated;
	await authenticated.open({ language: 'de' });
	await authenticated.openFolderNavigation();
	await page.setViewportSize({ width: 1024, height: 667 });

	const toolbar = page.locator('#V-MailFolderList .b-toolbar'),
		compose = toolbar.locator('.buttonCompose');
	await expect(page.locator('#V-MailFolderList .buttonContacts')).toHaveCount(0);
	await expect(compose).toBeVisible();

	const expanded = await page.evaluate(() => {
		const toolbar = document.querySelector('#V-MailFolderList .b-toolbar'),
			folders = toolbar.closest('.b-folders'),
			button = toolbar.querySelector('.buttonCompose'),
			icon = button.querySelector('i'),
			label = button.querySelector('.buttonComposeText'),
			foldersRect = folders.getBoundingClientRect(),
			buttonRect = button.getBoundingClientRect(),
			iconRect = icon.getBoundingClientRect(),
			labelRect = label.getBoundingClientRect(),
			style = getComputedStyle(toolbar);
		return {
			buttonWidth: buttonRect.width,
			buttonHeight: buttonRect.height,
			buttonCenterY: (buttonRect.top + buttonRect.bottom) / 2,
			availableWidth: toolbar.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
			leftGap: buttonRect.left - foldersRect.left,
			rightGap: foldersRect.right - buttonRect.right,
			buttonCenter: (buttonRect.left + buttonRect.right) / 2,
			contentCenter: (iconRect.left + labelRect.right) / 2,
			iconCenterY: (iconRect.top + iconRect.bottom) / 2,
			labelCenterY: (labelRect.top + labelRect.bottom) / 2,
			label: label.textContent.trim(),
			iconVisible: iconRect.width > 0
		};
	});
	expect(expanded.buttonWidth).toBeCloseTo(expanded.availableWidth, 0);
	expect(expanded.buttonHeight).toBeGreaterThanOrEqual(30);
	expect(expanded.leftGap).toBeCloseTo(8, 0);
	expect(expanded.rightGap).toBeCloseTo(8, 0);
	expect(Math.abs(expanded.leftGap - expanded.rightGap)).toBeLessThanOrEqual(1);
	expect(Math.abs(expanded.buttonCenter - expanded.contentCenter)).toBeLessThanOrEqual(1);
	expect(Math.abs(expanded.buttonCenterY - expanded.iconCenterY)).toBeLessThanOrEqual(1);
	expect(Math.abs(expanded.buttonCenterY - expanded.labelCenterY)).toBeLessThanOrEqual(1);
	expect(expanded.label).toBe('Neue Nachricht');
	expect(expanded.iconVisible).toBe(true);

	await page.locator('html').evaluate(root => { root.dir = 'rtl'; });
	const rtlExpanded = await page.evaluate(() => {
		const toolbar = document.querySelector('#V-MailFolderList .b-toolbar'),
			folders = toolbar.closest('.b-folders'),
			button = toolbar.querySelector('.buttonCompose'),
			iconRect = button.querySelector('i').getBoundingClientRect(),
			labelRect = button.querySelector('.buttonComposeText').getBoundingClientRect(),
			foldersRect = folders.getBoundingClientRect(),
			buttonRect = button.getBoundingClientRect(),
			contentCenter = (Math.min(iconRect.left, labelRect.left) + Math.max(iconRect.right, labelRect.right)) / 2;
		return {
			leftGap: buttonRect.left - foldersRect.left,
			rightGap: foldersRect.right - buttonRect.right,
			buttonCenter: (buttonRect.left + buttonRect.right) / 2,
			contentCenter
		};
	});
	expect(rtlExpanded.leftGap).toBeCloseTo(8, 0);
	expect(rtlExpanded.rightGap).toBeCloseTo(8, 0);
	expect(Math.abs(rtlExpanded.leftGap - rtlExpanded.rightGap)).toBeLessThanOrEqual(1);
	expect(Math.abs(rtlExpanded.buttonCenter - rtlExpanded.contentCenter)).toBeLessThanOrEqual(2);

	await page.locator('#V-MailFolderList .b-footer .toggleLeft').click();
	await expect(page.locator('#rl-left')).toHaveCSS('width', '60px');
	await expect(compose.locator('.buttonComposeText')).toBeHidden();
	const collapsed = await page.evaluate(() => {
		const rail = document.querySelector('#rl-left'),
			toolbar = document.querySelector('#V-MailFolderList .b-toolbar'),
			button = toolbar.querySelector('.buttonCompose'),
			icon = button.querySelector('[data-ui-icon="send"]'),
			buttonRect = button.getBoundingClientRect(),
			iconRect = icon.getBoundingClientRect(),
			iconPseudo = getComputedStyle(icon, '::before'),
			railRect = rail.getBoundingClientRect();
		return {
			buttonWidth: buttonRect.width,
			buttonCenter: (buttonRect.left + buttonRect.right) / 2,
			iconCenter: (iconRect.left + iconRect.right) / 2,
			iconWidth: iconRect.width,
			iconPseudoWidth: parseFloat(iconPseudo.width),
			iconPseudoMarginInlineEnd: parseFloat(iconPseudo.marginInlineEnd),
			railCenter: (railRect.left + railRect.right) / 2,
			textVisible: getComputedStyle(button.querySelector('.buttonComposeText')).display !== 'none'
		};
	});
	expect(collapsed.buttonWidth).toBeLessThan(60);
	expect(Math.abs(collapsed.buttonCenter - collapsed.railCenter)).toBeLessThanOrEqual(1);
	expect(Math.abs(collapsed.iconCenter - collapsed.buttonCenter)).toBeLessThanOrEqual(1);
	expect(Math.abs(collapsed.iconWidth - collapsed.iconPseudoWidth)).toBeLessThanOrEqual(1);
	expect(collapsed.iconPseudoMarginInlineEnd).toBe(0);
	expect(collapsed.textVisible).toBe(false);
	await compose.click();
	await expect(page.locator('#V-PopupsCompose')).toBeVisible();
});

test('folder Compose and its German label do not overflow a 320px viewport', async ({ authenticated }) => {
	const { page } = authenticated;
	await authenticated.open({ language: 'de' });
	await page.setViewportSize({ width: 320, height: 667 });
	await authenticated.openFolderNavigation();

	const geometry = await page.evaluate(() => {
		const button = document.querySelector('#V-MailFolderList .buttonCompose'),
			rail = document.querySelector('#rl-left'),
			rect = button.getBoundingClientRect(),
			labelRect = button.querySelector('.buttonComposeText').getBoundingClientRect(),
			style = getComputedStyle(button);
		return {
			viewport: document.documentElement.clientWidth,
			document: document.documentElement.scrollWidth,
			railWidth: rail.getBoundingClientRect().width,
			buttonRight: rect.right,
			labelRight: labelRect.right,
			buttonContentRight: rect.right - parseFloat(style.paddingRight),
			buttonScrollWidth: button.scrollWidth,
			buttonClientWidth: button.clientWidth,
			labelWhiteSpace: getComputedStyle(button.querySelector('.buttonComposeText')).whiteSpace,
			labelTextOverflow: getComputedStyle(button.querySelector('.buttonComposeText')).textOverflow
		};
	});
	expect(geometry.railWidth).toBeLessThanOrEqual(160);
	expect(geometry.document).toBeLessThanOrEqual(geometry.viewport);
	expect(geometry.buttonRight).toBeLessThanOrEqual(geometry.railWidth + 1);
	expect(geometry.labelRight).toBeLessThanOrEqual(geometry.buttonContentRight + 1);
	expect(geometry.buttonScrollWidth).toBeLessThanOrEqual(geometry.buttonClientWidth);
	expect(geometry.labelWhiteSpace).toBe('nowrap');
	expect(geometry.labelTextOverflow).toBe('ellipsis');
});

test('message list read-state menu icons stay local and actions remain keyboard navigable', async ({ authenticated }) => {
	const { page } = authenticated;
	await authenticated.open();

	const trigger = page.locator('#more-list-dropdown-id'),
		menu = page.locator('#V-MailMessageList menu[role="menu"][aria-labelledby="more-list-dropdown-id"]'),
		unread = menu.locator('a[data-i18n="MESSAGE_LIST/MENU_UNSET_SEEN"]'),
		read = menu.locator('a[data-i18n="MESSAGE_LIST/MENU_SET_SEEN"]'),
		allSeen = menu.locator('a[data-i18n="MESSAGE_LIST/MENU_SET_ALL_SEEN"]');

	await trigger.click();
	await expect(menu).toBeVisible();
	await expect(unread).toHaveText('Mark as unread');
	await expect(read).toHaveText('Mark as read');
	await expect(allSeen).toBeVisible();
	await expect(unread.locator('..')).toHaveClass(/disabled/);
	await expect(read.locator('..')).toHaveClass(/disabled/);
	await expect(unread).toHaveAttribute('href', '#');
	await expect(unread).toHaveAttribute('tabindex', '-1');
	await expect(read).toHaveAttribute('href', '#');
	await expect(read).toHaveAttribute('tabindex', '-1');
	expect(await unread.evaluate(element => element.childElementCount)).toBe(0);
	expect(await read.evaluate(element => element.childElementCount)).toBe(0);
	expect(await allSeen.evaluate(element => element.childElementCount)).toBe(0);

	const iconMask = element => element.evaluate(anchor => {
		const style = getComputedStyle(anchor, '::before');
		return [style.maskImage, style.webkitMaskImage].filter(value => value && value !== 'none').join(' ');
	});
	expect(await iconMask(unread)).toContain('mail.svg');
	expect(await iconMask(read)).toContain('mail-open.svg');
	expect(await iconMask(allSeen)).toContain('check-check.svg');

	await page.keyboard.press('ArrowDown');
	await expect(unread).toBeFocused();
	await page.keyboard.press('ArrowDown');
	await expect(read).toBeFocused();
	await page.keyboard.press('ArrowUp');
	await expect(unread).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(menu).toBeHidden();
	await expect(trigger).toBeFocused();
});

test('contacts create, display, and delete using only the synthetic in-memory service', async ({ authenticated }) => {
	const { page, actions } = authenticated;
	await authenticated.open();
	await openContactsFromAccountMenu(page);

	const contacts = page.locator('#V-PopupsContacts');
	await expect(contacts).toBeVisible();
	await expect(contacts.locator('.listEmptyList')).toBeVisible();
	await expect(contacts.locator('menu[role="menu"] [data-bind*="command: syncCommand"]')).toBeHidden();

	await contacts.getByRole('button', { name: 'Add contact' }).click();
	const firstName = contacts.locator('.b-view-content .property-line input').first();
	const lastName = contacts.locator('.b-view-content .property-line input').nth(1);
	await firstName.fill('Rae');
	await lastName.fill('Doe');
	await contacts.locator('.b-view-content a[data-ui-icon="plus"]').first().click();
	const emailField = contacts.locator('.control-group:has(label[data-i18n="[title]GLOBAL/EMAIL"]) .property-line input');
	await emailField.fill('rae@example.test');
	await contacts.locator('.button-save-contact').click();
	await expect(contacts.locator('.e-contact-item')).toContainText('Rae Doe');
	await expect.poll(() => actions.filter(action => 'ContactSave' === action).length).toBe(1);

	await contacts.locator('.e-contact-item').click();
	await contacts.locator('.b-header-toolbar button[data-ui-icon="trash-2"]').click();
	await expect(contacts.locator('.listEmptyList')).toBeVisible();
	await expect.poll(() => actions.filter(action => 'ContactsDelete' === action).length).toBe(1);
	await expect(actions).not.toContain('ContactsSync');
});

test('touch mailbox and compose text fields use 16px without changing phone layout', async ({ authenticated }) => {
	const { page } = authenticated;
	await authenticated.open();
	expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
	await expect(page.locator('#V-MailMessageList .inputSearch')).toHaveCSS('font-size', '16px');

	await authenticated.openFolderNavigation();
	await page.locator('#V-MailFolderList .buttonCompose').click();
	const compose = page.locator('#V-PopupsCompose');
	await expect(compose).toBeVisible();
	await expect(compose.getByRole('row', { name: 'To' }).getByRole('combobox')).toHaveCSS('font-size', '16px');
	await expect(compose.locator('input[name="subject"]')).toHaveCSS('font-size', '16px');
	await expect(compose.locator('.textAreaParent [contenteditable="true"]').first()).toHaveCSS('font-size', '16px');

	for (const [width, height] of [[320, 667], [375, 667], [844, 390]]) {
		await page.setViewportSize({ width, height });
		expect(await page.evaluate(() => document.documentElement.scrollWidth))
			.toBeLessThanOrEqual(await page.evaluate(() => document.documentElement.clientWidth));
		await expect(compose.locator('input[name="subject"]')).toHaveCSS('font-size', '16px');
	}
});

test('touch Settings text fields use 16px', async ({ authenticated }) => {
	const { page } = authenticated;
	await authenticated.open();
	expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
	await page.locator('#top-system-dropdown-id').click();
	await page.locator('#V-SystemDropDown a[data-bind*="settingsClick"]').click();
	await expect(page.locator('#V-Settings-General input[type="number"]').first()).toHaveCSS('font-size', '16px');
	await expect(page.locator('#V-Settings-General textarea').first()).toHaveCSS('font-size', '16px');
});

test('touch Contacts search and edit fields use 16px', async ({ authenticated }) => {
	const { page } = authenticated;
	await authenticated.open({ initialContacts: [fixtureContact()] });
	expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
	await openContactsFromAccountMenu(page);
	const contacts = page.locator('#V-PopupsContacts');
	await expect(contacts.locator('.e-contact-item')).toContainText('Rae Doe');
	await expect(contacts.locator('.e-search')).toHaveCSS('font-size', '16px');
	await contacts.locator('.e-contact-item').click();
	await expect(contacts.locator('.b-view-content .property-line input').first()).toHaveCSS('font-size', '16px');
});

test.describe('desktop text entry sizing', () => {
	test.use({ isMobile: false, hasTouch: false, viewport: { width: 1280, height: 900 } });

	test('coarse-pointer rule does not change the desktop font size', async ({ page }) => {
		await page.setContent('<div id="rl-app"><input type="text"><input type="search"><textarea></textarea></div>');
		await page.addStyleTag({ path: path.join(repositoryRoot, 'snappymail/v/0.0.0/static/css/app.css') });
		expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(false);
		for (const selector of ['input[type="text"]', 'input[type="search"]', 'textarea']) {
			await expect(page.locator(`#rl-app ${selector}`)).toHaveCSS('font-size', '14px');
		}
	});
});

test('contact service errors appear as a synthetic alert without exposing request data', async ({ authenticated }) => {
	const { page } = authenticated;
	await authenticated.open();
	authenticated.failNextContactsRequest();
	await openContactsFromAccountMenu(page);
	await expect.poll(() => page.evaluate(() => window.__authenticatedFixtureAlerts)).toEqual([
		'Synthetic contacts failure'
	]);
});

test('contacts stay hidden in the account menu when the account disallows them', async ({ authenticated }) => {
	const { page, actions } = authenticated;
	await authenticated.open({ contactsAllowed: false });
	await page.locator('#top-system-dropdown-id').click();
	await expect(page.locator('#V-SystemDropDown menu[role="menu"]')).toBeVisible();
	await expect(page.locator('#V-SystemDropDown a[data-bind*="contactsClick"]')).toBeHidden();
	expect(actions).not.toContain('Contacts');
});

test('contacts settings keep CardDAV sync unavailable when the server omits sync configuration', async ({ authenticated }) => {
	const { page, actions } = authenticated;
	await authenticated.open();
	await page.locator('#top-system-dropdown-id').click();
	await page.locator('#V-SystemDropDown a[data-bind*="settingsClick"]').click();
	await openSettingsNavigation(page);
	await page.locator('#V-SettingsMenu nav a[href="#/settings/contacts"]').click();
	await closeSettingsNavigation(page);

	const contactSettings = page.locator('#V-Settings-Contacts');
	await expect(contactSettings).toBeVisible();
	await expect(contactSettings.locator('form')).toBeHidden();
	await expect(actions).not.toContain('SaveContactsSyncData');
	await expect(actions).not.toContain('ContactsSync');
});

test('authenticated settings change live appearance and display synthetic 2FA setup', async ({ authenticated }) => {
	const { page, actions } = authenticated;
	await authenticated.open();
	await page.locator('#top-system-dropdown-id').click();
	await page.locator('#V-SystemDropDown a[data-bind*="settingsClick"]').click();

	const general = page.locator('#V-Settings-General');
	await expect(general).toBeVisible();
	const appearance = general.locator('#appearance');
	await appearance.selectOption('dark');
	await expect(page.locator('html')).toHaveAttribute('data-appearance-scheme', 'dark');
	await expect.poll(() => actions.includes('SettingsUpdate')).toBe(true);
	await appearance.selectOption('system');
	await page.emulateMedia({ colorScheme: 'dark' });
	await expect(page.locator('html')).toHaveAttribute('data-appearance-scheme', 'dark');
	await page.emulateMedia({ colorScheme: 'light' });
	await expect(page.locator('html')).toHaveAttribute('data-appearance-scheme', 'light');

	await openSettingsNavigation(page);
	await page.locator('#V-SettingsMenu nav a[href="#/settings/security"]').click();
	await closeSettingsNavigation(page);
	const security = page.locator('#V-Settings-Security');
	await expect(security).toBeVisible();
	const startTwoFactor = security.locator('button[data-i18n="SETTINGS_SECURITY/TFA_START"]');
	await expect(startTwoFactor).toBeVisible();
	await startTwoFactor.click();
	await expect(security.locator('#two-factor-enrollment-code')).toBeVisible();
	await expect(security.locator('strong').filter({ hasText: 'SYNTHETIC-SECRET' })).toBeVisible();
	await expect.poll(() => actions.filter(action => 'TwoFactorSetup' === action).length).toBe(1);
	await expect(actions).not.toContain('TwoFactorEnable');
});

test('authenticated header Appearance switch persists and synchronizes with Settings', async ({ authenticated }) => {
	const { page, appearanceUpdates } = authenticated;
	await authenticated.open({ appearance: 'light' });

	const switcher = page.locator('#V-SystemDropDown .appearance-quick-switch'),
		light = switcher.getByRole('radio', { name: 'Light' }),
		loadedAt = await page.evaluate(() => performance.timeOrigin);
	const expectIconAccent = async (selected, color) => {
		for (const choice of ['light', 'dark', 'system']) {
			await expect(switcher.locator(`label[data-appearance-choice="${choice}"] .appearance-quick-switch-icon`))
				.toHaveCSS('color', choice === selected ? color : 'rgb(255, 255, 255)');
		}
		if ('rgb(255, 153, 51)' === color) {
			const contrast = await switcher.locator(`label[data-appearance-choice="${selected}"] .appearance-quick-switch-icon`).evaluate(icon => {
				const parseColor = value => {
					const channels = value.match(/[\d.]+/g).map(Number);
					return [channels[0], channels[1], channels[2], channels[3] ?? 1];
				};
				const ancestors = [];
				for (let node = icon; node && node !== document.documentElement; node = node.parentElement) {
					ancestors.push(node);
				}
				let background = [255, 255, 255];
				for (const node of ancestors.reverse()) {
					const [red, green, blue, alpha] = parseColor(getComputedStyle(node).backgroundColor);
					background = [red, green, blue].map((channel, index) => channel * alpha + background[index] * (1 - alpha));
				}
				const luminance = channels => channels.map(channel => channel / 255).map(channel =>
					channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
				).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
				const foreground = parseColor(getComputedStyle(icon).color).slice(0, 3);
				const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
				return (values[0] + 0.05) / (values[1] + 0.05);
			});
			expect(contrast).toBeGreaterThanOrEqual(3);
		}
	};
	await expect(page.getByRole('radiogroup', { name: 'Appearance' })).toBeVisible();
	await expect(switcher.locator('input[type="radio"]')).toHaveCount(3);
	await expect(light).toBeChecked();
	await expect(page.locator('html')).toHaveAttribute('data-appearance-scheme', 'light');
	await expectIconAccent('light', 'rgb(17, 198, 219)');
	await switcher.locator('label[data-appearance-choice="system"]').hover();
	await expectIconAccent('light', 'rgb(17, 198, 219)');
	await page.mouse.move(0, 0);
	expect(await switcher.evaluate(element => getComputedStyle(element).color)).toBe('rgb(255, 255, 255)');
	expect(await switcher.locator('label').evaluateAll(labels => labels.map(label => ({
		value: label.querySelector('input').value,
		icon: label.querySelector('[data-ui-icon]').getAttribute('data-ui-icon'),
		decorative: label.querySelector('[data-ui-icon]').getAttribute('aria-hidden') === 'true'
	})))).toEqual([
		{ value: 'light', icon: 'sun', decorative: true },
		{ value: 'dark', icon: 'moon', decorative: true },
		{ value: 'system', icon: 'monitor', decorative: true }
	]);
	expect(await switcher.locator('label').evaluateAll(labels => labels.map(label => {
		const { width, height } = label.getBoundingClientRect();
		return [width, height];
	}))).toEqual([[30, 30], [30, 30], [30, 30]]);

	await page.emulateMedia({ colorScheme: 'dark' });
	await expect(page.locator('html')).toHaveAttribute('data-appearance-scheme', 'light');
	await expectIconAccent('light', 'rgb(17, 198, 219)');
	for (const [index, value] of ['dark', 'system', 'light'].entries()) {
		await switcher.locator(`label[data-appearance-choice="${value}"]`).click();
		await expect(switcher.getByRole('radio', { name: value[0].toUpperCase() + value.slice(1) })).toBeChecked();
		await expect(switcher.locator(`label[data-appearance-choice="${value}"]`)).toHaveClass(/is-selected/);
		const effectiveScheme = await page.locator('html').getAttribute('data-appearance-scheme');
		await expectIconAccent(value, 'light' === effectiveScheme ? 'rgb(17, 198, 219)' : 'rgb(255, 153, 51)');
		await expect.poll(() => appearanceUpdates.length).toBe(index + 1);
		expect(appearanceUpdates[index]).toBe(value);
		await expect(page.locator('html')).toHaveAttribute('data-appearance-scheme', 'dark' === value ? 'dark' : 'light');
		if ('dark' === value) {
			await page.emulateMedia({ colorScheme: 'light' });
			await expect(page.locator('html')).toHaveAttribute('data-appearance-scheme', 'dark');
		}
		if ('system' === value) {
			await page.emulateMedia({ colorScheme: 'light' });
			await expect(page.locator('html')).toHaveAttribute('data-appearance-scheme', 'light');
			await expectIconAccent('system', 'rgb(17, 198, 219)');
			await page.emulateMedia({ colorScheme: 'dark' });
			await expect(page.locator('html')).toHaveAttribute('data-appearance-scheme', 'dark');
			await expectIconAccent('system', 'rgb(255, 153, 51)');
			await page.emulateMedia({ colorScheme: 'light' });
			await expectIconAccent('system', 'rgb(17, 198, 219)');
		}
	}
	await expect.poll(() => page.evaluate(() => performance.timeOrigin)).toBe(loadedAt);

	await page.locator('#top-system-dropdown-id').click();
	await page.locator('#V-SystemDropDown a[data-bind*="settingsClick"]').click();
	const appearance = page.locator('#V-Settings-General #appearance');
	await expect(appearance).toHaveValue('light');
	for (const [index, value] of ['dark', 'system', 'light'].entries()) {
		await appearance.selectOption(value);
		await expect(switcher.getByRole('radio', { name: value[0].toUpperCase() + value.slice(1) })).toBeChecked();
		const effectiveScheme = await page.locator('html').getAttribute('data-appearance-scheme');
		await expectIconAccent(value, 'light' === effectiveScheme ? 'rgb(17, 198, 219)' : 'rgb(255, 153, 51)');
		await expect.poll(() => appearanceUpdates.length).toBe(index + 4);
		expect(appearanceUpdates[index + 3]).toBe(value);
	}

	await appearance.selectOption('system');
	await expect.poll(() => appearanceUpdates.length).toBe(7);
	await page.emulateMedia({ colorScheme: 'dark' });
	await expect(page.locator('html')).toHaveAttribute('data-appearance-scheme', 'dark');
	await expectIconAccent('system', 'rgb(255, 153, 51)');
	await page.reload();
	await expect(page.locator('#V-SystemDropDown .appearance-quick-switch')).toBeVisible();
	await expect(page.locator('#V-SystemDropDown .appearance-quick-switch').getByRole('radio', { name: 'System' })).toBeChecked();
	await expect(page.locator('html')).toHaveAttribute('data-appearance-scheme', 'dark');
	expect(appearanceUpdates).toHaveLength(7);
});

test('Appearance header switch supports native radio keyboard focus and fits a narrow header', async ({ authenticated }) => {
	const { page, appearanceUpdates } = authenticated;
	await authenticated.open({ appearance: 'light' });
	const switcher = page.locator('#V-SystemDropDown .appearance-quick-switch'),
		light = switcher.getByRole('radio', { name: 'Light' }),
		dark = switcher.getByRole('radio', { name: 'Dark' });

	await light.focus();
	await page.keyboard.press('Tab');
	await page.keyboard.press('Shift+Tab');
	await expect(light).toBeFocused();
	await expect(switcher.locator('label[data-appearance-choice="light"] .appearance-quick-switch-icon'))
		.toHaveCSS('outline-style', 'solid');
	await expect(switcher.locator('label[data-appearance-choice="light"] .appearance-quick-switch-icon'))
		.toHaveCSS('outline-color', 'rgb(51, 102, 153)');
	await expect(switcher.locator('label[data-appearance-choice="light"] .appearance-quick-switch-icon'))
		.toHaveCSS('color', 'rgb(17, 198, 219)');
	await page.keyboard.press('ArrowRight');
	await expect(dark).toBeFocused();
	await expect(dark).toBeChecked();
	await expect(switcher.locator('label[data-appearance-choice="dark"] .appearance-quick-switch-icon'))
		.toHaveCSS('outline-style', 'solid');
	await expect(switcher.locator('label[data-appearance-choice="dark"] .appearance-quick-switch-icon'))
		.toHaveCSS('outline-color', 'rgb(102, 170, 238)');
	await expect(switcher.locator('label[data-appearance-choice="dark"] .appearance-quick-switch-icon'))
		.toHaveCSS('color', 'rgb(255, 153, 51)');
	await expect(switcher.locator('label[data-appearance-choice="light"] .appearance-quick-switch-icon'))
		.toHaveCSS('color', 'rgb(255, 255, 255)');
	await expect.poll(() => appearanceUpdates.length).toBe(1);
	await page.keyboard.press('Tab');
	await expect(page.locator('#top-system-dropdown-id')).toBeFocused();

	for (const width of [1280, 768, 375, 320]) {
		await page.setViewportSize({ width, height: 667 });
		await page.evaluate(() => window.dispatchEvent(new CustomEvent('audio.start', { detail: 'synthetic notification' })));
		const geometry = await page.evaluate(() => {
			const toolbar = document.querySelector('#V-SystemDropDown'),
				appearance = toolbar.querySelector('.appearance-quick-switch').getBoundingClientRect(),
				account = toolbar.querySelector('#top-system-dropdown-id').getBoundingClientRect(),
				bounds = toolbar.getBoundingClientRect();
			return {
				viewport: document.documentElement.clientWidth,
				document: document.documentElement.scrollWidth,
				bounds: { left: bounds.left, right: bounds.right },
				appearance: { left: appearance.left, right: appearance.right },
			account: { left: account.left, right: account.right },
			segmentWidths: [...toolbar.querySelectorAll('.appearance-quick-switch-option')]
				.map(segment => segment.getBoundingClientRect().width)
			};
		});
		expect(geometry.document).toBeLessThanOrEqual(geometry.viewport);
		expect(geometry.bounds.left).toBeGreaterThanOrEqual(0);
		expect(geometry.bounds.right).toBeLessThanOrEqual(geometry.viewport);
		expect(geometry.appearance.right).toBeLessThanOrEqual(geometry.account.left);
		expect(geometry.segmentWidths).toEqual([30, 30, 30]);
		await expect(page.locator('#top-system-dropdown-id')).toBeVisible();
	}
	await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
	const rtlGeometry = await page.evaluate(() => {
		const toolbar = document.querySelector('#V-SystemDropDown'),
			appearance = toolbar.querySelector('.appearance-quick-switch').getBoundingClientRect(),
			account = toolbar.querySelector('#top-system-dropdown-id').getBoundingClientRect(),
			bounds = toolbar.getBoundingClientRect();
		return {
			direction: getComputedStyle(toolbar).direction,
			viewport: document.documentElement.clientWidth,
			document: document.documentElement.scrollWidth,
			bounds: { left: bounds.left, right: bounds.right },
			appearance: { left: appearance.left, right: appearance.right },
			account: { left: account.left, right: account.right }
		};
	});
	expect(rtlGeometry.direction).toBe('rtl');
	expect(rtlGeometry.document).toBeLessThanOrEqual(rtlGeometry.viewport);
	expect(rtlGeometry.bounds.left).toBeGreaterThanOrEqual(0);
	expect(rtlGeometry.bounds.right).toBeLessThanOrEqual(rtlGeometry.viewport);
	expect(rtlGeometry.appearance.left).toBeGreaterThanOrEqual(rtlGeometry.account.right + 7);

	await page.locator('#top-system-dropdown-id').click();
	await expect(page.locator('#V-SystemDropDown menu[role="menu"]')).toBeVisible();
});

test('check mail interval offers and saves only numeric preset values', async ({ authenticated }) => {
	const { page, settingUpdates } = authenticated;
	await authenticated.open();
	await page.locator('#top-system-dropdown-id').click();
	await page.locator('#V-SystemDropDown a[data-bind*="settingsClick"]').click();

	const interval = page.getByRole('combobox', { name: 'Check mail interval' });
	await expect(interval).toBeVisible();
	expect(await interval.locator('option').evaluateAll(options => options.map(option => option.value)))
		.toEqual(['5', '10', '15', '30', '60']);
	await expect(page.locator('label[for="check-mail-interval"]')).toHaveCount(1);
	await expect(page.locator('#V-Settings-General [data-i18n="SETTINGS_GENERAL/MINUTES"]')).toHaveText('minutes');

	for (const [index, value] of [5, 10, 15, 30, 60].entries()) {
		await interval.selectOption(String(value));
		await expect.poll(() => settingUpdates.length).toBe(index + 1);
		expect(settingUpdates[index]).toBe(value);
	}

});

test('check mail interval persists a selected preset after reload', async ({ authenticated }) => {
	const { page, settingUpdates } = authenticated;
	await authenticated.open({ checkMailInterval: 60 });
	await page.locator('#top-system-dropdown-id').click();
	await page.locator('#V-SystemDropDown a[data-bind*="settingsClick"]').click();

	const interval = page.getByRole('combobox', { name: 'Check mail interval' });
	await interval.selectOption('10');
	await expect.poll(() => settingUpdates.length).toBe(1);
	expect(settingUpdates).toEqual([10]);

	await page.reload();
	await page.locator('#top-system-dropdown-id').click();
	await page.locator('#V-SystemDropDown a[data-bind*="settingsClick"]').click();
	await expect(page.getByRole('combobox', { name: 'Check mail interval' })).toHaveValue('10');
	expect(settingUpdates).toEqual([10]);
});

test('check mail interval has an associated label and supports keyboard selection', async ({ authenticated }) => {
	const { page, settingUpdates } = authenticated;
	await authenticated.open({ checkMailInterval: 5 });
	await page.locator('#top-system-dropdown-id').click();
	await page.locator('#V-SystemDropDown a[data-bind*="settingsClick"]').click();

	const interval = page.getByRole('combobox', { name: 'Check mail interval' });
	await interval.focus();
	await page.keyboard.press('ArrowDown');
	await expect(interval).toHaveValue('10');
	await expect.poll(() => settingUpdates.length).toBe(1);
	expect(settingUpdates).toEqual([10]);
});

for (const legacyInterval of [17, 20, 45, 90]) {
	test(`preserves legacy check mail interval ${legacyInterval} until a preset is selected`, async ({ authenticated }) => {
		const { page, settingUpdates } = authenticated;
		await authenticated.open({ checkMailInterval: legacyInterval });
		await page.locator('#top-system-dropdown-id').click();
		await page.locator('#V-SystemDropDown a[data-bind*="settingsClick"]').click();

		const interval = page.getByRole('combobox', { name: 'Check mail interval' });
		await expect(interval).toHaveValue(String(legacyInterval));
		const expectedValues = [5, 10, 15, 30, 60, legacyInterval]
			.sort((a, b) => a - b)
			.map(String);
		expect(await interval.locator('option').evaluateAll(options => options.map(option => option.value)))
			.toEqual(expectedValues);
		await expect(interval.locator(`option[value="${legacyInterval}"]`)).toBeDisabled();
		expect(settingUpdates).toEqual([]);

		await interval.focus();
		await page.keyboard.press('Home');
		await expect(interval).toHaveValue('5');
		await expect.poll(() => settingUpdates.length).toBe(1);
		expect(settingUpdates[0]).toBe(5);
		await expect(interval.locator('option')).toHaveCount(5);
	});
}

test('check mail interval honors the configured minimum while retaining only preset choices', async ({ authenticated }) => {
	const { page, settingUpdates } = authenticated;
	await authenticated.open({ checkMailInterval: 20, minRefreshInterval: 20 });
	await page.locator('#top-system-dropdown-id').click();
	await page.locator('#V-SystemDropDown a[data-bind*="settingsClick"]').click();

	const interval = page.getByRole('combobox', { name: 'Check mail interval' });
	await expect(interval).toHaveValue('20');
	const disabledValues = await interval.locator('option:disabled').evaluateAll(options => options.map(option => option.value));
	expect(disabledValues).toEqual(['5', '10', '15', '20']);
	expect(settingUpdates).toEqual([]);

	await interval.selectOption('30');
	await expect.poll(() => settingUpdates.length).toBe(1);
	expect(settingUpdates[0]).toBe(30);
});

test('check mail interval control is disabled when the configured minimum exceeds every preset', async ({ authenticated }) => {
	const { page, settingUpdates } = authenticated;
	await authenticated.open({ checkMailInterval: 61, minRefreshInterval: 61 });
	await page.locator('#top-system-dropdown-id').click();
	await page.locator('#V-SystemDropDown a[data-bind*="settingsClick"]').click();

	const interval = page.getByRole('combobox', { name: 'Check mail interval' });
	await expect(interval).toBeDisabled();
	await expect(interval).toHaveValue('61');
	expect(await interval.locator('option').evaluateAll(options => options.map(option => option.value)))
		.toEqual(['5', '10', '15', '30', '60', '61']);
	expect(settingUpdates).toEqual([]);
});

test('check mail interval keeps its minute label localized', async ({ authenticated }) => {
	const { page } = authenticated;
	await authenticated.open({ language: 'de' });
	await page.locator('#top-system-dropdown-id').click();
	await page.locator('#V-SystemDropDown a[data-bind*="settingsClick"]').click();

	const interval = page.getByRole('combobox', { name: 'Prüfintervall für neue Nachrichten' });
	await expect(interval).toBeVisible();
	await expect(page.locator('#V-Settings-General [data-i18n="SETTINGS_GENERAL/MINUTES"]')).toHaveText('Minuten');
});

test('forced 2FA enrollment opens security and keeps mailbox unavailable', async ({ authenticated }) => {
	const { page, actions } = authenticated;
	await authenticated.open({ forcedTwoFactor: true });
	await expect(page.locator('#V-Settings-Security')).toBeVisible();
	await expect(page.locator('#V-SystemDropDown .appearance-quick-switch')).toBeHidden();
	await expect(page.locator('#V-Settings-Security [data-i18n="SETTINGS_SECURITY/TFA_REQUIRED"]')).toBeVisible();
	await expect(page).toHaveURL(/#\/settings\/security$/);
	await expect(page.locator('#V-MailFolderList')).toHaveCount(0);
	await expect.poll(() => actions.includes('TwoFactorState')).toBe(true);
});

test('a supplied synthetic contacts record renders in the contacts dialog', async ({ authenticated }) => {
	const { page } = authenticated;
	await authenticated.open({ initialContacts: [fixtureContact()] });
	await openContactsFromAccountMenu(page);
	const contacts = page.locator('#V-PopupsContacts');
	await expect(contacts.locator('.e-contact-item')).toContainText('Rae Doe');
	await expect(contacts.locator('.listEmptyList')).toBeHidden();
});

for (const appearance of ['light', 'dark']) {
	test(`Compose tabs and window buttons stay consistent in ${appearance} appearance`, async ({ authenticated }) => {
		const { page, actions } = authenticated;
		await authenticated.open({ appearance });
		await authenticated.openFolderNavigation();
		await page.locator('#V-MailFolderList .buttonCompose').click();

		const compose = page.locator('#V-PopupsCompose'),
			minimize = compose.getByRole('button', { name: 'Minimize', exact: true }),
			cancel = compose.getByRole('button', { name: 'Cancel', exact: true }),
			more = compose.locator('header button.dropdown-toggle'),
			bodyTab = compose.locator('label[for="tab-body"]'),
			attachmentsTab = compose.locator('label[for="tab-attachments"]');
		await expect(compose).toBeVisible();

		for (const viewport of [{ width: 1440, height: 900 }, { width: 320, height: 667 }]) {
			await page.setViewportSize(viewport);
			for (const direction of ['ltr', 'rtl']) {
				await page.locator('html').evaluate((root, value) => { root.dir = value; }, direction);
				const controls = await compose.locator('header .pull-right button[data-ui-icon]').evaluateAll(buttons => buttons.map(button => {
					const rect = button.getBoundingClientRect(), style = getComputedStyle(button),
						icon = getComputedStyle(button, '::before');
					return { x: rect.x, right: rect.right, y: rect.y, height: rect.height, width: rect.width,
						border: style.borderTopWidth, background: style.backgroundColor, iconWidth: icon.width,
						mask: icon.maskImage || icon.webkitMaskImage };
				}));
				expect(controls).toHaveLength(4);
				for (const control of controls) {
					expect(control.height).toBe(30);
					expect(control.width).toBe(controls[0].width);
					expect(control.y).toBe(controls[0].y);
					expect(control.border).toBe('1px');
					expect(control.background).toBe(controls[0].background);
					expect(control.iconWidth).toBe('16px');
					expect(control.x).toBeGreaterThanOrEqual(0);
					expect(control.right).toBeLessThanOrEqual(viewport.width);
				}
				const ordered = [...controls].sort((left, right) => left.x - right.x);
				for (let index = 1; index < ordered.length; index++) {
					expect(ordered[index - 1].right).toBeLessThanOrEqual(ordered[index].x);
				}
				expect(controls[2].mask).toContain('/images/ui-icons/minus.svg');
				expect(controls[3].mask).toContain('/images/ui-icons/x.svg');
			}
		}
		await page.locator('html').evaluate(root => { root.dir = 'ltr'; });

		for (const tab of [bodyTab, attachmentsTab]) {
			await tab.click();
			await expect(tab).toHaveCSS('background-color', appearance === 'dark' ? 'rgb(51, 51, 51)' : 'rgb(255, 255, 255)');
			await expect(tab).toHaveCSS('color', appearance === 'dark' ? 'rgb(255, 255, 255)' : 'rgb(51, 51, 51)');
		}
		await expect(compose.locator('#tab-attachments')).toBeChecked();
		await expect(compose.locator('.no-attachments-desc')).toBeVisible();
		await bodyTab.hover();
		await expect(bodyTab).toHaveCSS('border-top-color', appearance === 'dark' ? 'rgb(85, 85, 85)' : 'rgb(238, 238, 238)');
		await compose.locator('#composeUploadButton').focus();
		await page.keyboard.press('Tab');
		await expect(bodyTab).toBeFocused();
		if (appearance === 'dark') {
			await expect(bodyTab).toHaveCSS('outline-style', 'solid');
			await expect(bodyTab).toHaveCSS('outline-width', '2px');
		}

		const subject = compose.locator('input[name="subject"]');
		await subject.fill('Synthetic minimized message');
		await more.focus();
		await page.keyboard.press('Tab');
		await expect(minimize).toBeFocused();
		await expect(minimize).toHaveCSS('outline-style', 'solid');
		await minimize.press('Enter');
		await expect(compose).toBeHidden();
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.locator('#V-MailFolderList .buttonCompose').click();
		await expect(compose).toBeVisible();
		await expect(subject).toHaveValue('Synthetic minimized message');
		await subject.fill('');
		await cancel.press('Enter');
		await expect(compose).toBeHidden();
		expect(actions).not.toContain('SendEmail');
		expect(actions).not.toContain('SaveMessage');
	});
}

for (const appearance of ['light', 'dark']) {
	for (const multipleIdentities of [false, true]) {
		test(`Compose From field uses available width with ${multipleIdentities ? 'multiple identities' : 'one identity'} in ${appearance} appearance`, async ({ authenticated }, testInfo) => {
			const { page, actions } = authenticated,
				alias = {
					'@Object': 'Object/Identity', id: 'synthetic-alias', label: '', email: 'alias@example.test',
					name: 'Synthetic Sender With A Deliberately Long Display Name', replyTo: '', bcc: '', signature: '',
					signatureInsertBefore: false, sentFolder: '', pgpEncrypt: false, pgpSign: false,
					smimeKey: '', smimeCertificate: '', exists: true
				};
			await authenticated.open({ appearance, capabilities: { Identities: true }, additionalIdentities: multipleIdentities ? [alias] : [] });
			await authenticated.openFolderNavigation();
			await page.locator('#V-MailFolderList .buttonCompose').click();
			const compose = page.locator('#V-PopupsCompose'),
				from = compose.locator('input[data-bind="textInput: from"]'),
				toggle = compose.locator('#identity-toggle');
			await expect(from).toBeVisible();
			await expect(toggle).toHaveCount(multipleIdentities ? 1 : 0);
			await from.fill(`${alias.name} <${alias.email}>`);

			for (const width of [1440, 320]) {
				await page.setViewportSize({ width, height: 900 });
				for (const direction of ['ltr', 'rtl']) {
					await page.locator('html').evaluate((root, value) => { root.dir = value; }, direction);
					const geometry = await compose.locator('.b-header').evaluate(header => {
						const input = header.querySelector('input[data-bind="textInput: from"]'),
							bounds = element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, top: r.top, bottom: r.bottom }; };
						return { from: bounds(input), to: bounds(header.querySelector('.emailaddresses')),
							subject: bounds(header.querySelector('input[name="subject"]')), fontSize: parseFloat(getComputedStyle(input).fontSize),
							toggle: header.querySelector('#identity-toggle') ? bounds(header.querySelector('#identity-toggle')) : null };
					});
					for (const edge of ['left', 'right']) expect(Math.abs(geometry.to[edge] - geometry.subject[edge])).toBeLessThanOrEqual(1);
					const alignedEdge = direction === 'rtl' ? 'right' : 'left';
					expect(Math.abs(geometry.from[alignedEdge] - geometry.subject[alignedEdge])).toBeLessThanOrEqual(1);
					expect(Math.abs(geometry.subject.width - geometry.from.width - (multipleIdentities ? 2 * geometry.fontSize : 0))).toBeLessThanOrEqual(1);
					if (multipleIdentities) {
						expect(geometry.toggle.left).toBeGreaterThanOrEqual(geometry.subject.left);
						expect(geometry.toggle.right).toBeLessThanOrEqual(geometry.subject.right);
						expect(geometry.toggle.top).toBeGreaterThanOrEqual(geometry.from.top);
						expect(geometry.toggle.bottom).toBeLessThanOrEqual(geometry.from.bottom);
						if (direction === 'rtl') expect(geometry.toggle.right).toBeLessThanOrEqual(geometry.from.left);
						else expect(geometry.toggle.left).toBeGreaterThanOrEqual(geometry.from.right);
					}
					if (appearance === 'dark' && !multipleIdentities && direction === 'ltr' && testInfo.project.name === 'chromium') {
						await page.screenshot({ path: testInfo.outputPath(`compose-from-${width}.png`), clip: { x: 0, y: 0, width, height: 240 } });
					}
				}
			}
			if (multipleIdentities) {
				await from.press('Tab');
				await expect(toggle).toBeFocused();
				await expect(toggle).toHaveCSS('outline-style', 'solid');
				await toggle.press('Enter');
				await expect(toggle).toHaveAttribute('aria-expanded', 'true');
				await toggle.press('ArrowDown');
				const firstIdentity = compose.locator('menu[aria-labelledby="identity-toggle"] a').first();
				await expect(firstIdentity).toBeFocused();
				await firstIdentity.press('Enter');
				await expect(from).toHaveValue('Demo User <demo@example.test>');
				await expect(toggle).toHaveAttribute('aria-expanded', 'false');
			}
			expect(actions).not.toContain('SendEmail');
			expect(actions).not.toContain('SaveMessage');
		});
	}
}

for (const width of [1440, 320]) {
	for (const direction of ['ltr', 'rtl']) {
		test(`Compose sender identity menu preserves keyboard and pointer behavior at ${width}px ${direction}`, async ({ authenticated }) => {
			const { page } = authenticated,
				alias = {
					'@Object': 'Object/Identity', id: 'synthetic-alias', label: '', email: 'alias@example.test',
					name: 'Alternate Sender', replyTo: '', bcc: '', signature: '', signatureInsertBefore: false,
					sentFolder: '', pgpEncrypt: false, pgpSign: false,
					smimeKey: '', smimeCertificate: '', exists: true
				};
			await authenticated.open({ capabilities: { Identities: true }, additionalIdentities: [alias] });
			await authenticated.openFolderNavigation();
			await page.setViewportSize({ width, height: 900 });
			await page.locator('html').evaluate((root, value) => { root.dir = value; }, direction);
			await page.locator('#V-MailFolderList .buttonCompose').click();

			const compose = page.locator('#V-PopupsCompose'),
				from = compose.locator('input[data-bind="textInput: from"]'),
				to = compose.getByRole('row', { name: 'To' }).getByRole('combobox'),
				toggle = compose.locator('#identity-toggle'),
				menu = compose.locator('menu[aria-labelledby="identity-toggle"]'),
				options = menu.locator('a'),
				first = options.nth(0),
				second = options.nth(1);

			await expect(options).toHaveCount(2);
			await expect(toggle).toHaveAttribute('aria-haspopup', 'menu');
			await expect(menu).toHaveAttribute('role', 'menu');
			await expect(menu).toHaveAttribute('aria-labelledby', 'identity-toggle');
			await from.fill('Alternate Sender <alias@example.test>');
			await from.press('Tab');
			await expect(toggle).toBeFocused();
			await toggle.press('Enter');
			await expect(toggle).toHaveAttribute('aria-expanded', 'true');
			await expect(menu).toBeVisible();
			await expect(toggle).toBeFocused();

			await page.keyboard.press('ArrowDown');
			await expect(first).toBeFocused();
			await page.keyboard.press('ArrowDown');
			await expect(second).toBeFocused();
			await page.keyboard.press('ArrowUp');
			await expect(first).toBeFocused();
			await page.keyboard.press('Enter');
			await expect(from).toHaveValue('Demo User <demo@example.test>');
			await expect(toggle).toHaveAttribute('aria-expanded', 'false');
			await expect(toggle).toBeFocused();

			await page.keyboard.press('Enter');
			await expect(toggle).toHaveAttribute('aria-expanded', 'true');
			await page.keyboard.press('Escape');
			await expect(toggle).toHaveAttribute('aria-expanded', 'false');
			await expect(toggle).toBeFocused();

			await page.keyboard.press('Enter');
			await expect(toggle).toHaveAttribute('aria-expanded', 'true');
			await page.keyboard.press('Tab');
			await expect(menu).toBeFocused();
			await page.keyboard.press('Tab');
			await expect(menu).toBeHidden();
			await expect(to).toBeFocused();
			await expect(toggle).toHaveAttribute('aria-expanded', 'false');

			await toggle.click();
			await expect(menu).toBeVisible();
			await second.click();
			await expect(from).toHaveValue('Alternate Sender <alias@example.test>');
			await expect(toggle).toHaveAttribute('aria-expanded', 'false');
		});
	}
}
