import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	bffError,
	enforceBrowserBoundary,
	noStoreHeaders,
	noStoreJson,
	parseAllowedOrigins
} from '../src/server/bff/boundary.ts';
import {
	ApexTransportError,
	assertEntityTypeRef,
	assertSchemaItemSlug,
	createApexAdminClient
} from '../src/server/bff/apex-admin-client.ts';

const ORIGIN = 'https://gospellife.in';
const origins = [ORIGIN];

/** @param {string} method @param {Record<string,string>} headers @param {string} [body] */
function request(method, headers, body) {
	return new Request(`${ORIGIN}/api/admin/pages`, { method, headers, body });
}

describe('enforceBrowserBoundary', () => {
	it('allows a same-origin read with no CSRF token', () => {
		const result = enforceBrowserBoundary(
			request('GET', { origin: ORIGIN, 'sec-fetch-site': 'same-origin' }),
			{ allowedOrigins: origins, mutation: false }
		);
		assert.deepEqual(result, { ok: true });
	});

	it('rejects a cross-origin request', () => {
		const result = enforceBrowserBoundary(
			request('GET', { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }),
			{ allowedOrigins: origins, mutation: false }
		);
		assert.equal(result.ok, false);
		assert.equal(result.ok === false && result.status, 403);
	});

	it('rejects a cross-site fetch even to an allowed origin header', () => {
		const result = enforceBrowserBoundary(
			request('GET', { origin: ORIGIN, 'sec-fetch-site': 'cross-site' }),
			{ allowedOrigins: origins, mutation: false }
		);
		assert.equal(result.ok, false);
	});

	it('rejects a mutation with a missing CSRF token', () => {
		const result = enforceBrowserBoundary(
			request('PATCH', { origin: ORIGIN, 'sec-fetch-site': 'same-origin' }),
			{ allowedOrigins: origins, mutation: true }
		);
		assert.equal(result.ok, false);
		assert.equal(result.ok === false && result.status, 403);
	});

	it('rejects a mutation with a mismatched CSRF token', () => {
		const result = enforceBrowserBoundary(
			request('PATCH', {
				origin: ORIGIN,
				'sec-fetch-site': 'same-origin',
				'x-csrf-token': 'aaa',
				cookie: 'apex_bff_csrf=bbb'
			}),
			{ allowedOrigins: origins, mutation: true }
		);
		assert.equal(result.ok, false);
	});

	it('rejects a mutation that is not same-origin', () => {
		const result = enforceBrowserBoundary(
			request('PATCH', {
				origin: ORIGIN,
				'sec-fetch-site': 'same-site',
				'x-csrf-token': 'tok',
				cookie: 'apex_bff_csrf=tok'
			}),
			{ allowedOrigins: origins, mutation: true }
		);
		assert.equal(result.ok, false);
	});

	it('rejects a mutation arriving as a safe method', () => {
		const result = enforceBrowserBoundary(
			request('GET', { origin: ORIGIN, 'sec-fetch-site': 'same-origin' }),
			{ allowedOrigins: origins, mutation: true }
		);
		assert.equal(result.ok, false);
		assert.equal(result.ok === false && result.status, 405);
	});

	it('allows a well-formed same-origin mutation with a matching CSRF token', () => {
		const result = enforceBrowserBoundary(
			request('PATCH', {
				origin: ORIGIN,
				'sec-fetch-site': 'same-origin',
				'x-csrf-token': 'tok',
				cookie: 'other=1; apex_bff_csrf=tok'
			}),
			{ allowedOrigins: origins, mutation: true }
		);
		assert.deepEqual(result, { ok: true });
	});
});

describe('no-store responses', () => {
	it('noStoreHeaders sets no-store + noindex', () => {
		const headers = noStoreHeaders();
		assert.equal(headers.get('cache-control'), 'no-store');
		assert.equal(headers.get('x-robots-tag'), 'noindex, nofollow');
	});

	it('noStoreJson and bffError carry no-store', async () => {
		const ok = noStoreJson({ a: 1 }, 200);
		assert.equal(ok.headers.get('cache-control'), 'no-store');
		assert.deepEqual(await ok.json(), { a: 1 });
		const err = bffError(403, 'forbidden');
		assert.equal(err.status, 403);
		assert.equal(err.headers.get('cache-control'), 'no-store');
		assert.deepEqual(await err.json(), { error: 'forbidden' });
	});

	it('parseAllowedOrigins splits and trims', () => {
		assert.deepEqual(parseAllowedOrigins(' https://a , https://b '), ['https://a', 'https://b']);
		assert.deepEqual(parseAllowedOrigins(undefined), []);
	});
});

