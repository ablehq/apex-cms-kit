// @ts-nocheck — node:test suite over dynamic JSON shapes, like its siblings in this
// directory (bff-admin-gate, bff-realapex, bff-hooks-csrf). Behavior is the contract.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createApexAdminClient } from '../src/server/bff/apex-admin-client.ts';
import { createApexAuthClient } from '../src/server/bff/apex-auth.ts';
import { parseAllowedOrigins } from '../src/server/bff/boundary.ts';
import { guardRequest, resolvePageSession } from '../src/server/bff/guard.ts';
import { handleLogin, handleLogout } from '../src/server/bff/operations/auth.ts';
import { handleListPages } from '../src/server/bff/operations/list-pages.ts';
import {
	clearedSessionCookieHeader,
	createD1SessionStore,
	createSessionSecret,
	isSecureRequest,
	isSessionExpired,
	needsAccessRefresh,
	readSessionCookie,
	sessionCookieHeader,
	sessionIdFor,
	SESSION_ABSOLUTE_TTL_MS,
	SESSION_IDLE_TTL_MS
} from '../src/server/bff/session.ts';
import { createMemorySessionStore, createStubAuthClient } from './harness/session-store.ts';

/**
 * The admin session, unit level (ADR-1 as revised 2026-07-31). The properties pinned
 * here are the ones the whole design rests on:
 *
 *   - the cookie is opaque and unguessable, and what is STORED is its hash;
 *   - the browser is never handed an Apex token, on login or on any later response;
 *   - a session ends on absolute expiry, on idle, on logout, and when Apex refuses
 *     to renew — and every one of those is a clean 401, never a half-live session;
 *   - Apex, not a local list, decides who may hold a session.
 *
 * The D1 SQL behind the store is exercised in `tests/bff-harness.test.js` against
 * real D1 in workerd; here the store is in-memory so the LOGIC is isolated.
 */

const ORIGIN = 'https://gospellife.in';
const EDITOR = 'editor@gospellife.in';
const PASSWORD = 'correct horse battery staple';
const REFUSED = 'outsider@gospellife.in';
const CSRF = 'csrf-unit';

function stubApexFetch() {
	return async () =>
		new Response(JSON.stringify({ data: [{ id: 'page-1', slug: 'gospel' }] }), {
			status: 200,
			headers: { 'content-type': 'application/json' }
		});
}

function buildTestContext(overrides = {}) {
	const sessions = createMemorySessionStore();
	const auth = createStubAuthClient({
		credentials: { [EDITOR]: PASSWORD, [REFUSED]: PASSWORD },
		identities: {
			[EDITOR]: { id: 'aaaaaaaa-1111-4222-8333-444444444444', email: EDITOR, name: 'Test Editor' }
			// REFUSED deliberately absent: correct password, Apex will not admit them.
		},
		...(overrides.authOptions ?? {})
	});
	/** Every Apex client the guard builds, so a test can see which token was used. */
	const apexTokens = [];
	return {
		sessions,
		auth,
		apexTokens,
		ctx: {
			allowedOrigins: parseAllowedOrigins(ORIGIN),
			sessions,
			auth,
			createApexClient: (token) => {
				apexTokens.push(token);
				return createApexAdminClient({
					baseUrl: 'https://apex.internal',
					token,
					fetchImpl: stubApexFetch()
				});
			},
			accountId: 'test',
			...overrides.ctx
		}
	};
}

function loginRequest(email, password, extraHeaders = {}) {
	return new Request(`${ORIGIN}/api/admin/auth/login`, {
		method: 'POST',
		headers: {
			origin: ORIGIN,
			'sec-fetch-site': 'same-origin',
			'content-type': 'application/json',
			'x-csrf-token': CSRF,
			cookie: `apex_bff_csrf=${CSRF}`,
			...extraHeaders
		},
		body: JSON.stringify({ email, password })
	});
}

function sessionFrom(response) {
	const match = /apex_admin_session=([^;]*)/u.exec(response.headers.get('set-cookie') ?? '');
	return match ? match[1] : '';
}

