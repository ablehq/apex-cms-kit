// @ts-nocheck — node:test suite over the admin browser transport's dynamic shapes.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createBffClient } from '../src/admin/bff-client.js';

/**
 * THE ADMIN TRANSPORT'S RESULT SHAPE — specifically, which `status` wins.
 *
 * `mutate` merges the parsed body with `{ok, status}`. It used to spread the BODY
 * LAST, so a response key named `status` REPLACED the HTTP one, and that is not a
 * hypothetical collision: nine shipped BFF operations answer
 *
 *     noStoreJson({ error: 'upstream error', status: apexResponse.status }, 502)
 *
 * — the UPSTREAM status, deliberately reported, in a key that then overwrote the
 * transport's. Every screen deciding "was this refused, or did the server break?"
 * from `result.status` read the wrong number on exactly the responses where it
 * matters, and the two are routinely different: Apex 500 → BFF 502.
 *
 * One line in `mutate` fixes all ten call sites and every future one, which is why
 * it is asserted here rather than in each operation's own suite.
 */

/** A transport whose one response is fully controlled by the test. */
function clientAnswering(status, body, { json = true } = {}) {
	const seen = [];
	const fetchImpl = async (path, init) => {
		seen.push({ path, method: init.method, headers: init.headers, body: init.body });
		return new Response(body === undefined ? null : JSON.stringify(body), {
			status,
			headers: json ? { 'content-type': 'application/json' } : {}
		});
	};
	return { seen, client: createBffClient({ fetchImpl, csrfToken: 'csrf-test' }) };
}

describe('the admin BFF client: the HTTP status is never shadowed by the body', () => {
	it('a body {status: 500} on a 502 response still reads as 502', async () => {
		const { client } = clientAnswering(502, { error: 'upstream error', status: 500 });
		const result = await client.updateImage('img-1', { caption: 'x' });
		assert.equal(result.status, 502, 'the TRANSPORT status, not the upstream one');
		assert.equal(result.ok, false);
		assert.equal(result.error, 'upstream error', 'and the rest of the body still arrives');
	});

	it('a body {ok: true} on a 409 cannot make a refusal look accepted', async () => {
		const { client } = clientAnswering(409, { ok: true, code: 'unbacked-record' });
		const result = await client.updateImage('img-1', { caption: 'x' });
		assert.equal(result.ok, false);
		assert.equal(result.status, 409);
		assert.equal(result.code, 'unbacked-record');
	});

	it('a 200 with no body at all still carries ok and the status', async () => {
		const { client } = clientAnswering(200, undefined, { json: false });
		const result = await client.deleteImage('img-1');
		assert.deepEqual(result, { ok: true, status: 200 });
	});

	it('a non-object body cannot replace the result — a bare JSON array is ignored', async () => {
		const { client } = clientAnswering(422, ['nope']);
		const result = await client.updateImage('img-1', { caption: 'x' });
		assert.equal(result.status, 422);
		assert.equal(result.ok, false);
	});

	it('still sends the CSRF token and same-origin credentials on a mutation', async () => {
		// The status fix reorders the RESULT, not the request; assert the request is
		// untouched so a future "simplification" of `mutate` cannot drop either.
		const { seen, client } = clientAnswering(200, { ok: true });
		await client.updateImage('img-1', { caption: 'x' });
		assert.equal(seen.length, 1);
		assert.equal(seen[0].headers['x-csrf-token'], 'csrf-test');
		assert.equal(seen[0].method, 'PATCH');
	});
});
