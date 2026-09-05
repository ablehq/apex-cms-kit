// @ts-nocheck — node:test suite over dynamic JSON shapes; behavior is the contract.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	GALLERY_NAMES,
	handleListImages,
	readGalleryId,
	readImagesGalleryId
} from '../src/server/bff/operations/list-gallery-images.ts';
import { handleUpdateImage } from '../src/server/bff/operations/update-gallery-image.ts';
import { handleDeleteImage } from '../src/server/bff/operations/delete-gallery-image.ts';
import { createApexAdminClient } from '../src/server/bff/apex-admin-client.ts';
import { createSessionSecret, sessionIdFor } from '../src/server/bff/session.ts';
import { parseAllowedOrigins } from '../src/server/bff/boundary.ts';
import { createMemorySessionStore } from './harness/session-store.ts';

const ORIGIN = 'https://site.test';
const CSRF = 'csrf-gallery';
const G = {
	images: '11111111-1111-4111-8111-111111111111',
	videos: '22222222-2222-4222-8222-222222222222',
	files: '33333333-3333-4333-8333-333333333333'
};
const IMG = 'aaaaaaaa-0000-4000-8000-000000000001';
const VID = 'bbbbbbbb-0000-4000-8000-000000000002';
const FILE = 'cccccccc-0000-4000-8000-000000000003';

/**
 * Three galleries, one item each. `listGalleryItems` filters by gallery id the way
 * Apex does — that filter is what the membership check relies on. Every write is
 * recorded, so a refusal can be proved to have made NO upstream write (the check
 * itself necessarily reads `cms_config` and lists the gallery).
 */
