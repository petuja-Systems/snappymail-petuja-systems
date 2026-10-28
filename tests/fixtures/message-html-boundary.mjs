import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const compose = (await readFile(new URL('../../dev/View/Popup/Compose.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const message = (await readFile(new URL('../../dev/Model/Message.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const encoding = (await readFile(new URL('../../dev/Common/HtmlEncoding.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
export const { encodeHtml } = await import('data:text/javascript;base64,' + Buffer.from(encoding).toString('base64'));

function method(source, start, end) {
	const first = source.indexOf(start), last = source.indexOf(end, first);
	if (first < 0 || last < first) throw new Error('Expected application method was not found');
	return source.slice(first, last).trim();
}

export const signatureMethod = method(compose, '\tsetSignature(identity, msgComposeType) {', '\n\t/**');
const popupMethod = method(message, '\tpopupMessage(print) {', '\n\tprintMessage()');
export const showImagesMethod = method(message, '\tshowExternalImages(regex) {', '\n\t/**');

const helper = compose.match(/emailArrayToStringLineHelper = ([\s\S]+?),\n\n\treloadDraftFolder/);
if (!helper) throw new Error('Expected sender formatter was not found');
export const senderFormatterSource = helper[1];
const senderFormatter = vm.runInNewContext('(' + senderFormatterSource + ')');

export function signatureResult(template, sender, mode = 'reply', insertBefore = false) {
	let captured;
	const setSignature = vm.runInNewContext('({' + signatureMethod + '}).setSignature', {
		ComposeType: { Draft: 'draft', EditAsNew: 'edit' },
		oLastMessage: sender === null ? null : { from: [
			{ email: 'synthetic@example.test', toLine: () => sender }
		] },
		emailArrayToStringLineHelper: senderFormatter,
		encodeHtml,
		Date: class { format(options) { return typeof options === 'object' ? 'synthetic date' : 'synthetic time'; } }
	});
	setSignature.call({ editor: callback => callback({
		setSignature: (value, html, before) => { captured = { value, html, before }; }
	}) }, { signature: () => template, signatureInsertBefore: () => insertBefore }, mode);
	return captured;
}

export function popupResult(fileName, url, print = false) {
	let html = '', printed = 0, closed = false;
	const popupMessage = vm.runInNewContext('({' + popupMethod + '}).popupMessage', {
		encodeHtml, i18n: value => value,
		SettingsUserStore: { messageNewWindow: () => false },
		getComputedStyle: () => ({ getPropertyValue: () => 'black' }),
		doc: { querySelector: () => ({}) },
		PreviewHTML: '<!doctype html><html><head><title></title></head><body></body></html>',
		open: () => ({
			document: { write: value => { html += value; }, close: () => { closed = true; } },
			print: () => { printed++; }
		}),
		setTimeout: callback => callback()
	});
	popupMessage.call({
		dateTimestamp: () => 0, cc: [], bcc: [], to: [], from: [],
		requestHash: 'synthetic-message', subject: () => 'Synthetic message',
		isHtml: () => true, bodyAsHTML: () => '<p>Synthetic body</p>',
		attachments: [{ fileName, linkDownload: () => url }]
	}, print);
	return { html, printed, closed };
}