function readRequest(session, path = '/api/admin/pages') {
	return new Request(`${ORIGIN}${path}`, {
		method: 'GET',
		headers: {
			origin: ORIGIN,
			'sec-fetch-site': 'same-origin',
			cookie: `apex_admin_session=${session}; apex_bff_csrf=${CSRF}`
		}
	});
}

describe('session cookie: opaque, unguessable, and not what is stored', () => {
	it('mints 256 bits of base64url and never repeats', () => {
		const secrets = new Set();
		for (let i = 0; i < 200; i += 1) {
			const secret = createSessionSecret();
			assert.match(secret, /^[A-Za-z0-9_-]{43}$/u);
			secrets.add(secret);
		}
		assert.equal(secrets.size, 200);
	});

	it('the stored id is the SHA-256 of the cookie, and is stable', async () => {
		const secret = createSessionSecret();
		const id = await sessionIdFor(secret);
		assert.match(id, /^[0-9a-f]{64}$/u);
		assert.notEqual(id, secret);
		assert.equal(await sessionIdFor(secret), id);
		assert.notEqual(await sessionIdFor(createSessionSecret()), id);
	});

	it('serializes httpOnly + SameSite=Strict, with Secure following the scheme', () => {
		const secure = sessionCookieHeader('abc', { secure: true, maxAgeSeconds: 60 });
		assert.match(
			secure,
			/^apex_admin_session=abc; Path=\/; HttpOnly; SameSite=Strict; Max-Age=60; Secure$/u
		);
		const insecure = sessionCookieHeader('abc', { secure: false, maxAgeSeconds: 60 });
		assert.equal(insecure.includes('Secure'), false, 'still lands on http://localhost');
		assert.match(clearedSessionCookieHeader(true), /Max-Age=0/u);
	});

	it('isSecureRequest follows the request URL scheme', () => {
		assert.equal(isSecureRequest({ url: 'https://gospellife.in/x' }), true);
		assert.equal(isSecureRequest({ url: 'http://localhost:4173/x' }), false);
		assert.equal(isSecureRequest({ url: 'not a url' }), false);
	});

	it('reads its own cookie, ignores others, and refuses an oversized value', () => {
		const request = (cookie) => ({ headers: new Headers({ cookie }) });
		assert.equal(readSessionCookie(request('apex_admin_session=abc; apex_bff_csrf=t')), 'abc');
		assert.equal(readSessionCookie(request('apex_bff_csrf=t')), null);
		assert.equal(readSessionCookie({ headers: new Headers() }), null);
		assert.equal(readSessionCookie(request('apex_admin_session=')), null);
		// A megabyte of attacker-supplied cookie never reaches the digest.
		assert.equal(readSessionCookie(request(`apex_admin_session=${'a'.repeat(4096)}`)), null);
	});
});

describe('session lifetime predicates', () => {
	const base = {
		id: 'x',
		createdAt: 1000,
		lastSeenAt: 1000,
		expiresAt: 1000 + SESSION_ABSOLUTE_TTL_MS,
		staffEmail: EDITOR,
		staffId: null,
		staffName: null,
		accessToken: 't',
		tokenType: 'Bearer',
		accessExpiresAt: 1000 + 7200 * 1000,
		refreshToken: 'r'
	};

	it('expires at the absolute end even with recent activity', () => {
		const active = { ...base, lastSeenAt: 1000 + SESSION_ABSOLUTE_TTL_MS - 1 };
		assert.equal(isSessionExpired(active, 1000 + SESSION_ABSOLUTE_TTL_MS - 1), false);
		assert.equal(isSessionExpired(active, 1000 + SESSION_ABSOLUTE_TTL_MS), true);
	});

	it('expires on idle even inside the absolute window', () => {
		assert.equal(isSessionExpired(base, 1000 + SESSION_IDLE_TTL_MS - 1), false);
		assert.equal(isSessionExpired(base, 1000 + SESSION_IDLE_TTL_MS), true);
	});

	it('asks for a refresh only as the Apex token nears expiry', () => {
		assert.equal(needsAccessRefresh(base, 1000), false);
		assert.equal(needsAccessRefresh(base, base.accessExpiresAt - 5 * 60 * 1000), false);
		assert.equal(needsAccessRefresh(base, base.accessExpiresAt - 60 * 1000), true);
		assert.equal(needsAccessRefresh(base, base.accessExpiresAt + 1), true);
	});
});

