import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const fixture = fileURLToPath(new URL('./fixtures/contacts-csv.php', import.meta.url));
const decode = value => Buffer.from(value, 'base64').toString('utf8');
const headers = ['Title', 'First Name', 'Middle Name', 'Last Name', 'Nick Name', 'Display Name',
	'Company', 'Department', 'Job Title', 'Office Location', 'E-mail Address', 'Notes', 'Web Page', 'Birthday',
	'Mobile Phone', 'Home Email', 'Home Phone', 'Home Street', 'Home City', 'Home State', 'Home Postal Code',
	'Home Country', 'Business Email', 'Business Phone', 'Business Street', 'Business City', 'Business State',
	'Business Postal Code', 'Business Country'];

function exportCases(cases) {
	const result = spawnSync(process.env.PHP_BINARY || 'php', [
		'-d', 'display_errors=stderr', '-d', 'error_reporting=24575', fixture
	], { input: JSON.stringify(cases), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stderr, '');
	return JSON.parse(result.stdout).map(item => ({ ...item, rows: item.rows.map(row => row.map(decode)) }));
}

function standardRows(encoded) {
	const result = spawnSync(process.env.PYTHON || 'python3', ['-c',
		'import base64,csv,io,json,sys; print(json.dumps(list(csv.reader(io.StringIO(base64.b64decode(sys.stdin.read()).decode("utf-8"), newline=""), strict=True))))'
	], { input: encoded, encoding: 'utf8' });
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout);
}

test('Contacts CSV marks every contact-derived formula-looking cell as text after standard CSV parsing', () => {
	for (const result of exportCases(['=1+1', '+1', '-1', '@name'].map(value => ({ value })))) {
		assert.deepEqual(result.rows[0], headers);
		assert.equal(result.rows.length, 2);
		assert.equal(result.rows[1].length, 29);
		for (let index = 0; index < 29; index++) {
			if ([7, 8, 9].includes(index)) assert.equal(result.rows[1][index], '');
			else assert.equal(result.rows[1][index][0], "'", headers[index]);
		}
		assert.deepEqual(standardRows(result.csv), result.rows);
		assert.equal(result.unchanged, true);
	}
});

test('Contacts CSV handles ASCII and Unicode prefix classes without mutating vCards', () => {
	const prefixes = ['', ...Array.from({ length: 33 }, (_, index) => String.fromCodePoint(index)),
		'\x7f', ...Array.from({ length: 33 }, (_, index) => String.fromCodePoint(0x80 + index)),
		'\u1680', '\u180e', '\u2000', '\u2003', '\u200b', '\u200e', '\u2028', '\u2029', '\u202f',
		'\u205f', '\u2060', '\u3000', '\ufeff', ' \t\ufeff\u200b'];
	const cases = prefixes.flatMap(prefix => ['=1+1', '+1', '-1', '@name'].map(marker => ({ value: prefix + marker })));
	for (const result of exportCases(cases)) {
		assert.equal(result.rows.length, 2);
		assert.equal(result.rows[1].length, 29);
		assert.equal(result.rows[1][0], "'" + decode(result.original.fn));
		assert.equal(result.rows[1][11], "'" + decode(result.original.note));
		for (const column of [17, 24]) assert.equal(result.rows[1][column][0], "'", headers[column]);
		assert.equal(result.unchanged, true);
	}
});

test('Contacts CSV preserves ordinary quotes, backslashes, Unicode and records through native and standard readers', () => {
	const values = ['Ordinary Person', "O'Connor", 'Müller, "Team" \\ path',
		'Literal \\" quote and comma, next', 'Line one\nLine two', 'Line one\r\nLine two',
		'\ufeffOrdinary', '0123', 'user@example.test', 'https://contacts.example.test/'];
	for (const result of exportCases(values.map(value => ({ value, import: true })))) {
		assert.equal(result.rows.length, 2);
		assert.deepEqual(standardRows(result.csv), result.rows);
		assert.equal(result.rows[1][0], decode(result.original.fn));
		assert.equal(result.rows[1][11], decode(result.original.note));
		assert.deepEqual(result.imported, [{ fn: result.rows[1][5], note: result.rows[1][11] }]);
		assert.equal(result.unchanged, true);
	}
	const phone = exportCases([{ value: '+49 30 5550101' }])[0];
	for (const column of [14, 16, 23]) assert.equal(phone.rows[1][column], "'+49 30 5550101");
});

test('Contacts CSV fails closed on invalid UTF-8 and preserves legacy mixed-value coercion', () => {
	const invalid = Buffer.from([0xff, 0x3d, 0x31]);
	const result = exportCases([{ value: 'Ordinary', invalid: invalid.toString('base64') }])[0];
	assert.equal(Buffer.from(result.csv, 'base64').includes(Buffer.concat([Buffer.from("'"), invalid])), true);
	assert.equal(result.unchanged, true);
	const mixed = exportCases([{ value: 'Ordinary', mixed: true }])[0];
	assert.equal(mixed.rows[1][1], 'Array');
	assert.equal(mixed.rows[1][2], '');
	assert.equal(mixed.rows[1][3], "'-1");
	assert.equal(mixed.rows[1][17], 'Array\nArray');
	assert.equal(mixed.rows[1][18], 'Array');
	assert.ok(mixed.arrayWarnings > 0, 'existing array-to-string coercion remains explicit in the fixture');
	assert.equal(mixed.unchanged, true);
});