function apexWith(calls) {
	const items = [
		{
			id: IMG,
			gallery_id: G.images,
			caption: 'An image',
			alt: 'alt',
			position: 1,
			created_at: '2026-01-01',
			medium: { file: { key: 'images/an-image.jpg' } }
		},
		{
			id: VID,
			gallery_id: G.videos,
			caption: 'A video',
			alt: '',
			position: 1,
			created_at: '2026-01-02'
		},
		{
			id: FILE,
			gallery_id: G.files,
			caption: 'A file',
			alt: '',
			position: 1,
			created_at: '2026-01-03'
		}
	];
	return {
		async readCmsConfig() {
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
		async listGalleryItems(galleryId) {
			calls.push(['listGalleryItems', galleryId]);
			return {
				ok: true,
				status: 200,
				body: { data: items.filter((it) => it.gallery_id === galleryId) }
			};
		},
		async updateGalleryItem(id, fields) {
			calls.push(['updateGalleryItem', id, fields]);
			return { ok: true, status: 200, body: { data: { id } } };
		},
		async deleteGalleryItem(id) {
			calls.push(['deleteGalleryItem', id]);
			return { ok: true, status: 200, body: { data: { id } } };
		}
	};
}

function ctxWith(calls, audit) {
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
		createApexClient: () => apexWith(calls),
		assetsPrefix: 'https://cdn.test',
		db: audit
			? {
					prepare: () => ({
						bind: (...args) => ({
							async run() {
								audit.push(args);
								return { success: true, meta: { changes: 1 } };
							}
						})
					})
				}
			: undefined
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

function req(session, path, method = 'GET', body) {
	return new Request(`${ORIGIN}${path}`, {
		method,
		headers: {
			origin: ORIGIN,
			'sec-fetch-site': 'same-origin',
			'x-csrf-token': CSRF,
			'content-type': 'application/json',
			cookie: `apex_admin_session=${session}; apex_bff_csrf=${CSRF}`
		},
		body: body === undefined ? undefined : JSON.stringify(body)
	});
}

describe('gallery resolution by name', () => {
	it('resolves each named gallery, and only those', async () => {
		const apex = apexWith([]);
		for (const name of GALLERY_NAMES) assert.equal(await readGalleryId(apex, name), G[name]);
		// An unknown name is null — never a fallback to images.
		assert.equal(await readGalleryId(apex, 'documents'), null);
		// The original positional helper still answers images.
		assert.equal(await readImagesGalleryId(apex), G.images);
	});

	it('lists by name, defaults to images, and refuses an unknown gallery', async () => {
		const calls = [];
		const ctx = ctxWith(calls);
		const session = await signIn(ctx);
		const legacy = await (await handleListImages(req(session, '/api/admin/images'), ctx)).json();
		assert.equal(legacy.gallery, 'images');
		assert.deepEqual(
			legacy.images.map((i) => i.id),
			[IMG]
		);
		assert.ok(
			legacy.images[0].url?.startsWith('https://cdn.test/cdn-cgi/image/'),
			'images get a thumbnail URL'
		);
		const files = await (
			await handleListImages(req(session, '/api/admin/galleries/files'), ctx, { gallery: 'files' })
		).json();
		assert.deepEqual(
			files.items.map((i) => i.id),
			[FILE]
		);
		assert.equal(files.items[0].url, null, 'a file gets no image-transform URL');
		const bogus = await handleListImages(req(session, '/api/admin/galleries/documents'), ctx, {
			gallery: 'documents'
		});
		assert.equal(bogus.status, 404);
	});
});

describe('cross-gallery membership — the check every edit and delete stands on', () => {
	for (const [op, run] of [
		['update', (r, ctx, id, g) => handleUpdateImage(r, ctx, { imageId: id }, { gallery: g })],
		['delete', (r, ctx, id, g) => handleDeleteImage(r, ctx, { imageId: id }, { gallery: g })]
	]) {
		it(`${op}: an item from ANOTHER gallery is refused with no upstream write`, async () => {
			const calls = [];
			const ctx = ctxWith(calls);
			const session = await signIn(ctx);
			// The video, addressed through the files screen.
			const method = op === 'update' ? 'PATCH' : 'DELETE';
			const body = op === 'update' ? { caption: 'x' } : undefined;
			const res = await run(
				req(session, `/api/admin/galleries/files/${VID}`, method, body),
				ctx,
				VID,
				'files'
			);
			assert.equal(res.status, 404);
			const writes = calls.filter(
				([name]) => name === 'updateGalleryItem' || name === 'deleteGalleryItem'
			);
			assert.deepEqual(writes, [], `${op} must not reach Apex for a foreign item`);
			// And the check consulted the REQUESTED gallery, not images.
			assert.deepEqual(
				calls.filter(([n]) => n === 'listGalleryItems').map(([, id]) => id),
				[G.files]
			);
		});

		it(`${op}: its own item is accepted, and audited under the gallery actually addressed`, async () => {
			const calls = [];
			const audit = [];
			const ctx = ctxWith(calls, audit);
			const session = await signIn(ctx);
			const method = op === 'update' ? 'PATCH' : 'DELETE';
			const body = op === 'update' ? { caption: 'renamed' } : undefined;
			const res = await run(
				req(session, `/api/admin/galleries/files/${FILE}`, method, body),
				ctx,
				FILE,
				'files'
			);
			assert.equal(res.status, 200);
			const row = audit[0];
			assert.ok(row, 'an audit row was written');
			assert.ok(row.includes(`files.${op}`), `audit action names the gallery: ${row.join('|')}`);
			assert.ok(
				row.some((v) => typeof v === 'string' && v.startsWith('/api/admin/galleries/files/')),
				'audit path is the route addressed'
			);
		});
	}

	it('the default gallery is still images, so the shipped routes are unchanged', async () => {
		const calls = [];
		const ctx = ctxWith(calls);
		const session = await signIn(ctx);
		const res = await handleUpdateImage(
			req(session, `/api/admin/images/${IMG}`, 'PATCH', { caption: 'c' }),
			ctx,
			{ imageId: IMG }
		);
		assert.equal(res.status, 200);
		// Two lists — the membership check, then the gallery-scoped re-read after the
		// write — and BOTH must be the images gallery.
		const listed = calls.filter(([n]) => n === 'listGalleryItems').map(([, id]) => id);
		assert.ok(listed.length >= 1);
		assert.deepEqual([...new Set(listed)], [G.images]);
	});
});

describe('the Apex client', () => {
	it('lists every page of a gallery, not the first 500', async () => {
		const seen = [];
		const client = createApexAdminClient({
			baseUrl: 'https://apex.test',
			token: 'tok',
			fetchImpl: async (url) => {
				const page = Number(new URL(url).searchParams.get('page'));
				seen.push(page);
				const data = page === 1 ? [{ id: 'p1' }] : [{ id: 'p2' }];
				return new Response(JSON.stringify({ data, pagination: { total_pages: 2 } }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				});
			}
		});
		const res = await client.listGalleryItems(G.images);
		assert.deepEqual(seen, [1, 2]);
		assert.deepEqual(
			res.body.data.map((r) => r.id),
			['p1', 'p2']
		);
	});

	it('renames a tag with a PATCH to /tags/:id carrying only the name', async () => {
		let captured;
		const client = createApexAdminClient({
			baseUrl: 'https://apex.test',
			token: 'tok',
			fetchImpl: async (url, init) => {
				captured = { url: String(url), method: init.method, body: init.body };
				return new Response(JSON.stringify({ data: { id: G.images, name: 'Renamed' } }), {
					status: 200,
					headers: { 'content-type': 'application/json' }
				});
			}
		});
		const res = await client.updateTag(G.images, 'Renamed');
		assert.equal(res.ok, true);
		assert.equal(captured.method, 'PATCH');
		assert.ok(captured.url.endsWith(`/api/platform/v1/tags/${G.images}`));
		assert.deepEqual(JSON.parse(captured.body), { name: 'Renamed' });
	});
});