describe('the D1 store with no binding', () => {
	it('reports itself not ready, reads as "no session", and throws only on a write', async () => {
		// The absent binding is a real state — a bare `vite dev`, a Pages deploy whose
		// D1 was never wired — and every method says what it does in it, so a read is
		// a clean 401 rather than a 500 and only a write, which cannot be faked, throws.
		const store = createD1SessionStore(undefined);
		assert.equal(store.ready(), false);
		assert.equal(await store.read('whatever'), null);
		await assert.rejects(() => store.create({ id: 'x' }), /no D1 binding/u);
		// The non-essential writes are quiet: nothing to purge, nothing to touch.
		await store.update({ id: 'x' });
		await store.delete('x');
		await store.purgeExpired(Date.now());
	});
});

describe('login: Apex decides, and the browser never sees a token', () => {
	it('a correct staff login opens a session and returns only an identity', async () => {
		const { ctx, sessions } = buildTestContext();
		const response = await handleLogin(loginRequest(EDITOR, PASSWORD), ctx);
		assert.equal(response.status, 200);

		const body = await response.json();
		assert.deepEqual(body, { ok: true, editor: { email: EDITOR, name: 'Test Editor' } });
		// Not one Apex token byte crosses the boundary.
		assert.equal(JSON.stringify(body).includes('stub-access'), false);
		assert.equal(JSON.stringify(body).includes('stub-refresh'), false);
		assert.equal(response.headers.get('cache-control'), 'no-store');

		const session = sessionFrom(response);
		assert.match(session, /^[A-Za-z0-9_-]{43}$/u);

		// The tokens are in the store, under the HASH of the cookie.
		const row = await sessions.read(await sessionIdFor(session));
		assert.ok(row);
		assert.match(row.accessToken, /^stub-access-/u);
		assert.match(row.refreshToken, /^stub-refresh-/u);
		assert.equal(row.staffEmail, EDITOR);
		assert.equal(row.staffId, 'aaaaaaaa-1111-4222-8333-444444444444');
	});

	it('a wrong password and an unknown account are the SAME opaque 401', async () => {
		const { ctx, sessions } = buildTestContext();
		const wrong = await handleLogin(loginRequest(EDITOR, 'nope'), ctx);
		assert.equal(wrong.status, 401);
		assert.deepEqual(await wrong.json(), { error: 'invalid credentials' });
		assert.equal(wrong.headers.get('set-cookie'), null);

		const unknown = await handleLogin(loginRequest('ghost@gospellife.in', PASSWORD), ctx);
		assert.equal(unknown.status, 401);
		assert.deepEqual(await unknown.json(), { error: 'invalid credentials' });

		assert.equal(sessions.rows.size, 0, 'no session is opened by a failed login');
	});

	it('correct credentials Apex will not ADMIT are refused, and the token is revoked', async () => {
		// This is what replaced the editor allowlist: authorization is Apex's answer,
		// asked with the token that was just minted, and a refusal hands it straight back.
		const { ctx, sessions, auth } = buildTestContext();
		const response = await handleLogin(loginRequest(REFUSED, PASSWORD), ctx);
		assert.equal(response.status, 403);
		assert.deepEqual(await response.json(), { error: 'forbidden' });
		assert.equal(response.headers.get('set-cookie'), null);
		assert.equal(sessions.rows.size, 0);
		assert.equal(auth.calls.revoke.length, 1, 'the refused login revokes what it minted');
		assert.match(auth.calls.revoke[0], /^stub-access-outsider/u);
	});

	it('the canonical Apex email wins over whatever the form supplied', async () => {
		const { ctx, sessions } = buildTestContext();
		// The form supplies a differently-cased address; Apex's answer is what is stored.
		const response = await handleLogin(loginRequest('EDITOR@Gospellife.IN', PASSWORD), ctx);
		assert.equal(response.status, 200);
		const row = await sessions.read(await sessionIdFor(sessionFrom(response)));
		assert.equal(row.staffEmail, EDITOR);
	});

	it('login is a mutation: cross-origin and missing CSRF are refused', async () => {
		const { ctx } = buildTestContext();
		const noCsrf = await handleLogin(
			new Request(`${ORIGIN}/api/admin/auth/login`, {
				method: 'POST',
				headers: {
					origin: ORIGIN,
					'sec-fetch-site': 'same-origin',
					'content-type': 'application/json'
				},
				body: JSON.stringify({ email: EDITOR, password: PASSWORD })
			}),
			ctx
		);
		assert.equal(noCsrf.status, 403);

		const crossOrigin = await handleLogin(
			loginRequest(EDITOR, PASSWORD, {
				origin: 'https://evil.example',
				'sec-fetch-site': 'cross-site'
			}),
			ctx
		);
		assert.equal(crossOrigin.status, 403);
	});

	it('with nowhere to store a session, refuses BEFORE the password reaches Apex', async () => {
		// The deployment has no D1 binding. A login cannot succeed however good the
		// credentials are, so it must not mint a token to discover that — the 500 that
		// used to follow left a live Apex token behind with nothing holding a reference
		// to revoke it.
		const { ctx, auth, sessions } = buildTestContext();
		ctx.sessions = { ...sessions, ready: () => false };

		const response = await handleLogin(loginRequest(EDITOR, PASSWORD), ctx);
		assert.equal(response.status, 503);
		assert.deepEqual(await response.json(), { error: 'session store unavailable' });
		assert.equal(response.headers.get('set-cookie'), null);
		assert.equal(auth.calls.passwordGrant.length, 0, 'the password never left this Worker');
	});

	it('a store that was ready and then FAILS the write hands the token back', async () => {
		const { ctx, auth, sessions } = buildTestContext();
		ctx.sessions = {
			...sessions,
			ready: () => true,
			async create() {
				throw new Error('d1 unavailable');
			}
		};

		const response = await handleLogin(loginRequest(EDITOR, PASSWORD), ctx);
		assert.equal(response.status, 503);
		assert.deepEqual(await response.json(), { error: 'session store unavailable' });
		assert.equal(response.headers.get('set-cookie'), null);
		assert.equal(auth.calls.revoke.length, 1, 'the unstorable token is revoked, not stranded');
		assert.match(auth.calls.revoke[0], /^stub-access-editor/u);
	});

	it('rejects a malformed or oversized body before it reaches Apex', async () => {
		const { ctx, auth } = buildTestContext();
		const headers = {
			origin: ORIGIN,
			'sec-fetch-site': 'same-origin',
			'content-type': 'application/json',
			'x-csrf-token': CSRF,
			cookie: `apex_bff_csrf=${CSRF}`
		};
		const notJson = await handleLogin(
			new Request(`${ORIGIN}/api/admin/auth/login`, { method: 'POST', headers, body: 'not json' }),
			ctx
		);
		assert.equal(notJson.status, 400);

		const extraKey = await handleLogin(
			new Request(`${ORIGIN}/api/admin/auth/login`, {
				method: 'POST',
				headers,
				body: JSON.stringify({ email: EDITOR, password: PASSWORD, role: 'admin' })
			}),
			ctx
		);
		assert.equal(extraKey.status, 400, 'the body schema is strict');

		const huge = await handleLogin(
			new Request(`${ORIGIN}/api/admin/auth/login`, {
				method: 'POST',
				headers,
				body: JSON.stringify({ email: EDITOR, password: 'x'.repeat(20000) })
			}),
			ctx
		);
		assert.equal(huge.status, 413);

		assert.equal(auth.calls.passwordGrant.length, 0, 'nothing reached Apex');
	});
});