// The editor-allowlist cases that stood here were deleted with the allowlist itself
// on 2026-07-31. Who may act is now Apex's answer, exercised where it is actually
// decided: the login refuses any principal Apex will not admit (tests/bff-session.test.js
// and tests/bff-harness.test.js), and every Apex call afterwards carries that
// person's own token.

describe('the path-segment shape checks accept only what they say they accept', () => {
	/**
	 * P4 review, finding 4. Both were `/…/iu`, and UNICODE CASE FOLDING under `i`
	 * puts two non-ASCII characters inside `[a-z]`: U+212A KELVIN SIGN folds to `k`
	 * and U+017F LATIN SMALL LETTER LONG S folds to `s`. So a check whose entire job
	 * is "the ASCII slug alphabet, nothing that could carry a separator or an
	 * encoding" accepted characters that are not ASCII at all.
	 *
	 * Harmless downstream — the value is `encodeURIComponent`'d into one path
	 * segment and Apex answers 404 — but a shape check that accepts what it says it
	 * refuses is the wrong thing to leave in a security boundary.
	 *
	 * MUTATION: put the `i` flag back on either regex and the matching case here
	 * stops throwing.
	 */
	it('refuses the two characters unicode case folding smuggled into [a-z]', () => {
		assert.throws(() => assertEntityTypeRef('\u212a'), /invalid entity type/u);
		assert.throws(() => assertEntityTypeRef('quote-\u017fitem'), /invalid entity type/u);
		assert.throws(() => assertSchemaItemSlug('\u212a'), /invalid schema item slug/u);
		assert.throws(() => assertSchemaItemSlug('expertise_\u017f'), /invalid schema item slug/u);
	});

	it('refuses an UPPERCASE spelling, which Apex never mints', () => {
		assert.throws(() => assertEntityTypeRef('Quote-Item'), /invalid entity type/u);
		assert.throws(() => assertSchemaItemSlug('Biography'), /invalid schema item slug/u);
	});

	it('still accepts the slugs and uuids every site actually uses', () => {
		assert.doesNotThrow(() => assertEntityTypeRef('quote-item'));
		assert.doesNotThrow(() => assertEntityTypeRef('5c9f0a21-1b2c-4d3e-8f40-a1b2c3d4e5f6'));
		assert.doesNotThrow(() => assertSchemaItemSlug('expertise_items'));
		assert.doesNotThrow(() => assertSchemaItemSlug('biography'));
	});
});

