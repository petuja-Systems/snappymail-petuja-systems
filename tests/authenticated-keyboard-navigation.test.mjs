import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
	read = relative => readFile(path.join(root, relative), 'utf8'),
	[folderLogic, folderModel, messageListLogic, messageViewLogic, systemLogic, askLogic, helpLogic, globals, koBindings, userKoBindings, bootstrapDropdown,
		folderTemplate, messageListTemplate, messageViewTemplate, accountTemplate, composeTemplate, paginatorTemplate,
		contactsTemplate, folderClearTemplate, appearanceStyles, layoutStyles, messageViewStyles, messageListStyles,
		systemStyles, attachmentsStyles, contactsStyles, contactsLogic, composeLogic, folderClearLogic] = await Promise.all([
		read('dev/View/User/MailBox/FolderList.js'),
		read('dev/Model/FolderCollection.js'),
		read('dev/View/User/MailBox/MessageList.js'),
		read('dev/View/User/MailBox/MessageView.js'),
		read('dev/View/User/SystemDropDown.js'),
		read('dev/View/Popup/Ask.js'),
		read('dev/View/Popup/KeyboardShortcutsHelp.js'),
		read('dev/Common/Globals.js'),
		read('dev/External/ko.js'),
		read('dev/External/User/ko.js'),
		read('vendors/bootstrap/js/bootstrap.native.js'),
		read('snappymail/v/0.0.0/app/templates/Views/User/MailFolderList.html'),
		read('snappymail/v/0.0.0/app/templates/Views/User/MailMessageList.html'),
		read('snappymail/v/0.0.0/app/templates/Views/User/MailMessageView.html'),
		read('snappymail/v/0.0.0/app/templates/Views/User/SystemDropDown.html'),
		read('snappymail/v/0.0.0/app/templates/Views/User/PopupsCompose.html'),
		read('snappymail/v/0.0.0/app/templates/Views/Common/Paginator.html'),
		read('snappymail/v/0.0.0/app/templates/Views/User/PopupsContacts.html'),
		read('snappymail/v/0.0.0/app/templates/Views/User/PopupsFolderClear.html'),
		read('dev/Styles/Appearance.less'),
		read('dev/Styles/User/Layout.less'),
		read('dev/Styles/User/MessageView.less'),
		read('dev/Styles/User/MessageList.less'),
		read('dev/Styles/User/SystemDropDown.less'),
		read('dev/Styles/User/Attachments.less'),
		read('dev/Styles/User/Contacts.less'),
		read('dev/View/Popup/Contacts.js'),
		read('dev/View/Popup/Compose.js'),
		read('dev/View/Popup/FolderClear.js')
	]);