describe('guard: the session is the only thing that authenticates', () => {
	async function signedIn(overrides) {
		const built = buildTestContext(overrides);
		const response = await handleLogin(loginRequest(EDITOR, PASSWORD), built.ctx);
		return { ...built, session: sessionFrom(response) };
	}

	it('admits a live session and hands the operation a client on THAT editor’s token', async () => {
		const { ctx, session, apexTokens } = await signedIn();
		const guard = await guardRequest(readRequest(session), ctx, { mutation: false });
		assert.equal(guard.ok, true);
		assert.equal(guard.actor.email, EDITOR);
		assert.equal(guard.actor.sub, 'aaaaaaaa-1111-4222-8333-444444444444');
		assert.equal(apexTokens.length, 1);
		assert.match(apexTokens[0], /^stub-access-editor@gospellife\.in/u);
	});

	it('refuses no cookie, a forged cookie, and never builds an Apex client for either', async () => {
		const { ctx, apexTokens } = await signedIn();
		const none = await guardRequest(
			new Request(`${ORIGIN}/api/admin/pages`, {
				method: 'GET',
				headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin' }
			}),
			ctx,
			{ mutation: false }
		);
		assert.equal(none.ok, false);
		assert.equal(none.status, 401);

		const forged = await guardRequest(readRequest(createSessionSecret()), ctx, { mutation: false });
		assert.equal(forged.ok, false);
		assert.equal(forged.status, 401);

		assert.equal(apexTokens.length, 0, 'no Apex client is constructed for a failed guard');
	});

	it('refuses and DELETES a session past its absolute end', async () => {
		const { ctx, sessions, session } = await signedIn();
		const id = await sessionIdFor(session);
		const row = await sessions.read(id);
		await sessions.update({ ...row, expiresAt: Date.now() - 1 });

		const guard = await guardRequest(readRequest(session), ctx, { mutation: false });
		assert.equal(guard.ok, false);
		assert.equal(guard.status, 401);
		assert.equal(await sessions.read(id), null, 'the dead row is swept');
	});

	it('refuses an idle session inside its absolute window', async () => {
		const { ctx, sessions, session } = await signedIn();
		const id = await sessionIdFor(session);
		const row = await sessions.read(id);
		await sessions.update({ ...row, lastSeenAt: Date.now() - SESSION_IDLE_TTL_MS - 1 });

		const guard = await guardRequest(readRequest(session), ctx, { mutation: false });
		assert.equal(guard.ok, false);
		assert.equal(guard.status, 401);
	});

	it('refreshes an expiring Apex token in place — same cookie, new token', async () => {
		const { ctx, sessions, session, auth } = await signedIn();
		const id = await sessionIdFor(session);
		const before = await sessions.read(id);
		await sessions.update({ ...before, accessExpiresAt: Date.now() - 1 });

		const guard = await guardRequest(readRequest(session), ctx, { mutation: false });
		assert.equal(guard.ok, true);
		assert.equal(auth.calls.refreshGrant.length, 1);

		const after = await sessions.read(id);
		assert.notEqual(after.accessToken, before.accessToken);
		assert.notEqual(after.refreshToken, before.refreshToken);
		assert.ok(after.accessExpiresAt > Date.now());
		// The browser's cookie is untouched: rotation is entirely server-side.
		assert.ok(await sessions.read(await sessionIdFor(session)));
	});

	it('ends the session when Apex REFUSES the refresh', async () => {
		const { ctx, sessions, session, auth } = await signedIn();
		const id = await sessionIdFor(session);
		const row = await sessions.read(id);
		await sessions.update({ ...row, accessExpiresAt: Date.now() - 1 });
		auth.breakRefresh();

		const guard = await guardRequest(readRequest(session), ctx, { mutation: false });
		assert.equal(guard.ok, false);
		assert.equal(guard.status, 401);
		assert.equal(await sessions.read(id), null);
	});

	it('a mutation still needs the CSRF token even with a live session', async () => {
		const { ctx, session } = await signedIn();
		const guard = await guardRequest(
			new Request(`${ORIGIN}/api/admin/pages/x/status`, {
				method: 'PATCH',
				headers: {
					origin: ORIGIN,
					'sec-fetch-site': 'same-origin',
					cookie: `apex_admin_session=${session}`
				},
				body: '{}'
			}),
			ctx,
			{ mutation: true }
		);
		assert.equal(guard.ok, false);
		assert.equal(guard.status, 403);
	});

	it('an operation reaches Apex with the session, and 401s without it', async () => {
		const { ctx, session } = await signedIn();
		const ok = await handleListPages(readRequest(session), ctx);
		assert.equal(ok.status, 200);
		assert.deepEqual((await ok.json()).pages, [{ id: 'page-1', slug: 'gospel' }]);

		const anon = await handleListPages(
			new Request(`${ORIGIN}/api/admin/pages`, {
				method: 'GET',
				headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin' }
			}),
			ctx
		);
		assert.equal(anon.status, 401);
	});
});