describe('per-editor Apex client', () => {
	const UUID = 'ce776750-ce9f-474d-a103-5256ea228517';

	it('sends a fresh Bearer request with redirect:manual and no forwarded headers', async () => {
		/** @type {{ url: URL, init: RequestInit }[]} */
		const calls = [];
		const client = createApexAdminClient({
			baseUrl: 'https://apex.internal',
			token: 'bff-token',
			fetchImpl: async (input, init) => {
				calls.push({ url: new URL(String(input)), init: init ?? {} });
				return new Response(JSON.stringify({ data: [] }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				});
			}
		});
		await client.listPages({ page: 1, per_page: 50 });
		assert.equal(calls.length, 1);
		assert.equal(calls[0].url.origin, 'https://apex.internal');
		assert.equal(calls[0].url.pathname, '/api/platform/v1/cms/pages/search_and_filter');
		const headers = new Headers(calls[0].init.headers);
		assert.equal(headers.get('authorization'), 'Bearer bff-token');
		assert.equal(headers.get('cookie'), null);
		assert.equal(calls[0].init.redirect, 'manual');
	});

	// The endpoint is `status_event`; the body key is `event`. Asserted as a literal
	// because these are different words and the difference is silent: Apex answers a
	// `{status_event:…}` body with 422 and leaves the page's status alone. Measured
	// against local Apex 2026-07-31 — see the comment on `changePageStatus`.
	it('posts { event } — not { status_event } — to the status_event endpoint', async () => {
		/** @type {{ url: URL, body: string }[]} */
		const calls = [];
		const client = createApexAdminClient({
			baseUrl: 'https://apex.internal',
			token: 'bff-token',
			fetchImpl: async (input, init) => {
				calls.push({ url: new URL(String(input)), body: String(init?.body ?? '') });
				return new Response(JSON.stringify({ data: {} }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				});
			}
		});
		const result = await client.changePageStatus(UUID, 'publish');
		assert.equal(result.ok, true);
		assert.equal(calls[0].url.pathname, `/api/platform/v1/cms/pages/${UUID}/status_event`);
		assert.deepEqual(JSON.parse(calls[0].body), { event: 'publish' });
	});

	it('refuses to interpolate a non-uuid page id', async () => {
		const client = createApexAdminClient({
			baseUrl: 'https://apex.internal',
			token: 'bff-token',
			fetchImpl: async () => new Response('{}', { headers: { 'content-type': 'application/json' } })
		});
		await assert.rejects(() => client.changePageStatus('../evil', 'publish'));
		await assert.rejects(() => client.changePageStatus('not-a-uuid', 'publish'));
	});

	/**
	 * A RESPONSE WHOSE BODY DIES MID-STREAM. codex on the P3 fix pass, finding 4:
	 * `await response.json().catch(() => null)` swallowed a reset or an abort during
	 * body consumption as `body: null`, so a 2xx came back `ok: true` over an
	 * INCOMPLETE response — a write reported as succeeded-and-returned-nothing.
	 * Malformed JSON must stay a shape error; only the stream failure is a fault.
	 */
	function bodyFailsMidStream() {
		return new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(new TextEncoder().encode('{"data":'));
					controller.error(new TypeError('terminated'));
				}
			}),
			{ status: 200, headers: { 'content-type': 'application/json' } }
		);
	}

	it('a body stream that fails is a transport error, not an ok:true with body:null', async () => {
		const client = createApexAdminClient({
			baseUrl: 'https://apex.internal',
			token: 'bff-token',
			fetchImpl: async () => bodyFailsMidStream()
		});
		await assert.rejects(
			() => client.listPages({ page: 1 }),
			(error) => {
				assert.ok(error instanceof ApexTransportError, `got ${error?.name}: ${error?.message}`);
				return true;
			}
		);
	});

	it('on the signal-carrying path it is a typed failure that KEEPS the http status', async () => {
		// The ingest path takes typed failures rather than exceptions. The status is
		// preserved here and not zeroed as it is for a pre-response fault: we know what
		// Apex answered, we only failed to finish reading it, and a caller deciding
		// whether a write may have committed wants that difference.
		const client = createApexAdminClient({
			baseUrl: 'https://apex.internal',
			token: 'bff-token',
			signal: new AbortController().signal,
			fetchImpl: async () => bodyFailsMidStream()
		});
		const result = await client.listPages({ page: 1 });
		assert.equal(result.ok, false, 'an incomplete body is not a success');
		assert.equal(result.networkError, true);
		assert.equal(result.status, 200, 'the status Apex actually sent');
		assert.equal(result.body, null);
	});

	it('malformed JSON is still a shape error, not a transport failure', async () => {
		const client = createApexAdminClient({
			baseUrl: 'https://apex.internal',
			token: 'bff-token',
			fetchImpl: async () =>
				new Response('not json at all', {
					status: 200,
					headers: { 'content-type': 'application/json' }
				})
		});
		const result = await client.listPages({ page: 1 });
		assert.equal(result.ok, true, 'the response arrived complete');
		assert.equal(result.status, 200);
		assert.equal(result.body, null);
		assert.equal(result.networkError, undefined);
	});

	it('does not follow an upstream redirect', async () => {
		const client = createApexAdminClient({
			baseUrl: 'https://apex.internal',
			token: 'bff-token',
			fetchImpl: async () =>
				new Response(null, { status: 302, headers: { location: '/elsewhere' } })
		});
		const result = await client.listPages({ page: 1 });
		assert.equal(result.ok, false);
		assert.equal(result.status, 302);
	});
});
