import assert from 'node:assert/strict';
import test from 'node:test';

import { createDemoContactsVCard, demoContacts } from '../scripts/dev-demo-fixtures.mjs';

test('demo Contacts VCards include names SnappyMail can display', () => {
	const cards = createDemoContactsVCard(demoContacts);
	assert.equal((cards.match(/BEGIN:VCARD/g) || []).length, demoContacts.length);
	for (const contact of demoContacts) {
		const nameParts = contact.name.split(/\s+/);
		const familyName = 1 < nameParts.length ? nameParts.pop() : '';
		const givenName = nameParts.join(' ');
		assert.ok(cards.includes('FN:' + contact.name));
		assert.ok(cards.includes('N:' + familyName + ';' + givenName + ';;;'));
		assert.ok(cards.includes('EMAIL;TYPE=WORK:' + contact.email));
	}
});

test('demo Contacts VCards escape delimiters and newlines in text fields', () => {
	const cards = createDemoContactsVCard([{
		name: 'Taylor; Quinn, Jr.',
		email: 'taylor@example.test',
		organization: 'Studio; North, GmbH',
		phone: '+49 30 5550 0142\next 3'
	}]);
	assert.match(cards, /FN:Taylor\\; Quinn\\, Jr\./);
	assert.match(cards, /N:Jr\.;Taylor\\; Quinn\\,;;;/);
	assert.match(cards, /ORG:Studio\\; North\\, GmbH/);
	assert.match(cards, /TEL;TYPE=WORK:\+49 30 5550 0142\\next 3/);
});
