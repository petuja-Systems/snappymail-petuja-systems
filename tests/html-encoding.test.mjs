import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../dev/Common/HtmlEncoding.js', import.meta.url), 'utf8');
const { encodeHtml, interpolateHtml } = await import(
	'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
);

test('trusted translation markup remains while dynamic markup is encoded', () => {
	const template = 'Domain <strong>%NAME%</strong><br> is ready.';
	const hostile = '</strong><img src=x onerror=alert(1)><strong>';
	const result = interpolateHtml(template, { NAME: hostile });

	assert.equal(
		result,
		'Domain <strong>&lt;/strong&gt;&lt;img src=x onerror=alert(1)&gt;&lt;strong&gt;</strong><br> is ready.'
	);
	assert.match(result, /<strong>/);
	assert.match(result, /<br>/);
	assert.doesNotMatch(result, /<img\b/i);
	assert.doesNotMatch(result, /<script\b/i);
});

test('script, image, quotes, angle brackets, and ampersands remain text', () => {
	const hostile = `<script>alert(1)</script> <img src=x onerror=alert(1)> "quoted" 'single' & < >`;
	const result = interpolateHtml('<b>%VALUE%</b>', { VALUE: hostile });

	assert.equal(
		result,
		'<b>&lt;script&gt;alert(1)&lt;/script&gt; &lt;img src=x onerror=alert(1)&gt; &quot;quoted&quot; &#x27;single&#x27; &amp; &lt; &gt;</b>'
	);
	assert.doesNotMatch(result, /<script\b|<img\b/i);

	const closingTagInjection = interpolateHtml('<strong>%VALUE%</strong>', {
		VALUE: '"</strong><img src=x>'
	});
	assert.equal(closingTagInjection, '<strong>&quot;&lt;/strong&gt;&lt;img src=x&gt;</strong>');
	assert.doesNotMatch(closingTagInjection, /<img\b/i);
});

test('replacement values are literal, including dollar replacement tokens', () => {
	assert.equal(
		interpolateHtml('<strong>%VALUE%</strong>', { VALUE: "$& $1 $` $' $$" }),
		'<strong>$&amp; $1 $` $&#x27; $$</strong>'
	);
});

test('Unicode, internationalized values, and nullish values keep predictable output', () => {
	assert.equal(
		interpolateHtml('%FOLDER% | %DOMAIN% | %EMAIL%', {
			FOLDER: '郵便 📬 & Bücher',
			DOMAIN: 'münich.example',
			EMAIL: 'δοκιμή@example.test'
		}),
		'郵便 📬 &amp; Bücher | münich.example | δοκιμή@example.test'
	);
	assert.equal(encodeHtml(null), 'null');
	assert.equal(encodeHtml(undefined), 'undefined');
	assert.equal(interpolateHtml('%NULL%/%UNDEFINED%', { NULL: null, UNDEFINED: undefined }), 'null/undefined');
});
