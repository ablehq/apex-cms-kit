// @ts-nocheck
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	NO_FIELD_NAMED,
	fieldErrorMessages,
	rejectedFieldsSentence
} from '../src/admin/field-errors.js';

describe('field-errors — one reading of a 422 for every screen', () => {
	it('shows the messages as Apex wrote them, never prefixed by the attribute', () => {
		const res = {
			status: 422,
			code: 'invalid',
			errors: [
				{ attribute: 'published_date', messages: ['Published date is invalid'] },
				{ attribute: 'slug', messages: ['Slug is invalid', 'Slug is too long'] }
			]
		};
		assert.deepEqual(fieldErrorMessages(res), [
			'Published date is invalid',
			'Slug is invalid, Slug is too long'
		]);
		assert.equal(
			rejectedFieldsSentence(res),
			'A field was rejected: Published date is invalid; Slug is invalid, Slug is too long.'
		);
	});

	it('falls back to the attribute only for an error with no message', () => {
		const res = { errors: [{ attribute: 'summary', messages: [] }, { attribute: 'title' }] };
		assert.deepEqual(fieldErrorMessages(res), ['summary', 'title']);
		assert.equal(rejectedFieldsSentence(res), 'A field was rejected: summary; title.');
	});

	it('names nothing → the one shared wording', () => {
		for (const res of [
			undefined,
			null,
			{},
			{ errors: [] },
			{ errors: 'nope' },
			{ errors: [{ messages: ['  '] }, {}] }
		]) {
			assert.deepEqual(fieldErrorMessages(res), [], JSON.stringify(res));
			assert.equal(rejectedFieldsSentence(res), NO_FIELD_NAMED);
		}
		assert.equal(NO_FIELD_NAMED, 'A field was rejected, but Apex did not say which.');
	});
});
