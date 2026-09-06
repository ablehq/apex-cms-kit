// @ts-nocheck — node:test suite over dynamic JSON shapes; behaviour is the contract.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	handleSignMediaUpload,
	handleFinalizeMediaUpload
} from '../src/server/bff/operations/media.ts';
import { UPLOAD_LIMIT_BYTES } from '../src/admin/media-types.js';
import { createSessionSecret, sessionIdFor } from '../src/server/bff/session.ts';
import { parseAllowedOrigins } from '../src/server/bff/boundary.ts';
import { createMemorySessionStore } from './harness/session-store.ts';

const ORIGIN = 'https://site.test';
const CSRF = 'csrf-media';
const G = {
	images: '11111111-1111-4111-8111-111111111111',
	videos: '22222222-2222-4222-8222-222222222222',
	files: '33333333-3333-4333-8333-333333333333'
};
const NEW_ITEM = 'dddddddd-0000-4000-8000-000000000009';

/**
 * Every Apex call this path can make, recorded in order. Each leg can be made to
 * fail independently, because the failures are the whole subject: what must be true
 * is that no combination of them leaves a gallery item behind.
 */
function apexWith(calls, fail = {}) {
	return {
		async readCmsConfig() {
			calls.push(['readCmsConfig']);
			if (fail.cmsConfig) return { ok: false, status: 502, body: null };
			return {
				ok: true,
				status: 200,
				body: {
					data: {
						asset_library: Object.entries(G).map(([name, id]) => ({ gallery: { id, name } }))
					}
				}
			};
		},
		async createSignedUploadUrl(file) {
			calls.push(['createSignedUploadUrl', file]);
			if (fail.sign) return fail.sign;
			return {
				ok: true,
				status: 200,
				body: {
					data: {
						url: 'https://storage.test/put/abc',
						headers: { 'Content-Type': file.content_type },
						signed_id: 'signed-abc'
					}
				}
			};
		},
		async createGalleryItem(galleryId, caption, alt) {
			calls.push(['createGalleryItem', galleryId, caption, alt]);
			if (fail.createItem) return fail.createItem;
			return { ok: true, status: 200, body: { data: { id: NEW_ITEM } } };
		},
		async createMedium(body) {
			calls.push(['createMedium', body]);
			if (fail.medium) return fail.medium;
			return { ok: true, status: 200, body: { data: { id: 'medium-1' } } };
		},
		async deleteGalleryItem(id) {
			calls.push(['deleteGalleryItem', id]);
			if (fail.deleteItem) return fail.deleteItem;
			return { ok: true, status: 200, body: { data: { id } } };
		}
	};
}

function ctxWith(calls, fail) {
	return {
		allowedOrigins: parseAllowedOrigins(ORIGIN),
		reviewOnlyFields: [],
		sessions: createMemorySessionStore(),
		auth: {
			async passwordGrant() {
				return null;
			},
			async refreshGrant() {
				return null;
			},
			async staffsMe() {
				return null;
			},
			async revoke() {}
		},
		createApexClient: () => apexWith(calls, fail)
	};
}

async function signIn(ctx) {
	const secret = createSessionSecret();
	const now = Date.now();
	await ctx.sessions.create({
		id: await sessionIdFor(secret),
		createdAt: now,
		lastSeenAt: now,
		expiresAt: now + 3600_000,
		staffEmail: 'e@site.test',
		staffId: 'aaaaaaaa-1111-4222-8333-444444444444',
		staffName: 'E',
		accessToken: 't',
		tokenType: 'Bearer',
		accessExpiresAt: now + 3600_000,
		refreshToken: 'r'
	});
	return secret;
}

function req(session, path, body) {
	return new Request(`${ORIGIN}${path}`, {
		method: 'POST',
		headers: {
			origin: ORIGIN,
			'sec-fetch-site': 'same-origin',
			'x-csrf-token': CSRF,
			'content-type': 'application/json',
			cookie: `apex_admin_session=${session}; apex_bff_csrf=${CSRF}`
		},
		body: JSON.stringify(body)
	});
}

const goodFile = {
	byte_size: 1024,
	content_type: 'image/png',
	filename: 'hero.png',
	checksum: 'Q2hlY2tzdW0='
};

async function sign(body, { calls = [], fail } = {}) {
	const ctx = ctxWith(calls, fail);
	const session = await signIn(ctx);
	const response = await handleSignMediaUpload(req(session, '/api/admin/media/uploads', body), ctx);
	return { response, body: await response.json().catch(() => null), calls };
}

async function finalize(body, { calls = [], fail } = {}) {
	const ctx = ctxWith(calls, fail);
	const session = await signIn(ctx);
	const response = await handleFinalizeMediaUpload(req(session, '/api/admin/media', body), ctx);
	return { response, body: await response.json().catch(() => null), calls };
}

