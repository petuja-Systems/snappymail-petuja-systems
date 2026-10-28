import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as base, expect } from '@playwright/test';
import { indexFixture } from './login-fixture.mjs';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const appRoot = path.join(repository, 'snappymail/v/0.0.0');
const origin = 'http://127.0.0.1:8791';

const emptyFolders = {
	'@Object': 'Collection/FolderCollection',
	'@Collection': [{
		'@Object': 'Object/Folder', name: 'INBOX', fullName: 'INBOX', delimiter: '',
		attributes: ['\\subscribed'], metadata: {}, uidNext: 1, totalEmails: 0,
		unreadEmails: 0, id: '', size: 0, role: 'inbox', etag: 'synthetic-inbox'
	}],
	quotaUsage: null, quotaLimit: null, namespace: '', namespaces: null, capabilities: []
};

const defaultAppData = ({ forcedTwoFactor = false, language = 'en', checkMailInterval = 60, minRefreshInterval = 5, appearance = 'light', contactsAllowed = true, capabilities = {}, title = 'petuja.email' } = {}) => ({
	Auth: true,
	title,
	language,
	clientLanguage: language,
	hourCycle: 'h23',
	loadingDescription: 'petuja.email',
	StaticLibsJs: '/static/js/min/libs.min.js',
	Email: 'demo@example.test',
	mainEmail: 'demo@example.test',
	accountHash: 'synthetic-account-hash',
	contactsAllowed,
	Appearance: appearance,
	ViewHTML: true,
	ViewImages: 'ask',
	ViewImagesWhitelist: '',
	Layout: 1,
	MessagesPerPage: 25,
	MessageReadDelay: 2,
	AutoLogout: 30,
	keyPassForget: 15,
	AllowDraftAutosave: false,
	ContactsAutosave: false,
	CheckMailInterval: checkMailInterval,
	minRefreshInterval,
	RequireTwoFactor: forcedTwoFactor,
	SetupTwoFactor: forcedTwoFactor,
	Capa: capabilities,
	System: {
		languages: ['en'], version: '0.0.0', webVersionPath: '/', token: 'synthetic-ui-token',
		folderSpecLimit: 50, allowAppendMessage: false, attachmentsActions: []
	}
});

const fixtureContact = (id = 1) => ({
	'@Object': 'Object/Contact', id, readOnly: false,
	jCard: ['vcard', [
		['version', {}, 'text', '4.0'],
		['n', {}, 'text', ['Doe', 'Rae', '', '', '']],
		['fn', {}, 'text', 'Rae Doe'],
		['email', { type: 'work' }, 'text', 'rae@example.test']
	]]
});

