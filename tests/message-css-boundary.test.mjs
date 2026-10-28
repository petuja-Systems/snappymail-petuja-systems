import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../dev/Common/Html.js', import.meta.url), 'utf8');
const start = source.indexOf('\tsafeStyleProperties = new Set(');
const end = source.indexOf('\nexport const', start);
assert.ok(start >= 0 && end > start, 'application CSS property filter must exist');
const cleanStyle = vm.runInNewContext('const ' + source.slice(start, end) + '\ncleanStyle;');

// An array-like declaration fixture tests the application property decision only.
// Native CSS parsing and DOM/network behavior belong to the conditional browser spec.
function filtered(entries) {
	const remaining = new Map(entries);
	const declaration = Object.assign(Object.keys(Object.fromEntries(entries)), {
		removeProperty: name => remaining.delete(name)
	});
	cleanStyle(declaration);
	return Object.fromEntries(remaining);
}

test('M7-F1 preserves ordinary inline formatting declarations', () => {
	const entries = [
		['color', 'navy'], ['background-color', '#fff'], ['font-family', 'serif'],
		['font-size', '16px'], ['font-weight', 'bold'], ['text-align', 'center'],
		['text-decoration', 'underline'], ['line-height', '1.5'], ['margin', '4px'],
		['padding', '8px'], ['border', '1px solid black'], ['border-radius', '2px'],
		['border-collapse', 'collapse'], ['width', '80%'], ['max-width', '600px'],
		['vertical-align', 'top'], ['display', 'block']
	];
	assert.deepEqual(filtered(entries), Object.fromEntries(entries));
});

test('M7-F1 drops resource properties regardless of their declaration values', () => {
	const properties = [
		'background', 'background-image', 'border-image', 'border-image-source',
		'list-style', 'list-style-type', 'list-style-image', 'mask', 'mask-image',
		'content', 'cursor', 'filter', 'backdrop-filter', 'clip-path', 'shape-outside',
		'offset-path', 'fill', 'stroke', '-webkit-mask-image', '--local-image',
		'unknown-future-property', 'behavior', '-ms-behavior'
	];
	const values = [
		'url("http://127.0.0.1:8788/fixture-image/css.png")',
		'image-set("http://127.0.0.1:8788/fixture-image/css.png" 1x)',
		'url("data:image/png;base64,AA=="), url("http://127.0.0.1:8788/fixture-image/css.png")',
		'url("cid:known")', 'var(--local-image)', 'none'
	];
	for (const value of values) {
		assert.deepEqual(filtered(properties.map(property => [property, value])), {});
	}
});

test('M7-F1 retains established white-space/min-width/vendor exclusions and filters every node', () => {
	assert.deepEqual(filtered([
		['white-space', 'nowrap'], ['min-width', '2000px'], ['position', 'fixed'],
		['z-index', '999'], ['-moz-binding', 'none'], ['display', 'none']
	]), { display: 'none' });
	assert.equal((source.match(/cleanStyle\(oStyle\)/g) || []).length, 1);
	assert.doesNotMatch(source, /skipStyle|parseCSS|data-x-style-url|backgroundImage\s*=/);
	assert.match(source, /cleanStyle\(oStyle\);\s*\/\/[^\n]+\n\s*if \(SettingsUserStore.removeColors\(\)\)/);
});

test('M7-F1 rejects stylesheet tags, legacy background attributes and sender classes', () => {
	const tags = source.match(/allowedTags = \[([\s\S]*?)\]\.join\(','\)/);
	const attributes = source.match(/allowedAttributes = \[([\s\S]*?)\];/);
	assert.ok(tags && attributes);
	assert.ok(!vm.runInNewContext('[' + tags[1] + ']').includes('style'));
	const allowedAttributes = vm.runInNewContext('[' + attributes[1] + ']');
	assert.ok(!allowedAttributes.includes('background'));
	assert.ok(!allowedAttributes.includes('class'));
	assert.doesNotMatch(source, /allowStyles|allowedAttributes\.push\('class'\)/);
});

test('M7-F1 removes CSS restoration and obsolete client setting, preserving legacy server setting API', async () => {
	for (const path of ['dev/Model/Message.js', 'dev/Settings/User/General.js',
		'dev/Stores/User/Settings.js', 'snappymail/v/0.0.0/app/templates/Views/User/SettingsGeneral.html']) {
		const text = await readFile(new URL('../' + path, import.meta.url), 'utf8');
		assert.doesNotMatch(text, /data-x-style-url|xStyleUrl|[Aa]llowStyles|ALLOW_STYLES/);
	}
	const library = '../snappymail/v/0.0.0/app/libraries/RainLoop/';
	const settings = await readFile(new URL(library + 'Actions/User.php', import.meta.url), 'utf8');
	const appData = await readFile(new URL(library + 'Actions.php', import.meta.url), 'utf8');
	assert.match(settings, /AllowStyles/);
	assert.match(appData, /AllowStyles/);
	// Ordinary received IMG and the shared editor sanitizer retain their original entry points.
	assert.match(source, /setAttribute\('data-x-src', src\)/);
	assert.match(source, /delAttribute\('srcset'\)/);
	assert.match(source, /delAttribute\('sizes'\)/);
});