describe('logout: the session ends server-side', () => {
	it('deletes the row, revokes upstream, clears the cookie, and 401s afterwards', async () => {
		const { ctx, sessions, auth } = buildTestContext();
		const session = sessionFrom(await handleLogin(loginRequest(EDITOR, PASSWORD), ctx));
		const id = await sessionIdFor(session);
		assert.ok(await sessions.read(id));

		const response = await handleLogout(
			new Request(`${ORIGIN}/api/admin/auth/logout`, {
				method: 'POST',
				headers: {
					origin: ORIGIN,
					'sec-fetch-site': 'same-origin',
					'x-csrf-token': CSRF,
					cookie: `apex_admin_session=${session}; apex_bff_csrf=${CSRF}`
				}
			}),
			ctx
		);
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { ok: true });
		assert.match(response.headers.get('set-cookie'), /apex_admin_session=; .*Max-Age=0/u);

		assert.equal(await sessions.read(id), null, 'the row is gone — the cookie is now inert');
		assert.equal(auth.calls.revoke.length, 1, 'the Apex token is revoked upstream too');

		const after = await guardRequest(readRequest(session), ctx, { mutation: false });
		assert.equal(after.ok, false);
		assert.equal(after.status, 401);
	});

	it('is a mutation: no CSRF token, no logout', async () => {
		const { ctx, sessions } = buildTestContext();
		const session = sessionFrom(await handleLogin(loginRequest(EDITOR, PASSWORD), ctx));
		const response = await handleLogout(
			new Request(`${ORIGIN}/api/admin/auth/logout`, {
				method: 'POST',
				headers: {
					origin: ORIGIN,
					'sec-fetch-site': 'same-origin',
					cookie: `apex_admin_session=${session}`
				}
			}),
			ctx
		);
		assert.equal(response.status, 403);
		assert.ok(await sessions.read(await sessionIdFor(session)), 'the session survives');
	});

	it('succeeds with no session at all, revealing nothing about the cookie', async () => {
		const { ctx } = buildTestContext();
		const response = await handleLogout(
			new Request(`${ORIGIN}/api/admin/auth/logout`, {
				method: 'POST',
				headers: {
					origin: ORIGIN,
					'sec-fetch-site': 'same-origin',
					'x-csrf-token': CSRF,
					cookie: `apex_bff_csrf=${CSRF}`
				}
			}),
			ctx
		);
		assert.equal(response.status, 200);
	});
});