describe('sign — it creates nothing, and that is the guarantee', () => {
	it('mints a URL on the happy path and creates NO gallery item', async () => {
		const { response, body, calls } = await sign({ gallery: 'images', file: goodFile });
		assert.equal(response.status, 200);
		assert.equal(body.uploadUrl, 'https://storage.test/put/abc');
		assert.equal(body.signedId, 'signed-abc');
		// The old design answered a `galleryItemId` here. Nothing is created now, so
		// there is none — and a caller that still reads one gets `undefined`, loudly.
		assert.equal(body.galleryItemId, undefined);
		assert.deepEqual(
			calls.map((c) => c[0]),
			['createSignedUploadUrl']
		);
	});

	it('leaves NO gallery item behind when the sign leg fails', async () => {
		const { response, body, calls } = await sign(
			{ gallery: 'images', file: goodFile },
			{
				fail: {
					sign: {
						ok: false,
						status: 422,
						body: { message: 'Content type image/avif is not a valid kind' }
					}
				}
			}
		);
		// A 422 is Apex judging the request, so it stays a 422 — and carries the reason,
		// which is the entire point: an editor learns WHY, not just "upstream error".
		assert.equal(response.status, 422);
		assert.equal(body.error, 'Content type image/avif is not a valid kind');
		assert.ok(
			!calls.some((c) => c[0] === 'createGalleryItem'),
			'a failed sign must create no gallery item'
		);
	});

	it('digs the reason out of every failure shape Rails uses', async () => {
		// Three shapes, all seen from this API. The last two are the reason the errors
		// branch needs braces: with a dangling `else` the string form binds to the inner
		// `if` and is silently dropped, and the editor gets "upstream error" instead.
		const shapes = [
			[
				{ message: 'Content type image/avif is not a valid kind' },
				'Content type image/avif is not a valid kind'
			],
			[
				{ errors: { content_type: ['image/avif is not a valid kind'] } },
				'image/avif is not a valid kind'
			],
			[
				{ errors: { content_type: 'image/avif is not a valid kind' } },
				'image/avif is not a valid kind'
			],
			[{ data: [{ attribute_name: 'file', messages: ['File is too big'] }] }, 'File is too big'],
			// Nothing recognisable is still an honest answer, not a crash.
			[null, 'upstream error']
		];
		for (const [apexBody, expected] of shapes) {
			const { body } = await sign(
				{ gallery: 'images', file: goodFile },
				{ fail: { sign: { ok: false, status: 422, body: apexBody } } }
			);
			assert.equal(body.error, expected);
		}
	});

	it('does not echo a 401 or 403 from Apex as the browser’s own status', async () => {
		// Echoing these would read to the admin as "your session ended", which is a
		// different and misleading thing. The message still comes through.
		const { response, body } = await sign(
			{ gallery: 'images', file: goodFile },
			{ fail: { sign: { ok: false, status: 403, body: { message: 'forbidden upstream' } } } }
		);
		assert.equal(response.status, 502);
		assert.equal(body.error, 'forbidden upstream');
	});

	it('refuses an unknown gallery name with no upstream call at all', async () => {
		const { response, body, calls } = await sign({ gallery: 'documents', file: goodFile });
		assert.equal(response.status, 400);
		assert.equal(body.error, 'no-such-gallery');
		assert.deepEqual(calls, []);
	});

	it('enforces the type list server-side, bypassing the browser check entirely', async () => {
		// Called directly with a body a browser would never build: these are the two
		// types Apex ITSELF accepts and this kit refuses, so only the server check
		// stands between them and storage.
		for (const content_type of ['image/svg+xml', 'image/*']) {
			const { response, body, calls } = await sign({
				gallery: 'images',
				file: { ...goodFile, content_type }
			});
			assert.equal(response.status, 400, `${content_type} must be refused`);
			assert.equal(body.error, 'type-not-allowed');
			assert.deepEqual(calls, [], 'a refusal costs no upstream call');
		}
		// And a type in the wrong gallery: an MP4 is fine in videos, not in images.
		const wrongGallery = await sign({
			gallery: 'images',
			file: { ...goodFile, content_type: 'video/mp4' }
		});
		assert.equal(wrongGallery.body.error, 'type-not-allowed');
		const rightGallery = await sign({
			gallery: 'videos',
			file: { ...goodFile, content_type: 'video/mp4' }
		});
		assert.equal(rightGallery.response.status, 200);
	});

	it('enforces the size limit server-side, at the exact boundary', async () => {
		const at = await sign({
			gallery: 'files',
			file: { ...goodFile, content_type: 'application/pdf', byte_size: UPLOAD_LIMIT_BYTES }
		});
		assert.equal(at.response.status, 400);
		assert.equal(at.body.error, 'too-large');
		assert.deepEqual(at.calls, []);

		const under = await sign({
			gallery: 'files',
			file: { ...goodFile, content_type: 'application/pdf', byte_size: UPLOAD_LIMIT_BYTES - 1 }
		});
		assert.equal(under.response.status, 200, 'one byte under the limit must be signed');
	});

	it('refuses a body carrying the old design’s keys', async () => {
		// `.strict()` on a body that is otherwise entirely valid — the caption and the
		// gallery id used to travel here, and a stale caller must fail loudly rather
		// than have them silently ignored.
		const { response, calls } = await sign({
			gallery: 'images',
			file: goodFile,
			title: 'Hero',
			galleryId: G.images
		});
		assert.equal(response.status, 400);
		assert.deepEqual(calls, []);
	});
});