const uncomment = source => source
	.replace(/\/\*[\s\S]*?\*\//g, '')
	.replace(/^\s*\/\/.*$/gm, '');

const elementsWithClass = (source, className) => [...source.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*)>/gi)]
	.filter(([, , attributes]) => (attributes.match(/\bclass="([^"]*)"/)?.[1] || '').split(/\s+/).includes(className));

const assertNativeAction = (source, className, action) => {
	const controls = elementsWithClass(source, className)
		.filter(([, , attributes]) => new RegExp(`data-bind="[^"]*\\b${action}\\b`).test(attributes));
	assert.ok(controls.length, `expected .${className} control`);
	for (const [tag, name, attributes] of controls) {
		assert.equal(name.toLowerCase(), 'button', `.${className} must use native button semantics`);
		assert.match(attributes, /\btype="button"/, `.${className} must not submit an enclosing form`);
		assert.match(attributes, new RegExp(`data-bind="[^"]*\\b${action}\\b`), `.${className} must keep its ${action} action`);
	}
	return controls;
};

test('mailbox Tab and Shift+Tab remain native while arrow navigation remains available', () => {
	for (const source of [folderLogic, messageListLogic, messageViewLogic, askLogic, helpLogic]) {
		assert.doesNotMatch(uncomment(source), /(?:addShortcut|shortcuts\.add)\(\s*['"][^'"]*\btab\b/i);
	}
	assert.match(folderLogic, /addShortcut\('arrowup,arrowdown'/);
	assert.match(folderLogic, /addShortcut\('arrowright'/);
	assert.match(messageListLogic, /addShortcut\('arrowleft'/);
	assert.match(messageListLogic, /addShortcut\('arrowright'/);
	assert.match(messageViewLogic, /addShortcut\('arrowleft'/);
});

test('focus entering each mailbox pane synchronizes its shortcut scope', () => {
	assert.match(folderLogic, /addEventListener\('focusin',[\s\S]*?focusedState\(ScopeFolderList\)/);
	assert.match(messageListLogic, /addEventListener\('focusin',[\s\S]*?focusedState\(ScopeMessageList\)/);
	assert.match(messageViewLogic, /addEventListener\('focusin',[\s\S]*?focusedState\(ScopeMessageView\)/);
	assert.match(messageViewLogic, /ScopeMessageView === value && !dom\.contains\(doc\.activeElement\)/);
	assert.match(systemLogic, /focusedState\('none'\);\s*keyScope\('all'\)/);
	assert.match(messageListTemplate, /class="b-content" tabindex="0"/);
});

test('folder, mailbox toolbar, search, and paginator controls use native focusable elements', () => {
	assert.match(folderTemplate, /<button type="button" class="btn buttonCompose"/);
	assert.doesNotMatch(folderTemplate, /buttonContacts|contactsClick/);
	assert.doesNotMatch(uncomment(folderLogic), /contactsClick|ContactsPopupView/);
	assert.match(accountTemplate, /<li role="presentation" data-bind="visible: allowContacts">\s*<a[^>]*data-bind="click: contactsClick"/);
	assert.match(folderTemplate, /'data-unread': unreadCount, href: href/);
	assert.match(folderModel, /href: \(\) => this\.selectable\(\) && mailBox\(this\.fullNameHash\)/);
	assert.match(folderTemplate, /<input type="search" id="folderSearchInput"/);
	assert.match(folderTemplate, /<button type="button" class="e-checkbox" role="checkbox"/);
	assert.match(folderTemplate, /aria-checked/);
	assert.match(folderTemplate, /<button type="button" class="btn ui-icon toggleLeft"/);
	assert.match(folderTemplate, /click: createFolder/);
	assert.match(folderTemplate, /click: configureFolders/);

	for (const className of ['toggleLeft', 'buttonCompose', 'onCheckedHide', 'checkboxCheckAll', 'closeSearch', 'buttonMoreSearch']) {
		assert.match(messageListTemplate, new RegExp(`<button[^>]*class="[^"]*${className}`));
	}
	assert.match(messageListTemplate, /<button[^>]*id="more-list-dropdown-id"/);
	assert.match(messageListTemplate, /<button[^>]*id="sort-list-dropdown-id"/);
	assert.match(messageListTemplate, /<input type="search" class="inputSearch"(?![^>]*tabindex="-1")/);
	assert.match(messageListTemplate, /class="b-content" tabindex="0"/);
	assert.match(paginatorTemplate, /<button type="button"/);
	assert.match(messageListLogic, /\.e-paginator button/);
	assert.match(contactsLogic, /\.e-paginator button/);
});

test('account and Compose primary actions are keyboard reachable', () => {
	assert.match(accountTemplate, /<button[^>]*id="top-system-dropdown-id"/);
	assert.doesNotMatch(accountTemplate.match(/<button[^>]*id="top-system-dropdown-id"[^>]*>/)?.[0] || '', /tabindex="-1"/);
	assert.match(accountTemplate, /role="menu"/);
	assert.match(accountTemplate, /class="email-title" href="#" tabindex="-1"/);

	for (const binding of ['sendCommand', 'saveCommand', 'deleteCommand', 'contactsCommand', 'toggle: showBcc', 'toggle: showCc', 'toggle: doSign', 'toggle: doEncrypt']) {
		assert.match(composeTemplate, new RegExp(`<button[^>]*data-bind="[^"]*${binding.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
	}
	for (const control of ['dropdown-toggle ui-icon', 'identity-toggle', 'composeUploadButton', 'button-minimize', 'button-close']) {
		assert.match(composeTemplate, new RegExp(`<button[^>]*${control.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
	}
	assert.match(composeTemplate, /href="#" tabindex="-1" role="menuitemcheckbox"/);
	assert.match(composeTemplate, /aria-expanded|aria-haspopup="menu"/);
	assert.match(messageViewTemplate, /<button[^>]*id="more-view-dropdown-id"/);
	assert.match(messageViewTemplate, /<button[^>]*id="tags-dropdown-id"/);
});

test('message-reading actions are native buttons with state and accessible names', () => {
	const info = assertNativeAction(messageViewTemplate, 'infoParent', 'toggleFullInfo')[0][2];
	assert.match(info, /data-i18n="\[title\]MESSAGE\/MENU_HEADERS"/);
	assert.match(info, /aria-controls="message-information-full"/);
	assert.match(info, /aria-expanded/);
	assert.match(messageViewTemplate, /id="message-information-full"[^>]*data-bind="visible: showFullInfo/);

	assertNativeAction(messageViewTemplate, 'readReceipt', 'readReceipt');
	assert.match(elementsWithClass(messageViewTemplate, 'readReceipt')[0][2], /data-i18n="MESSAGE\/BUTTON_NOTIFY_READ_RECEIPT"/);

	const attachmentButtons = assertNativeAction(messageViewTemplate, 'checkboxAttachment', 'toggleChecked');
	assert.equal(attachmentButtons.length, 2, 'both attachment layouts must be keyboard operable');
	for (const [, , attributes] of attachmentButtons) {
		assert.match(attributes, /'aria-label': fileName(?=\s*[,}])/);
		assert.match(attributes, /'aria-pressed': checked\(\)/);
	}

	assertNativeAction(messageViewTemplate, 'controls-handle', 'toggleAttachmentControls');
	assert.match(elementsWithClass(messageViewTemplate, 'controls-handle')[0][2], /data-i18n="\[title\]TITLES\/SETTINGS"/);
	assert.match(elementsWithClass(messageViewTemplate, 'controls-handle')[0][2], /aria-controls="message-attachments-controls"/);
	assert.match(elementsWithClass(messageViewTemplate, 'controls-handle')[0][2], /aria-expanded/);
	assertNativeAction(messageViewTemplate, 'g-ui-link', 'downloadAsZip');
	assertNativeAction(messageViewTemplate, 'btn', 'showImages');
	assertNativeAction(messageViewTemplate, 'btn', 'showTracking');

	const whitelist = elementsWithClass(messageViewTemplate, 'dropdown-toggle').find(([, , attributes]) => /whitelist-dropdown-id/.test(attributes));
	assert.ok(whitelist, 'image whitelist menu trigger must exist');
	assert.equal(whitelist[1].toLowerCase(), 'button');
	assert.match(whitelist[2], /type="button"/);
	assert.match(whitelist[2], /aria-haspopup="menu"/);
	assert.doesNotMatch(whitelist[2], /tabindex="-1"/);
});

test('message list, system, contacts, and clear-folder actions are native buttons', () => {
	assertNativeAction(messageListTemplate, 'listThreadUidDesc', 'cancelThreadUid');
	assertNativeAction(messageListTemplate, 'groupLabel', 'groupSearch');

	const audio = assertNativeAction(accountTemplate, 'audioPlace', 'stopPlay')[0][2];
	assert.match(audio, /data-i18n="\[aria-label\]GLOBAL\/CANCEL"/);
	assert.match(audio, /title: currentAudio/);

	assertNativeAction(contactsTemplate, 'btn', 'newContact');
	assertNativeAction(contactsTemplate, 'btn-success', 'newMessageCommand');
	assertNativeAction(contactsTemplate, 'ui-icon', 'deleteCommand');
	assertNativeAction(contactsTemplate, 'g-ui-link', 'clearSearch');
	assert.match(elementsWithClass(contactsTemplate, 'g-ui-link')[0][2], /data-i18n="CONTACTS\/CLEAR_SEARCH"/);
	assertNativeAction(folderClearTemplate, 'btn-danger', 'clearCommand');
});

test('interactive controls suppress character shortcuts and native toggle buttons activate once', () => {
	assert.match(globals, /input,textarea,select,button,a\[href\].*contenteditable/s);
	assert.match(globals, /formFieldFocused\(\) \? true : method\(event\)/);
	assert.match(messageListLogic, /doc\.activeElement\?\.matches\('\.inputSearch'\)/);
	assert.match(koBindings, /' ' == event\.key && !element\.matches\('button'\)/);
	assert.match(koBindings, /event\.preventDefault\(\);\s*fn\(\);/);
});

test('dropdown descendants keep the existing roving-focus contract', () => {
	assert.match(bootstrapDropdown, /querySelectorAll\('A'\)/);
	assert.match(bootstrapDropdown, /ArrowUp|ArrowDown/);
	assert.match(bootstrapDropdown, /Escape/);
	assert.match(userKoBindings, /element\.addEventListener\('keydown', closeOnEscape\)/);
	assert.match(userKoBindings, /toggleButton\.open && 'Escape' === event\.key/);
	assert.match(userKoBindings, /event\.stopPropagation\(\);\s*element\.ddBtn\.hide\(\)/);
	assert.match(userKoBindings, /doc\.addEventListener\('focusin', closeOnFocusLeave\)/);
	assert.match(userKoBindings, /toggleButton\.open &&/);
	assert.match(userKoBindings, /nextTarget\?\.nodeType === 1/);
	assert.match(userKoBindings, /element\.ddBtn\.hide\(\)/);
	assert.match(userKoBindings, /nextTarget\.focus\?\.\(\)/);
	assert.match(accountTemplate, /<menu[^>]*tabindex="-1"[^>]*role="menu"/);
	assert.match(composeTemplate, /<menu[^>]*role="menu"/);
	assert.match(composeTemplate, /<a href="#" tabindex="-1" role="menuitemcheckbox"/);
});

test('keyboard dropdown closes resynchronize menu shortcut scope', () => {
	assert.match(userKoBindings, /syncDropdownVisibility = \(\) => dropdownVisibility\(!!dropdowns\.find\(item => item\.classList\.contains\('show'\)\)\)/);
	assert.match(userKoBindings, /closeOnEscape = event => \{[\s\S]*?element\.ddBtn\.hide\(\);\s*syncDropdownVisibility\(\);/);
	assert.match(userKoBindings, /closeOnFocusLeave = event => \{[\s\S]*?element\.ddBtn\.hide\(\);\s*syncDropdownVisibility\(\);\s*nextTarget\.focus\?\.\(\);/);
});

test('destructive shortcuts preserve selection, capability, and in-flight command guards', () => {
	assert.match(messageListLogic, /deleteCommand: \(\) => MessagelistUserStore\.hasCheckedOrSelectedAndUndeleted\(\)/);
	assert.match(messageListLogic, /deleteWithoutMoveCommand: canBeMovedHelper/);
	assert.match(messageListLogic, /archiveCommand: canBeMovedHelper/);
	assert.match(messageListLogic, /spamCommand: canBeMovedHelper/);
	assert.match(messageListLogic, /MessagelistUserStore\.listCheckedOrSelected\(\)\.length && this\.deleteCommand\(\)/);
	assert.match(messageListLogic, /deleteWithoutMoveCommand\(\)\s*\{\s*SettingsCapa\('DangerousActions'\)/);
	assert.match(messageListLogic, /clear\(\)\s*\{\s*SettingsCapa\('DangerousActions'\)\s*&& showScreenPopup\(FolderClearPopupView/);
	assert.match(folderClearLogic, /clearCommand: self => !self\.clearing\(\)/);
	assert.match(messageViewLogic, /fCanExecute\(\) && fExecute\.call\(null\)/);
	assert.match(messageViewLogic, /addShortcut\('delete',[\s\S]*?if \(!formFieldFocused\(\)\)/);
	assert.match(composeLogic, /canBeSentOrSaved: \(\) => !this\.sending\(\) && !this\.saving\(\)/);
	assert.match(composeLogic, /sendCommand: self => self\.canBeSentOrSaved\(\)/);
	assert.match(composeLogic, /addShortcut\('enter', 'meta', ScopeCompose, \(\) => \{[\s\S]*?this\.sendCommand\(\)/);
	assert.match(composeTemplate, /<button type="button"[^>]*data-bind="[^"]*sendCommand/);
	assert.match(systemLogic, /if \(email && 0 === event\.button && AccountUserStore\.email\(\) != email\)/);
	assert.match(accountTemplate, /data-bind="click: logoutClick"/);
});

test('focus-visible styling covers the shell and excludes arbitrary message body content', () => {
	for (const rootSelector of ['#V-MailFolderList', '#V-MailMessageList', '#V-SystemDropDown']) {
		assert.ok(appearanceStyles.includes(`${rootSelector} :focus-visible`));
	}
	assert.ok(appearanceStyles.includes('#V-PopupsCompose header :focus-visible'));
	assert.ok(appearanceStyles.includes('#V-PopupsCompose .b-header :focus-visible'));
	assert.ok(appearanceStyles.includes('#V-MailMessageView .top-toolbar :focus-visible'));
	assert.ok(appearanceStyles.includes('#V-MailMessageView .messageTags :focus-visible'));
	assert.ok(appearanceStyles.includes('#V-PopupsContacts :focus-visible'));
	assert.ok(appearanceStyles.includes('#V-PopupsFolderClear :focus-visible'));
	for (const selector of [
		'#V-MailMessageView #messageItem .bodySubHeader > :focus-visible',
		'#V-MailMessageView #messageItem .attachmentsPlace > summary:focus-visible',
		'#V-MailMessageView #messageItem .attachmentsPlace .checkboxAttachment:focus-visible',
		'#V-MailMessageView #messageItem > .btn-toolbar :focus-visible'
	]) {
		assert.ok(appearanceStyles.includes(selector), `missing scoped focus style: ${selector}`);
	}
	assert.match(appearanceStyles, /outline: 2px solid var\(--appearance-link/);
	assert.doesNotMatch(appearanceStyles, /#V-MailMessageView\s+:focus-visible/);
	assert.doesNotMatch(appearanceStyles, /#V-PopupsCompose\s+:focus-visible/);
	assert.match(layoutStyles, /\.e-paginator\s*\{[\s\S]*?button\s*\{/);
	assert.match(messageViewStyles, /\.infoParent\s*\{[\s\S]*?appearance:\s*none/);
	assert.match(messageListStyles, /\.listThreadUidDesc\s*\{[\s\S]*?appearance:\s*none/);
	assert.match(systemStyles, /\.audioPlace\s*\{[\s\S]*?appearance:\s*none/);
	assert.match(attachmentsStyles, /\.checkboxAttachment\s*\{[\s\S]*?appearance:\s*none/);
	assert.match(contactsStyles, /button\.g-ui-link\s*\{[\s\S]*?appearance:\s*none/);
});