describe('page-navigation session read (+layout.server.ts)', () => {
	it('names the signed-in editor and refuses everything else', async () => {
		const { ctx, sessions } = buildTestContext();
		const session = sessionFrom(await handleLogin(loginRequest(EDITOR, PASSWORD), ctx));

		// A top-level navigation from another site: Sec-Fetch-Site is `cross-site`, and
		// this path must NOT 403 it — a document load is not an API call.
		const crossSiteNav = new Request(`${ORIGIN}/admin/pages`, {
			headers: { 'sec-fetch-site': 'cross-site', cookie: `apex_admin_session=${session}` }
		});
		assert.deepEqual(await resolvePageSession(crossSiteNav, ctx), {
			email: EDITOR,
			name: 'Test Editor'
		});

		const anon = new Request(`${ORIGIN}/admin/pages`);
		assert.equal(await resolvePageSession(anon, ctx), null);

		const row = await sessions.read(await sessionIdFor(session));
		await sessions.update({ ...row, expiresAt: Date.now() - 1 });
		const expired = new Request(`${ORIGIN}/admin/pages`, {
			headers: { cookie: `apex_admin_session=${session}` }
		});
		assert.equal(await resolvePageSession(expired, ctx), null);
	});
});

describe('the Apex auth client speaks the measured Apex contract', () => {
	function clientWith(handler) {
		const calls = [];
		const client = createApexAuthClient({
			baseUrl: 'https://apex.internal',
			applicationId: 'app-id',
			applicationSecret: 'app-secret',
			fetchImpl: async (input, init) => {
				calls.push({ url: new URL(String(input)), init: init ?? {} });
				return handler(new URL(String(input)), init ?? {});
			}
		});
		return { client, calls };
	}

	const tokenBody = {
		access_token: 'a',
		token_type: 'Bearer',
		expires_in: 7200,
		refresh_token: 'r',
		created_at: 1785496317
	};
	const json = (body, status = 200) =>
		new Response(JSON.stringify(body), {
			status,
			headers: { 'content-type': 'application/json' }
		});

	it('refuses to construct without a client credential (fails at wiring, not at login)', () => {
		assert.throws(() =>
			createApexAuthClient({
				baseUrl: 'https://apex.internal',
				applicationId: '',
				applicationSecret: 's'
			})
		);
	});

	it('sends the password grant with Basic client auth to the otpless endpoint', async () => {
		const { client, calls } = clientWith(() => json(tokenBody));
		const token = await client.passwordGrant('editor@x.test', 'pw');
		assert.deepEqual(token, {
			accessToken: 'a',
			tokenType: 'Bearer',
			expiresInSec: 7200,
			refreshToken: 'r',
			createdAtSec: 1785496317
		});
		assert.equal(calls[0].url.pathname, '/api/v1/staff/token/otpless');
		assert.equal(calls[0].init.method, 'POST');
		assert.equal(calls[0].init.redirect, 'manual');
		assert.equal(calls[0].init.headers.get('authorization'), `Basic ${btoa('app-id:app-secret')}`);
		assert.deepEqual(JSON.parse(calls[0].init.body), {
			grant_type: 'password',
			username: 'editor@x.test',
			password: 'pw'
		});
	});

	it('sends the refresh grant to the plain token endpoint', async () => {
		const { client, calls } = clientWith(() => json(tokenBody));
		assert.ok(await client.refreshGrant('r0'));
		assert.equal(calls[0].url.pathname, '/api/v1/staff/token');
		assert.deepEqual(JSON.parse(calls[0].init.body), {
			grant_type: 'refresh_token',
			refresh_token: 'r0'
		});
	});

	it('returns null for a 400 invalid_grant, a 401, a redirect and a network error', async () => {
		assert.equal(
			await clientWith(() => json({ error: 'invalid_grant' }, 400)).client.passwordGrant('e', 'p'),
			null
		);
		assert.equal(
			await clientWith(() => new Response('', { status: 401 })).client.passwordGrant('e', 'p'),
			null
		);
		assert.equal(
			await clientWith(() => new Response('', { status: 302 })).client.passwordGrant('e', 'p'),
			null
		);
		assert.equal(
			await clientWith(() => {
				throw new Error('ECONNREFUSED');
			}).client.passwordGrant('e', 'p'),
			null
		);
	});

	it('refuses a token response missing a refresh token — a session must be renewable', async () => {
		const { refresh_token, ...withoutRefresh } = tokenBody;
		void refresh_token;
		assert.equal(await clientWith(() => json(withoutRefresh)).client.passwordGrant('e', 'p'), null);
	});

	it('reads the canonical identity from /staffs/me and treats 401 as a refusal', async () => {
		const { client, calls } = clientWith(() =>
			json({ data: { id: 'uuid-1', email: 'Editor@X.test', name: 'Ed' } })
		);
		assert.deepEqual(await client.staffsMe('tok'), {
			id: 'uuid-1',
			email: 'Editor@X.test',
			name: 'Ed'
		});
		assert.equal(calls[0].url.pathname, '/api/platform/v1/staffs/me');
		assert.equal(calls[0].init.headers.get('authorization'), 'Bearer tok');

		assert.equal(
			await clientWith(() => json({ code: 'invalid-token' }, 401)).client.staffsMe('tok'),
			null
		);
		// An identity with no email is no identity: there would be nothing to attribute to.
		assert.equal(await clientWith(() => json({ data: { id: 'x' } })).client.staffsMe('tok'), null);
	});

	it('revoke never throws, whatever Apex answers', async () => {
		await clientWith(() => json({}, 500)).client.revoke('tok');
		await clientWith(() => {
			throw new Error('down');
		}).client.revoke('tok');
	});
});