describe('finalize — it creates the item, and cleans up only what it made', () => {
	it('resolves the gallery by name and creates the item there, then the medium', async () => {
		const { response, body, calls } = await finalize({
			gallery: 'videos',
			signedId: 'signed-abc',
			title: 'A clip',
			alt: ''
		});
		assert.equal(response.status, 200);
		assert.equal(body.galleryItemId, NEW_ITEM);
		assert.equal(body.mediumId, 'medium-1');
		assert.deepEqual(
			calls.map((c) => c[0]),
			['readCmsConfig', 'createGalleryItem', 'createMedium']
		);
		// The id is the ACCOUNT's videos gallery, resolved from cms_config — never a
		// literal, and never the images gallery by accident.
		assert.equal(calls[1][1], G.videos);
		assert.equal(calls[1][2], 'A clip');
		assert.deepEqual(calls[2][1], {
			kind: 'primary',
			file: 'signed-abc',
			record_id: NEW_ITEM,
			record_type: 'Cms::GalleryItem'
		});
	});

	it('deletes the item it just created when the medium fails', async () => {
		const { response, body, calls } = await finalize(
			{ gallery: 'images', signedId: 'signed-abc', title: 'Orphan' },
			{
				fail: {
					medium: {
						ok: false,
						status: 422,
						body: {
							data: [
								{ attribute_name: 'file', messages: ['File file size must be less than 25 MB'] }
							]
						}
					}
				}
			}
		);
		assert.equal(response.status, 422);
		assert.equal(body.error, 'File file size must be less than 25 MB');
		assert.deepEqual(
			calls.map((c) => c[0]),
			['readCmsConfig', 'createGalleryItem', 'createMedium', 'deleteGalleryItem']
		);
		// The item deleted is the one this op made, by id — no sweep, no guessing.
		assert.equal(calls[3][1], NEW_ITEM);
	});

	it('still reports Apex’s reason when the cleanup delete itself fails', async () => {
		const { response, body, calls } = await finalize(
			{ gallery: 'images', signedId: 'signed-abc' },
			{
				fail: {
					medium: { ok: false, status: 422, body: { message: 'nope' } },
					deleteItem: { ok: false, status: 500, body: null }
				}
			}
		);
		// The editor is told why the UPLOAD failed, not why the cleanup failed — the
		// first is actionable, the second is ours to see in the audit detail.
		assert.equal(response.status, 422);
		assert.equal(body.error, 'nope');
		assert.equal(calls.at(-1)[0], 'deleteGalleryItem');
	});

	it('answers 502 when cms_config cannot be read, and creates nothing', async () => {
		const { response, body, calls } = await finalize(
			{ gallery: 'images', signedId: 'signed-abc' },
			{ fail: { cmsConfig: true } }
		);
		// An UPSTREAM fault, not a bad request: the name was one this kit serves.
		assert.equal(response.status, 502);
		assert.equal(body.error, 'upstream error');
		assert.deepEqual(
			calls.map((c) => c[0]),
			['readCmsConfig']
		);
	});

	it('refuses an unknown gallery name with no upstream call', async () => {
		const { response, body, calls } = await finalize({
			gallery: 'documents',
			signedId: 'signed-abc'
		});
		assert.equal(response.status, 400);
		assert.equal(body.error, 'no-such-gallery');
		assert.deepEqual(calls, []);
	});

	it('refuses a body carrying the old design’s galleryItemId', async () => {
		const { response, calls } = await finalize({
			gallery: 'images',
			signedId: 'signed-abc',
			galleryItemId: NEW_ITEM
		});
		assert.equal(response.status, 400);
		assert.deepEqual(calls, []);
	});

	it('leaves no item when the item creation itself fails', async () => {
		const { response, calls } = await finalize(
			{ gallery: 'images', signedId: 'signed-abc' },
			{ fail: { createItem: { ok: false, status: 500, body: null } } }
		);
		assert.equal(response.status, 502);
		assert.ok(!calls.some((c) => c[0] === 'createMedium'));
		assert.ok(!calls.some((c) => c[0] === 'deleteGalleryItem'), 'nothing was created to delete');
	});
});