export const test = base.extend({
	authenticated: async ({ page, browserName }, use, testInfo) => {
		const consoleErrors = [], unexpectedRequests = [], unexpectedActions = [], actions = [], settingUpdates = [], appearanceUpdates = [];
		let appData, contacts, identities, failNextContacts = false, twoFactorState = 'missing';
		page.on('pageerror', error => consoleErrors.push(error.name));
		page.on('console', message => {
			if ('error' === message.type()) consoleErrors.push('console:error');
		});
		await page.addInitScript(() => {
			window.__authenticatedFixtureAlerts = [];
			window.alert = message => window.__authenticatedFixtureAlerts.push(String(message));
		});

		const fixture = {
			page,
			actions,
			settingUpdates,
			appearanceUpdates,
			async open({ forcedTwoFactor = false, initialContacts = [], additionalIdentities = [], language = 'en', checkMailInterval = 60, minRefreshInterval = 5, appearance = 'light', contactsAllowed = true, capabilities = {}, title = 'petuja.email' } = {}) {
				appData = defaultAppData({ forcedTwoFactor, language, checkMailInterval, minRefreshInterval, appearance, contactsAllowed, capabilities, title });
				contacts = structuredClone(initialContacts);
				identities = structuredClone(additionalIdentities);
				twoFactorState = forcedTwoFactor ? 'disabled' : 'missing';
				await page.route('**/*', async route => {
					const request = route.request(), url = new URL(request.url());
					if (url.origin !== origin) {
						unexpectedRequests.push(url.origin);
						return route.abort();
					}
					if ('/' === url.pathname && !url.search) {
						return route.fulfill({ contentType: 'text/html', body: await indexFixture(language, false) });
					}
					if ('/fixture-manifest.json' === url.pathname) {
						return route.fulfill({ json: { name: 'petuja.email authenticated UI fixture', start_url: '/', display: 'standalone' } });
					}
					if ('/' === url.pathname && /^\?\/AppData\//.test(url.search)) {
						return route.fulfill({ json: appData });
					}
					if ('/' === url.pathname && url.search.startsWith('?/Json')) {
						const data = request.postDataJSON(), action = data.Action;
						actions.push(action);
						if ('SettingsUpdate' === action && Object.hasOwn(data, 'CheckMailInterval')) {
							settingUpdates.push(data.CheckMailInterval);
							appData.CheckMailInterval = data.CheckMailInterval;
						}
						if ('SettingsUpdate' === action && Object.hasOwn(data, 'Appearance')) {
							appearanceUpdates.push(data.Appearance);
							appData.Appearance = data.Appearance;
						}
						if ('Contacts' === action && failNextContacts) {
							failNextContacts = false;
							return route.fulfill({ json: { Action: action, Result: false, code: 999, message: 'Synthetic contacts failure' } });
						}
						let result;
						switch (action) {
							case 'Folders': result = emptyFolders; break;
							case 'AccountsAndIdentities': result = {
								Accounts: [], Identities: [{
									'@Object': 'Object/Identity', id: '', label: '', email: 'demo@example.test',
									name: 'Demo User', replyTo: '', bcc: '', signature: '',
									signatureInsertBefore: false, sentFolder: '', pgpEncrypt: false,
									pgpSign: false, smimeKey: '', smimeCertificate: '', exists: true
								}, ...identities]
							}; break;
							case 'MessageList': result = {
								'@Object': 'Collection/MessageCollection', '@Collection': [], totalEmails: 0,
								totalThreads: null, threadUid: 0, newMessages: [], offset: 0,
								limit: 25, search: '', sort: '', limited: false,
								folder: { name: 'INBOX', uidNext: 1, etag: 'synthetic-inbox' }
							}; break;
							case 'SMimeGetCertificates': result = []; break;
							case 'FolderInformation': result = {
								name: 'INBOX', uidNext: 1, totalEmails: 0, unreadEmails: 0,
								etag: 'synthetic-inbox', newMessages: []
							}; break;
							case 'FolderInformationMultiply': result = []; break;
							case 'SystemFoldersUpdate': result = true; break;
							case 'AppDelayStart': result = true; break;
							case 'SettingsUpdate': result = true; break;
							case 'TwoFactorState': result = { Status: twoFactorState }; break;
							case 'TwoFactorSetup':
								twoFactorState = 'disabled';
								result = {
									Secret: 'SYNTHETIC-SECRET', QRCode: 'SYNTHETIC-QR-CODE',
									BackupCodes: 'SYNTHETIC-RECOVERY-CODE'
								};
								break;
							case 'Contacts': result = {
								Offset: data.Offset || 0, Limit: data.Limit || 50,
								Count: contacts.length, Search: data.Search || '', List: structuredClone(contacts)
							}; break;
							case 'ContactSave': {
								const saved = {
									'@Object': 'Object/Contact', id: 2, readOnly: false,
									jCard: JSON.parse(data.jCard)
								};
								contacts = [saved];
								result = { ResultID: saved.id, Result: true };
								break;
							}
							case 'ContactsDelete': contacts = []; result = true; break;
							default:
								unexpectedActions.push(action);
								result = false;
						}
						return route.fulfill({ json: { Action: action, Result: result } });
					}
					if (url.pathname.startsWith('/static/')) {
						const file = path.resolve(appRoot, '.' + decodeURIComponent(url.pathname));
						if (file.startsWith(path.join(appRoot, 'static') + path.sep)) {
							try { return await route.fulfill({ path: file }); } catch {}
						}
					}
					unexpectedRequests.push(url.pathname);
					return route.fulfill({ status: 404, body: 'Fixture resource missing' });
				});
				await page.goto(origin + '/');
				if (forcedTwoFactor) {
					await expect(page.locator('#V-Settings-Security')).toBeVisible();
				} else {
					await expect(page.locator('#V-MailFolderList')).toBeHidden();
					await expect(page.locator('#V-MailMessageList')).toBeVisible();
					await expect(page.locator('#V-MailMessageList .toggleLeft')).toBeVisible();
				}
			},
			async openFolderNavigation() {
				await page.locator('#V-MailMessageList .toggleLeft').click();
				await expect(page.locator('#V-MailFolderList')).toBeVisible();
			},
			failNextContactsRequest() { failNextContacts = true; }
		};

		try {
			await use(fixture);
			expect(consoleErrors, 'Browser runtime errors').toEqual([]);
			expect(unexpectedRequests, 'Unmocked or external requests').toEqual([]);
			expect(unexpectedActions, 'Unmocked application actions').toEqual([]);
		} finally {
			const diagnostics = testInfo.outputPath('authenticated-ui-network.json');
			await mkdir(path.dirname(diagnostics), { recursive: true });
			await writeFile(diagnostics, JSON.stringify({
				browserName, browserVersion: page.context().browser().version(),
				viewport: page.viewportSize(), actions, consoleErrors,
				unexpectedActions, unexpectedRequests
			}, null, 2));
			await testInfo.attach('authenticated-ui-network', { path: diagnostics, contentType: 'application/json' });
		}
	}
});

export { expect, fixtureContact };
