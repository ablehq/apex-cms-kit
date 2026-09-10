// @ts-nocheck — node:test suite over dynamic JSON shapes; behaviour is the contract.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	handleSignMediaUpload,
	handleFinalizeMediaUpload
} from '../src/server/bff/operations/media.ts';
import { CAPTION_MAX_LENGTH, galleryMedia, UPLOAD_LIMIT_BYTES } from '../src/admin/media-types.js';
import { createSessionSecret, sessionIdFor } from '../src/server/bff/session.ts';
import { parseAllowedOrigins } from '../src/server/bff/boundary.ts';
import { barrierOn, createMigratedDatabase } from './harness/d1.ts';
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

function ctxWith(calls, fail, db) {
	return {
		allowedOrigins: parseAllowedOrigins(ORIGIN),
		...(db ? { db } : {}),
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

/** A file each gallery actually accepts, so a claim can be minted for any of them. */
const FILE_FOR = {
	images: goodFile,
	files: { ...goodFile, content_type: 'application/pdf', filename: 'notes.pdf' },
	videos: { ...goodFile, content_type: 'video/mp4', filename: 'clip.mp4' }
};

/**
 * `db` is `undefined` for "give me a fresh migrated one" and `null` for "run without
 * a claim store at all", which is a case with its own required behaviour (refuse).
 */
async function databaseFor(db) {
	return db === undefined ? await createMigratedDatabase() : db;
}

async function sign(body, { calls = [], fail, db } = {}) {
	const database = await databaseFor(db);
	const ctx = ctxWith(calls, fail, database);
	const session = await signIn(ctx);
	const response = await handleSignMediaUpload(req(session, '/api/admin/media/uploads', body), ctx);
	return { response, body: await response.json().catch(() => null), calls, db: database };
}

/**
 * Finalize a signed id that has been through the REAL sign leg first — because that
 * is where its claim comes from, and a finalize whose signed id was never signed for
 * anything is now a different test rather than the default one. `mintClaim: false`
 * asks for exactly that case.
 */
async function finalize(body, { calls = [], fail, db, mintClaim = true } = {}) {
	const database = await databaseFor(db);
	if (mintClaim && database && galleryMedia(body.gallery)) {
		// A clean context for the sign leg: this suite's `fail` switches describe what
		// the FINALIZE is up against, and the mint is only setting the scene.
		await sign({ gallery: body.gallery, file: FILE_FOR[body.gallery] }, { db: database });
	}
	const ctx = ctxWith(calls, fail, database);
	const session = await signIn(ctx);
	const response = await handleFinalizeMediaUpload(req(session, '/api/admin/media', body), ctx);
	return { response, body: await response.json().catch(() => null), calls, db: database };
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
		// `readCmsConfig` FIRST: the destination is resolved before the bytes are
		// invited. It is a read; nothing is created on this leg either way.
		assert.deepEqual(
			calls.map((c) => c[0]),
			['readCmsConfig', 'createSignedUploadUrl']
		);
	});

	/**
	 * NO DESTINATION, NO SIGNED URL — the refusal that used to arrive a whole upload
	 * too late.
	 *
	 * `readGalleryId` ran only in finalize, so an account without the gallery (or one
	 * whose `cms_config` would not read) got a signed URL, an unattached
	 * ActiveStorage blob and a complete upload of the file, and the FIRST thing that
	 * failed was the finalize after all of it (codex's P5 fix review, 2026-09-08).
	 *
	 * MUTATION: move the `readGalleryId` refusal back below `createSignedUploadUrl`.
	 * Both cases still answer 502 — which is exactly why neither asserts on the
	 * status alone; both fail on `calls`, because the signed URL was minted first.
	 */
	it('refuses BEFORE signing when the account has no such gallery', async () => {
		// `cms_config` reads, and names no gallery by this name. The assertion is on
		// `calls`, not on the status: a 502 that arrives AFTER the signed URL has been
		// handed out is the defect, and it answers 502 too.
		const calls = [];
		const emptyConfig = {
			async readCmsConfig() {
				calls.push(['readCmsConfig']);
				return { ok: true, status: 200, body: { data: { asset_library: [] } } };
			},
			async createSignedUploadUrl() {
				calls.push(['createSignedUploadUrl']);
				return {
					ok: true,
					status: 200,
					body: { data: { url: 'https://storage.test/put/abc', signed_id: 'signed-abc' } }
				};
			}
		};
		const db = await createMigratedDatabase();
		const ctx = { ...ctxWith([], undefined, db), createApexClient: () => emptyConfig };
		const response = await handleSignMediaUpload(
			req(await signIn(ctx), '/api/admin/media/uploads', { gallery: 'images', file: goodFile }),
			ctx
		);
		assert.equal(response.status, 502);
		assert.match((await response.json()).error, /no “images” library/u);
		assert.deepEqual(
			calls.map((c) => c[0]),
			['readCmsConfig'],
			'no signed URL was minted, so no bytes were ever invited'
		);
		// And no claim was written, so nothing can be finalized against this attempt.
		assert.equal(
			db.sqlite.prepare('SELECT COUNT(*) AS n FROM bff_media_upload_claim').get().n,
			0,
			'a refused sign mints no claim'
		);
		db.close();
	});

	it('refuses BEFORE signing when `cms_config` will not read', async () => {
		const calls = [];
		const { response } = await sign(
			{ gallery: 'images', file: goodFile },
			{ calls, fail: { cmsConfig: true } }
		);
		assert.equal(response.status, 502);
		assert.deepEqual(
			calls.map((c) => c[0]),
			['readCmsConfig'],
			'the signing leg was never reached'
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

describe('the signed id is bound to one gallery and one redemption', () => {
	/** Which claims the store holds, and which of them are spent. */
	function claims(db) {
		return db.sqlite
			.prepare(`SELECT gallery, redeemed_at FROM bff_media_upload_claim`)
			.all()
			.map((row) => ({ ...row }));
	}

	it('refuses a signed id finalized into a gallery it was NOT signed for', async () => {
		// Measured against local Apex before this guard existed: a PNG signed for
		// `images` finalized into `videos` with a 200, because the only thing linking
		// the two legs was a token that records neither.
		const db = await createMigratedDatabase();
		await sign({ gallery: 'images', file: goodFile }, { db });

		const calls = [];
		const { response, body } = await finalize(
			{ gallery: 'videos', signedId: 'signed-abc' },
			{ db, calls, mintClaim: false }
		);
		assert.equal(response.status, 400);
		assert.match(body.error, /prepared for a different library/u);
		assert.deepEqual(calls, [], 'a refused signed id costs no upstream call');
		// And the claim is still spendable — by the library it was actually signed for.
		assert.deepEqual(claims(db), [{ gallery: 'images', redeemed_at: null }]);
	});

	it('refuses the SECOND redemption of one signed id', async () => {
		const db = await createMigratedDatabase();
		await sign({ gallery: 'images', file: goodFile }, { db });

		const first = await finalize(
			{ gallery: 'images', signedId: 'signed-abc', title: 'Once' },
			{ db, mintClaim: false }
		);
		assert.equal(first.response.status, 200);

		const calls = [];
		const second = await finalize(
			{ gallery: 'images', signedId: 'signed-abc', title: 'Twice' },
			{ db, calls, mintClaim: false }
		);
		// Two items sharing one blob is the live hazard: `Medium` is
		// `has_one_attached :file, dependent: :purge_later`, so deleting either one
		// purges the bytes the other still points at.
		assert.equal(second.response.status, 400);
		assert.match(second.body.error, /already been saved/u);
		assert.deepEqual(calls, [], 'the second redemption reaches Apex not at all');
	});

	it('lets exactly ONE of two concurrent finalizes through', async () => {
		// The property under test belongs to the STATEMENT, not to the handler: a
		// SELECT followed by an UPDATE would let both of these past, because the
		// window between the two halves spans an await.
		//
		// The barrier is what makes that testable. Left to the scheduler these two
		// requests do not interleave at all — the first gets through both halves
		// before the second reaches either, and a deliberately racy implementation
		// passed this test three runs out of three. `barrierOn` holds BOTH requests at
		// their first claim statement and releases them together, which is the only
		// arrangement in which "read, then write" can be caught.
		const db = await createMigratedDatabase();
		await sign({ gallery: 'files', file: FILE_FOR.files }, { db });

		const calls = [];
		const ctx = ctxWith(calls, undefined, db);
		const session = await signIn(ctx);
		barrierOn(db, 'bff_media_upload_claim');
		const race = () =>
			handleFinalizeMediaUpload(
				req(session, '/api/admin/media', { gallery: 'files', signedId: 'signed-abc' }),
				ctx
			);
		const [a, b] = await Promise.all([race(), race()]);

		const statuses = [a.status, b.status].sort();
		assert.deepEqual(statuses, [200, 400]);
		assert.equal(
			calls.filter((c) => c[0] === 'createGalleryItem').length,
			1,
			'exactly one gallery item may be created for one set of bytes'
		);
		assert.equal(calls.filter((c) => c[0] === 'createMedium').length, 1);
		assert.equal(claims(db).length, 1);
	});

	it('refuses a signed id this deployment never minted', async () => {
		const calls = [];
		const { response, body } = await finalize(
			{ gallery: 'images', signedId: 'not-a-real-signed-id' },
			{ calls, mintClaim: false }
		);
		assert.equal(response.status, 400);
		assert.match(body.error, /could not be matched/u);
		assert.deepEqual(calls, []);
	});

	it('refuses a claim that has expired, and sweeps it on the next sign', async () => {
		const db = await createMigratedDatabase();
		await sign({ gallery: 'images', file: goodFile }, { db });
		db.sqlite.exec(`UPDATE bff_media_upload_claim SET expires_at = 1`);

		const { response, body } = await finalize(
			{ gallery: 'images', signedId: 'signed-abc' },
			{ db, mintClaim: false }
		);
		assert.equal(response.status, 400);
		assert.match(body.error, /prepared too long ago/u);

		// The sweep runs on the sign path, so the next upload clears it out.
		await sign({ gallery: 'images', file: goodFile }, { db });
		assert.deepEqual(claims(db), [{ gallery: 'images', redeemed_at: null }]);
	});

	it('stores NO claim when the sign leg itself fails', async () => {
		const db = await createMigratedDatabase();
		const { response } = await sign(
			{ gallery: 'images', file: goodFile },
			{ db, fail: { sign: { ok: false, status: 422, body: { message: 'nope' } } } }
		);
		assert.equal(response.status, 422);
		assert.deepEqual(claims(db), []);
	});

	it('fails CLOSED on both legs when there is no claim store', async () => {
		// A deployment with no D1 binding cannot check a signed id, so it must not
		// mint one either: an unbound capability is exactly what the claim prevents.
		const signed = await sign({ gallery: 'images', file: goodFile }, { db: null });
		assert.equal(signed.response.status, 500);
		assert.deepEqual(signed.calls, [], 'nothing is signed that could not be claimed');

		const finalized = await finalize(
			{ gallery: 'images', signedId: 'signed-abc' },
			{ db: null, mintClaim: false }
		);
		assert.equal(finalized.response.status, 500);
		assert.deepEqual(finalized.calls, []);
	});

	it('answers 502 rather than a claimless 200 when Apex returns no signed id', async () => {
		const db = await createMigratedDatabase();
		const { response, body } = await sign(
			{ gallery: 'images', file: goodFile },
			{ db, fail: { sign: { ok: true, status: 200, body: { data: { url: null } } } } }
		);
		assert.equal(response.status, 502);
		assert.equal(body.error, 'unexpected upstream shape');
		assert.deepEqual(claims(db), []);
	});
});

describe('a refused body is a sentence, not a machine code', () => {
	it('names the caption, and says how long is too long', async () => {
		// Reachable by PASTE from every caption box in both sites, and reached only
		// AFTER the bytes are uploaded — so what this string says is the entire
		// explanation an editor gets for losing an upload. It used to say
		// "invalid body".
		const { response, body, calls } = await finalize({
			gallery: 'images',
			signedId: 'signed-abc',
			title: 'x'.repeat(CAPTION_MAX_LENGTH + 1)
		});
		assert.equal(response.status, 400);
		assert.equal(body.error, 'That caption is too long. Keep it to 300 characters or fewer.');
		assert.deepEqual(calls, []);
	});

	it('names the alt text when that is the field that is too long', async () => {
		const { body } = await finalize({
			gallery: 'images',
			signedId: 'signed-abc',
			alt: 'x'.repeat(CAPTION_MAX_LENGTH + 1)
		});
		assert.equal(body.error, 'That alt text is too long. Keep it to 300 characters or fewer.');
	});

	it('names the file name on the sign leg, where the cap is also reachable', async () => {
		const { response, body } = await sign({
			gallery: 'images',
			file: { ...goodFile, filename: `${'x'.repeat(400)}.png` }
		});
		assert.equal(response.status, 400);
		assert.equal(body.error, 'That file name is too long. Rename the file and try again.');
	});

	it('still answers a sentence for a shape it has no specific words for', async () => {
		// A stale caller sending the old design's key. There is nothing useful to say
		// about it to an EDITOR, but "invalid body" is not a thing to say to a person.
		const { response, body } = await finalize({
			gallery: 'images',
			signedId: 'signed-abc',
			galleryItemId: NEW_ITEM
		});
		assert.equal(response.status, 400);
		assert.equal(body.error, 'That upload could not be saved as sent.');
	});
});

describe('an item created but not NAMED is still swept, and still audited', () => {
	/** The finalize rows this op wrote, newest last. */
	function finalizeAudit(db) {
		return db.sqlite
			.prepare(
				`SELECT outcome, detail FROM bff_audit_log
				  WHERE action = 'media.upload.finalize' ORDER BY occurred_at, rowid`
			)
			.all()
			.map((row) => ({ outcome: row.outcome, detail: JSON.parse(row.detail ?? 'null') }));
	}

	it('deletes the item and writes the audit row when the id is the wrong type', async () => {
		// Apex says 2xx, so an item exists; the envelope just does not name it in a way
		// this op can use. Both neighbours of this branch sweep and audit; it did
		// neither, which left an orphan nothing recorded.
		const { response, body, calls, db } = await finalize(
			{ gallery: 'images', signedId: 'signed-abc', title: 'Unnamed' },
			{ fail: { createItem: { ok: true, status: 200, body: { data: { id: 42 } } } } }
		);
		assert.equal(response.status, 502);
		assert.equal(body.error, 'unexpected upstream shape');
		assert.deepEqual(
			calls.map((c) => c[0]),
			['readCmsConfig', 'createGalleryItem', 'deleteGalleryItem']
		);
		assert.equal(calls[2][1], '42', 'an id of the wrong type is still an id to delete by');
		assert.ok(
			!calls.some((c) => c[0] === 'createMedium'),
			'nothing is attached to an item this op cannot name'
		);

		const rows = finalizeAudit(db);
		assert.equal(rows.length, 1);
		assert.equal(rows[0].outcome, 'apex_error');
		assert.equal(rows[0].detail.unnamedItem, true);
		assert.equal(rows[0].detail.itemDeleted, true);
		// The caption is the only handle a person has on an item nothing can name.
		assert.equal(rows[0].detail.caption, 'Unnamed');
	});

	it('audits it even when there is no id to sweep by at all', async () => {
		const { response, calls, db } = await finalize(
			{ gallery: 'images', signedId: 'signed-abc', title: 'Nameless' },
			{ fail: { createItem: { ok: true, status: 200, body: { data: { caption: 'Nameless' } } } } }
		);
		assert.equal(response.status, 502);
		assert.ok(!calls.some((c) => c[0] === 'deleteGalleryItem'), 'there is nothing to delete by');
		const rows = finalizeAudit(db);
		assert.equal(rows.length, 1);
		assert.equal(rows[0].detail.unnamedItem, true);
		assert.equal(rows[0].detail.itemDeleted, false);
	});

	it('treats an empty-string id as no id, rather than deleting by ""', async () => {
		const { response, calls } = await finalize(
			{ gallery: 'images', signedId: 'signed-abc' },
			{ fail: { createItem: { ok: true, status: 200, body: { data: { id: '' } } } } }
		);
		assert.equal(response.status, 502);
		assert.ok(!calls.some((c) => c[0] === 'deleteGalleryItem'));
	});
});

describe('a THROWN upstream call is swept and audited like a returned failure', () => {
	/** The rows one action wrote, newest last. */
	function auditFor(db, action) {
		return db.sqlite
			.prepare(
				`SELECT outcome, detail FROM bff_audit_log
				  WHERE action = ? ORDER BY occurred_at, rowid`
			)
			.all(action)
			.map((row) => ({ outcome: row.outcome, detail: JSON.parse(row.detail ?? 'null') }));
	}

	/** A client whose named method REJECTS, the way the admin transport rethrows. */
	function throwingApex(calls, method) {
		const apex = apexWith(calls);
		const inner = apex[method].bind(apex);
		apex[method] = async (...args) => {
			await inner(...args);
			throw new TypeError('fetch failed');
		};
		return apex;
	}

	async function finalizeThrowing(method, body = { gallery: 'images', signedId: 'signed-abc' }) {
		const db = await createMigratedDatabase();
		const calls = [];
		await sign({ gallery: body.gallery, file: FILE_FOR[body.gallery] }, { db });
		const ctx = ctxWith(calls, undefined, db);
		ctx.createApexClient = () => throwingApex(calls, method);
		const session = await signIn(ctx);
		const response = await handleFinalizeMediaUpload(req(session, '/api/admin/media', body), ctx);
		return { response, body: await response.json().catch(() => null), calls, db };
	}

	it('sweeps the item and audits when the ATTACH throws', async () => {
		// The admin transport rethrows network faults — only the ingest path turns them
		// into typed failures — so a connection reset here used to escape as a framework
		// 500 with the item intact and no finalize audit row at all.
		const { response, body, calls, db } = await finalizeThrowing('createMedium', {
			gallery: 'images',
			signedId: 'signed-abc',
			title: 'Lost attach'
		});
		assert.equal(response.status, 502);
		assert.match(body.error, /Choose the file again/u);
		assert.deepEqual(
			calls.map((c) => c[0]),
			['readCmsConfig', 'createGalleryItem', 'createMedium', 'deleteGalleryItem']
		);
		assert.equal(calls[3][1], NEW_ITEM, 'the item this op made is deleted by id');

		const rows = auditFor(db, 'media.upload.finalize');
		assert.equal(rows.length, 1);
		assert.equal(rows[0].outcome, 'apex_error');
		// Named as UNKNOWN, not as a failure: a lost response leaves the attach
		// genuinely ambiguous, and the row must not claim to know which way it went.
		assert.equal(rows[0].detail.attachOutcome, 'unknown');
		assert.equal(rows[0].detail.itemDeleted, true);
		assert.equal(rows[0].detail.caption, 'Lost attach');
	});

	it('audits when the item CREATE throws, with nothing to sweep by', async () => {
		const { response, calls, db } = await finalizeThrowing('createGalleryItem', {
			gallery: 'files',
			signedId: 'signed-abc',
			title: 'Lost create'
		});
		assert.equal(response.status, 502);
		assert.ok(!calls.some((c) => c[0] === 'deleteGalleryItem'), 'no id came back to delete by');
		assert.ok(!calls.some((c) => c[0] === 'createMedium'));
		const rows = auditFor(db, 'media.upload.finalize');
		assert.equal(rows.length, 1);
		assert.equal(rows[0].detail.itemCreated, 'unknown');
		assert.equal(rows[0].detail.caption, 'Lost create');
	});

	it('answers 502 rather than a framework 500 when cms_config throws', async () => {
		const { response, body, calls } = await finalizeThrowing('readCmsConfig');
		assert.equal(response.status, 502);
		assert.equal(body.error, 'upstream error');
		assert.ok(!calls.some((c) => c[0] === 'createGalleryItem'), 'nothing was created');
	});

	it('audits a thrown SIGN leg, which creates nothing but must still be accounted for', async () => {
		const db = await createMigratedDatabase();
		const calls = [];
		const ctx = ctxWith(calls, undefined, db);
		ctx.createApexClient = () => throwingApex(calls, 'createSignedUploadUrl');
		const session = await signIn(ctx);
		const response = await handleSignMediaUpload(
			req(session, '/api/admin/media/uploads', { gallery: 'images', file: goodFile }),
			ctx
		);
		assert.equal(response.status, 502);
		const rows = auditFor(db, 'media.upload.sign');
		assert.equal(rows.length, 1);
		assert.equal(rows[0].outcome, 'apex_error');
		// And no claim was written for a signed id that never came back.
		assert.deepEqual(
			db.sqlite.prepare(`SELECT id FROM bff_media_upload_claim`).all(),
			[],
			'a sign that threw mints no claim'
		);
	});
});

describe('the two legs of one upload can be read as one attempt', () => {
	function rows(db) {
		return db.sqlite
			.prepare(`SELECT action, outcome, detail FROM bff_audit_log ORDER BY occurred_at, rowid`)
			.all()
			.map((row) => ({
				action: row.action,
				outcome: row.outcome,
				detail: JSON.parse(row.detail ?? 'null')
			}));
	}

	it('ties the sign row and the finalize row together, and never logs the credential', async () => {
		// Before this there was no shared id and the two `cf-ray` values belong to
		// different requests, so two uploads by one editor left four rows nothing could
		// pair up — and an abandoned signing was indistinguishable from a finished one.
		const db = await createMigratedDatabase();
		await sign({ gallery: 'images', file: goodFile }, { db });
		await finalize(
			{ gallery: 'images', signedId: 'signed-abc', title: 'A hero', alt: 'A hero image' },
			{ db, mintClaim: false }
		);

		const [signRow, finalizeRow] = rows(db);
		assert.equal(signRow.action, 'media.upload.sign');
		assert.equal(finalizeRow.action, 'media.upload.finalize');
		assert.equal(signRow.outcome, 'accepted');
		assert.equal(finalizeRow.outcome, 'accepted');
		assert.ok(signRow.detail.attempt, 'the sign row names the attempt');
		assert.equal(finalizeRow.detail.attempt, signRow.detail.attempt, 'and so does its finalize');
		// The attempt id is the claim's key: a one-way hash, so it can be logged. The
		// signed id is a capability to attach a blob and must appear nowhere.
		assert.match(signRow.detail.attempt, /^[0-9a-f]{64}$/u);
		assert.equal(
			db.sqlite.prepare(`SELECT id FROM bff_media_upload_claim`).get().id,
			signRow.detail.attempt
		);
		for (const row of rows(db)) {
			assert.ok(
				!JSON.stringify(row.detail).includes('signed-abc'),
				'the signed id itself is never written to the log'
			);
		}
		// And what the editor actually typed, which is the only human handle on a row.
		assert.equal(finalizeRow.detail.caption, 'A hero');
		assert.equal(finalizeRow.detail.alt, 'A hero image');
	});

	it('shows an abandoned signing as a sign row with no finalize beside it', async () => {
		const db = await createMigratedDatabase();
		await sign({ gallery: 'images', file: goodFile }, { db });
		await sign({ gallery: 'files', file: FILE_FOR.files }, { db });

		const attempts = rows(db)
			.filter((r) => r.action === 'media.upload.sign')
			.map((r) => r.detail.attempt);
		assert.equal(attempts.length, 2);
		// The fake mints one signed id, so the two attempts share a hash — which is
		// itself the honest answer: the same blob was signed for twice.
		assert.equal(rows(db).filter((r) => r.action === 'media.upload.finalize').length, 0);
	});

	it('names the attempt even on a refused finalize, so the refusal pairs with its sign', async () => {
		const db = await createMigratedDatabase();
		await sign({ gallery: 'images', file: goodFile }, { db });
		const { response } = await finalize(
			{ gallery: 'videos', signedId: 'signed-abc' },
			{ db, mintClaim: false }
		);
		assert.equal(response.status, 400);

		const [signRow, refusal] = rows(db);
		assert.equal(refusal.outcome, 'rejected');
		assert.equal(refusal.detail.reason, 'upload-wrong-gallery');
		assert.equal(refusal.detail.attempt, signRow.detail.attempt);
	});
});
