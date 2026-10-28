import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeHtml, signatureResult, popupResult } from './fixtures/message-html-boundary.mjs';

test('M7.7 plain signatures preserve full and short bare-address substitution', () => {
	assert.equal(signatureResult('{{FROM-FULL}} / {{FROM}}', 'robot@example.test').value,
		'robot@example.test / robot');
});

test('M7.7 plain signatures keep sender text unencoded', () => {
	const sender = 'Local <em>Sender</em> & "Name"';
	assert.deepEqual(signatureResult('Hello {{FROM-FULL}} / {{FROM}}', sender), {
		value: 'Hello ' + sender + ' / ' + sender, html: false, before: false
	});
});

test('M7.7 sender replacement and signature tokens remain literal data', () => {
	const sender = 'Local $& $1 ' + String.fromCharCode(36, 96) + " $' $$ {{FROM}} {{FROM-FULL}} {{DATE}} {{TIME}} {{MOMENT:LL}}";
	const result = signatureResult('{{DATE}} {{TIME}} {{FROM-FULL}} | {{FROM}}', sender);
	assert.equal(result.value, 'synthetic date synthetic time ' + sender + ' | ' + sender);
});

test('M7.7 missing sender cleanup and draft/edit exclusions stay unchanged', () => {
	assert.equal(signatureResult(':HTML:<p>Hello {{FROM}} {{FROM-FULL}} {{DATE}}</p>', null).value,
		'<p>Hello synthetic date</p>');
	for (const mode of ['draft', 'edit']) {
		assert.equal(signatureResult(':HTML:Keep {{FROM}}', 'Local Sender', mode), undefined);
	}
});

test('M7.7 nested attachment names and MIME URLs are encoded in popup contexts', () => {
	const name = 'Local <b>Invoice & receipt</b> "copy".txt';
	const url = 'data:text/plain;name="local";base64,SGVsbG8=';
	const result = popupResult(name, url);
	assert.ok(result.closed);
	assert.equal(result.printed, 0);
	assert.ok(result.html.includes('<a href="' + encodeHtml(url) + '">' + encodeHtml(name) + '</a>'));
	assert.doesNotMatch(result.html, /<b>Invoice/);
});

test('M7.7 print uses the same encoded attachment boundary', () => {
	const name = 'Local <strong>statement</strong>.txt';
	const result = popupResult(name, 'data:text/plain;base64,SGVsbG8=', true);
	assert.equal(result.printed, 1);
	assert.ok(result.closed);
	assert.ok(result.html.includes(encodeHtml(name)));
	assert.doesNotMatch(result.html, /<strong>statement/);
});
