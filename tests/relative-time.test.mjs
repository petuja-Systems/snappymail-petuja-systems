import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../dev/Common/RelativeTime.js', import.meta.url), 'utf8');
const { relativeTimeFallback } = await import(
	'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
);

test('relative-time fallback reads the nested long catalog format', () => {
	const data = {
		long: {
			day: {
				past: { one: 'one day ago', other: '{0} days ago' },
				future: { one: 'in one day', other: 'in {0} days' }
			}
		},
		plural: value => 1 === value ? 'one' : 'other'
	};

	assert.equal(relativeTimeFallback(data, -1, 'day'), 'one day ago');
	assert.equal(relativeTimeFallback(data, 3, 'day'), 'in 3 days');
});

test('relative-time fallback reads the flat catalog format', () => {
	const data = {
		day: {
			past: { one: 'one day ago', other: '{0} days ago' },
			future: 'in {0} days'
		},
		plural: value => 1 === value ? 'one' : 'other'
	};

	assert.equal(relativeTimeFallback(data, -1, 'day'), 'one day ago');
	assert.equal(relativeTimeFallback(data, 3, 'day'), 'in 3 days');
});

test('relative-time fallback handles nested catalogs with direct strings and no plural function', () => {
	const data = {
		long: {
			day: { past: '{0} napja', future: '{0} nap múlva' }
		}
	};

	assert.equal(relativeTimeFallback(data, -2, 'day'), '2 napja');
	assert.equal(relativeTimeFallback(data, 4, 'day'), '4 nap múlva');
});
