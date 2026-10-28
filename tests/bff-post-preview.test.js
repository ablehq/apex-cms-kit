// @ts-nocheck — this suite drives the real guard, contract check and KV reader.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	collectionsWithSavedPost,
	loadSitePostPreview,
	publishedPostRow,
	referencedGalleryItemIds
} from '../src/server/bff/operations/preview-post.ts';
import { resetContentMemo, readContent } from '../src/server/content/read.ts';
import { createSessionSecret, sessionIdFor } from '../src/server/bff/session.ts';
import { parseAllowedOrigins } from '../src/server/bff/boundary.ts';
import { createMemorySessionStore } from './harness/session-store.ts';

const ORIGIN = 'https://site.test';
const POST = 'dddddddd-1111-2222-3333-444444444444';
const ARCH = 'eeeeeeee-1111-2222-3333-444444444444';
const DOC = 'ffffffff-1111-2222-3333-444444444444';
const OTHER_POST = 'abababab-1111-2222-3333-444444444444';
const COVER_NEW = '33333333-1111-2222-3333-444444444444';
const COVER_OLD = '44444444-1111-2222-3333-444444444444';
const BODY_IMG = '55555555-1111-2222-3333-444444444444';
const GALLERY = 'Cms::DocumentBlock::GalleryItem';
const RICH = 'Cms::DocumentBlock::RichText';

const contract = {
	schema: (slug) =>
		['story', 'update', 'author'].includes(slug)
			? {
					slug,
					display_name: slug,
					target_model: slug === 'author' ? null : 'Cms::Post',
					id: null,
					items: []
				}
			: null,
	isContentLibrarySlug: (slug) => slug === 'author',
	primitiveFieldDefs: () => [],
	referenceItems: () => []
};

function postView(changes = {}) {
	return {
		id: POST,
		title: 'A partnership',
		slug: 'a-partnership',
		status: 'draft',
		updated_at: '2026-10-28T09:00:00.000Z',
		archetype_id: ARCH,
		archetype_schema_slug: 'update',
		document: { id: DOC },
		shared_gallery_items: [{ id: 'join-1', gallery_item_id: COVER_NEW, kind: 'cover' }],
		...changes
	};
}

function archetype(changes = {}) {
	return {
		id: ARCH,
		target_model_id: POST,
		updated_at: '2026-10-28T09:30:00.000Z',
		archetype_items: [],
		taggings: [],
		...changes
	};
}

function documentRow(changes = {}) {
	return {
		id: DOC,
		updated_at: '2026-10-28T09:15:00.000Z',
		blocks: [
			{ id: 'b0', position: 0, blockable_type: RICH, blockable: { content_html: '<p>Hi</p>' } },
			{ id: 'b1', position: 1, blockable_type: GALLERY, blockable: { gallery_item_id: BODY_IMG } }
		],
		...changes
	};
}

function image(id) {
	return {
		id,
		caption: `img ${id.slice(0, 4)}`,
		medium: { file: { key: `key-${id.slice(0, 4)}` } }
	};
}

/**
 * A recording Apex stub answering the four reads the operation makes, plus the
 * snapshot in KV. `apex` overrides any answer.
 */
function harness({ collections, published = true, apex = {}, contractValue = contract } = {}) {
	resetContentMemo();
	const calls = [];
	const answers = {
		listPosts: { ok: true, status: 200, body: { data: [postView()] } },
		getPostArchetype: { ok: true, status: 200, body: { data: archetype() } },
		documents: { ok: true, status: 200, body: { data: [documentRow()] } },
		galleryItems: { ok: true, status: 200, body: { data: [image(COVER_NEW), image(BODY_IMG)] } },
		...apex
	};
	const client = {
		async listPosts(slug, query) {
			calls.push(['listPosts', slug, query]);
			return answers.listPosts;
		},
		async getPostArchetype(slug, id) {
			calls.push(['getPostArchetype', slug, id]);
			return answers.getPostArchetype;
		},
		async get(path, query) {
			calls.push(['get', path, query]);
			if (path.endsWith('/cms/documents/search_and_filter')) return answers.documents;
			if (path.endsWith('/cms/gallery_items/search_and_filter')) {
				if (answers.galleryItems instanceof Error) throw answers.galleryItems;
				return answers.galleryItems;
			}
			throw new Error(`unexpected read ${path}`);
		}
	};
	const snapshotCollections = collections ?? {
		updates: [],
		documents: [],
		archetypes: [],
		images: [image(COVER_OLD)]
	};
	const snapshot = {
		version: 'v1',
		publishedAt: '2026-10-27T00:00:00.000Z',
		publishedBy: 'editor',
		accountId: 'a',
		counts: {},
		warnings: [],
		collections: snapshotCollections
	};
	const ctx = {
		allowedOrigins: parseAllowedOrigins(ORIGIN),
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
		createApexClient: () => client,
		contract: contractValue,
		content: {
			async get() {
				return published ? JSON.stringify(snapshot) : null;
			},
			async put() {}
		}
	};
	return { ctx, calls };
}

async function request(ctx, signed = true) {
	let cookie = '';
	if (signed) {
		const secret = createSessionSecret();
		const now = Date.now();
		await ctx.sessions.create({
			id: await sessionIdFor(secret),
			createdAt: now,
			lastSeenAt: now,
			expiresAt: now + 3600_000,
			staffEmail: 'e@site.test',
			staffId: 'staff-1',
			staffName: 'E',
			accessToken: 't',
			tokenType: 'Bearer',
			accessExpiresAt: now + 3600_000,
			refreshToken: 'r'
		});
		cookie = `apex_admin_session=${secret}`;
	}
	return new Request(`${ORIGIN}/admin/updates/${POST}/preview`, {
		headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', cookie }
	});
}

/**
 * A minimal site adapter: the "public projection" is title + body block count +
 * cover caption, resolved through the images collection the way a site's loader
 * would. It records what it was handed.
 */
function adapter(seen = {}) {
	const project = (collections, post) => {
		const doc = (collections.documents ?? []).find((d) => d.id === post.document?.id);
		const coverId = post.shared_gallery_items?.find((r) => r.kind === 'cover')?.gallery_item_id;
		const cover = (collections.images ?? []).find((i) => i.id === coverId);
		return { title: post.title, blocks: doc?.blocks?.length ?? 0, cover: cover?.caption ?? null };
	};
	return {
		async projectSaved(input) {
			seen.input = input;
			const collections = collectionsWithSavedPost(input, {
				postsCollection: 'updates',
				imagesCollection: 'images'
			});
			const post = collections.updates.find((p) => p.id === input.saved.post.id);
			const value = project(collections, post);
			return { ok: true, payload: { post: value }, comparable: value };
		},
		async publishedComparable(input) {
			const row = publishedPostRow(input, 'updates');
			return row ? project(input.collections, row) : null;
		},
		routable: (post) => post.status === 'published',
		publicPath: (post) => `/blogs/${post.slug}`
	};
}

const params = { schema: 'update', postId: POST };

describe('loadSitePostPreview — refusals', () => {
	it('refuses a signed-out request before Apex is read', async () => {
		const { ctx, calls } = harness();
		const result = await loadSitePostPreview(await request(ctx, false), ctx, params, adapter());
		assert.deepEqual(result, { ok: false, status: 401, reason: 'unauthorized' });
		assert.deepEqual(calls, []);
	});

	it('refuses without a content contract', async () => {
		const { ctx, calls } = harness({ contractValue: null });
		const result = await loadSitePostPreview(await request(ctx), ctx, params, adapter());
		assert.equal(result.status, 500);
		assert.deepEqual(calls, []);
	});

	it('refuses a schema that is not a post schema', async () => {
		const { ctx, calls } = harness();
		for (const schema of ['author', 'nope']) {
			const result = await loadSitePostPreview(
				await request(ctx),
				ctx,
				{ schema, postId: POST },
				adapter()
			);
			assert.deepEqual(result, { ok: false, status: 404, reason: 'unknown collection' });
		}
		assert.deepEqual(calls, []);
	});

	it('refuses an id that is not a uuid', async () => {
		const { ctx, calls } = harness();
		const result = await loadSitePostPreview(
			await request(ctx),
			ctx,
			{ schema: 'update', postId: '../x' },
			adapter()
		);
		assert.deepEqual(result, { ok: false, status: 400, reason: 'invalid post id' });
		assert.deepEqual(calls, []);
	});

	it('reads the post through the schema-scoped list, and 404s when it finds nothing', async () => {
		const { ctx, calls } = harness({
			apex: { listPosts: { ok: true, status: 200, body: { data: [] } } }
		});
		const result = await loadSitePostPreview(await request(ctx), ctx, params, adapter());
		assert.deepEqual(result, { ok: false, status: 404, reason: 'no such post' });
		assert.deepEqual(calls, [['listPosts', 'update', { 'q[id_eq]': POST, per_page: 1 }]]);
	});

	it('is a 502, never a partial page, when the archetype will not read', async () => {
		const { ctx } = harness({ apex: { getPostArchetype: { ok: false, status: 500, body: null } } });
		const result = await loadSitePostPreview(await request(ctx), ctx, params, adapter());
		assert.deepEqual(result, { ok: false, status: 502, reason: 'upstream error' });
	});

	it('is a 502 when the document will not read, or reads without its blocks', async () => {
		for (const documents of [
			{ ok: false, status: 500, body: null },
			{ ok: true, status: 200, body: { data: [] } },
			{ ok: true, status: 200, body: { data: [{ id: DOC }] } }
		]) {
			const { ctx } = harness({ apex: { documents } });
			const result = await loadSitePostPreview(await request(ctx), ctx, params, adapter());
			assert.deepEqual(result, { ok: false, status: 502, reason: 'upstream error' });
		}
	});

	it('is a 503 before the site has ever been published', async () => {
		const { ctx } = harness({ published: false });
		const result = await loadSitePostPreview(await request(ctx), ctx, params, adapter());
		assert.deepEqual(result, {
			ok: false,
			status: 503,
			reason: 'the site has not been published yet'
		});
	});

	it("passes an adapter's own refusal through", async () => {
		const { ctx } = harness();
		const refusing = {
			...adapter(),
			async projectSaved() {
				return { ok: false, status: 422, reason: 'the post has no address yet' };
			}
		};
		const result = await loadSitePostPreview(await request(ctx), ctx, params, refusing);
		assert.deepEqual(result, { ok: false, status: 422, reason: 'the post has no address yet' });
	});
});

describe('loadSitePostPreview — a draft', () => {
	it('renders the saved draft, with its new cover read live, and reports it absent from the site', async () => {
		const seen = {};
		const { ctx, calls } = harness();
		const result = await loadSitePostPreview(await request(ctx), ctx, params, adapter(seen));
		assert.deepEqual(result, {
			ok: true,
			preview: {
				schema: 'update',
				postId: POST,
				payload: { post: { title: 'A partnership', blocks: 2, cover: 'img 3333' } },
				status: 'draft',
				routable: false,
				publicPath: null,
				// The archetype's, the latest of the three.
				savedAt: '2026-10-28T09:30:00.000Z',
				onSite: 'absent'
			}
		});
		// The cover and the body image, neither in the snapshot, in one read.
		const galleryRead = calls.find(([, path]) => `${path}`.includes('gallery_items'));
		assert.deepEqual(galleryRead, [
			'get',
			'/api/platform/v1/cms/gallery_items/search_and_filter',
			{ q: { id_in: [COVER_NEW, BODY_IMG] }, per_page: 2 }
		]);
		// The document is read where the publish reads documents.
		assert.ok(
			calls.some(
				([kind, path, query]) =>
					kind === 'get' &&
					path === '/api/platform/v1/cms/documents/search_and_filter' &&
					query.q.id_eq === DOC
			)
		);
		assert.deepEqual(
			seen.input.galleryItems.map((i) => i.id),
			[COVER_NEW, BODY_IMG]
		);
	});

	it('does not read images the snapshot already holds', async () => {
		const { ctx, calls } = harness({
			collections: {
				updates: [],
				documents: [],
				archetypes: [],
				images: [image(COVER_NEW), image(BODY_IMG)]
			}
		});
		const result = await loadSitePostPreview(await request(ctx), ctx, params, adapter());
		assert.equal(result.ok, true);
		assert.equal(result.preview.payload.post.cover, 'img 3333');
		assert.ok(!calls.some(([, path]) => `${path}`.includes('gallery_items')));
	});

	it('still renders when the image read fails — the cover is just unresolved', async () => {
		for (const galleryItems of [
			{ ok: false, status: 500, body: null },
			new Error('network down')
		]) {
			const { ctx } = harness({ apex: { galleryItems } });
			const result = await loadSitePostPreview(await request(ctx), ctx, params, adapter());
			assert.equal(result.ok, true);
			assert.equal(result.preview.payload.post.cover, null);
		}
	});

	it("hands the adapter copies, so a splice cannot reach the public site's snapshot", async () => {
		const { ctx } = harness();
		const mutating = {
			...adapter(),
			async projectSaved(input) {
				input.collections.images.splice(0);
				input.collections.updates.push({ id: 'junk' });
				input.saved.post.title = 'changed';
				return { ok: true, payload: null, comparable: null };
			}
		};
		await loadSitePostPreview(await request(ctx), ctx, params, mutating);
		const { collections } = await readContent(ctx.content);
		assert.deepEqual(collections.images, [image(COVER_OLD)]);
		assert.deepEqual(collections.updates, []);
	});
});

describe('loadSitePostPreview — a published post', () => {
	function publishedHarness(snapshotPost) {
		return harness({
			apex: {
				listPosts: {
					ok: true,
					status: 200,
					body: { data: [postView({ status: 'published' })] }
				}
			},
			collections: {
				updates: [snapshotPost],
				documents: [documentRow()],
				archetypes: [archetype()],
				images: [image(COVER_NEW), image(BODY_IMG)]
			}
		});
	}

	it('is identical when the snapshot holds the same projection', async () => {
		const { ctx } = publishedHarness(postView({ status: 'published' }));
		const result = await loadSitePostPreview(await request(ctx), ctx, params, adapter());
		assert.equal(result.preview.onSite, 'identical');
		assert.equal(result.preview.routable, true);
		assert.equal(result.preview.publicPath, '/blogs/a-partnership');
	});

	it('differs when the published copy is older', async () => {
		const { ctx } = publishedHarness(postView({ status: 'published', title: 'Old title' }));
		const result = await loadSitePostPreview(await request(ctx), ctx, params, adapter());
		assert.equal(result.preview.onSite, 'differs');
		assert.equal(result.preview.payload.post.title, 'A partnership');
	});
});

describe('collectionsWithSavedPost', () => {
	const saved = { post: postView(), archetype: archetype(), document: documentRow() };
	const base = {
		updates: [postView({ title: 'Published' }), { id: OTHER_POST, title: 'Another' }],
		documents: [documentRow({ blocks: [] })],
		archetypes: [],
		images: [image(COVER_NEW)],
		tags: [{ id: 't' }]
	};

	it('stands the saved records in for the published ones, and adds a draft that has none', () => {
		const input = {
			schema: 'update',
			saved,
			galleryItems: [image(COVER_NEW), image(BODY_IMG)],
			collections: structuredClone(base),
			apex: null
		};
		const next = collectionsWithSavedPost(input, {
			postsCollection: 'updates',
			imagesCollection: 'images'
		});
		assert.deepEqual(
			next.updates.map((p) => p.title),
			['A partnership', 'Another']
		);
		assert.equal(next.documents.length, 1);
		assert.equal(next.documents[0].blocks.length, 2);
		assert.deepEqual(next.archetypes, [saved.archetype]);
		// Appended once: the snapshot's copy of COVER_NEW wins over the live one.
		assert.deepEqual(
			next.images.map((i) => i.id),
			[COVER_NEW, BODY_IMG]
		);
		assert.deepEqual(next.tags, base.tags);
		// The input is not changed.
		assert.deepEqual(input.collections, base);
	});

	it('creates collections the snapshot does not have', () => {
		const next = collectionsWithSavedPost(
			{ schema: 'story', saved, galleryItems: [], collections: {}, apex: null },
			{ postsCollection: 'stories', imagesCollection: 'images' }
		);
		assert.deepEqual(next.stories, [saved.post]);
		assert.deepEqual(next.documents, [saved.document]);
		assert.deepEqual(next.archetypes, [saved.archetype]);
		assert.deepEqual(next.images, []);
	});
});

describe('publishedPostRow', () => {
	it('finds the published row by id, not by slug', () => {
		const input = {
			saved: { post: postView({ slug: 'renamed' }) },
			collections: { updates: [postView({ slug: 'a-partnership', title: 'Live' })] }
		};
		assert.equal(publishedPostRow(input, 'updates').title, 'Live');
		assert.equal(publishedPostRow({ ...input, collections: {} }, 'updates'), null);
	});
});

describe('referencedGalleryItemIds', () => {
	it('collects the cover rows and gallery-item blocks, once each, and nothing else', () => {
		const post = postView({
			shared_gallery_items: [
				{ gallery_item_id: COVER_NEW, kind: 'cover' },
				{ gallery_item_id: COVER_NEW, kind: 'cover' },
				{ gallery_item_id: null },
				'junk'
			]
		});
		const document = documentRow({
			blocks: [
				...documentRow().blocks,
				{ blockable_type: GALLERY, blockable: { gallery_item_id: '' } },
				{ blockable_type: RICH, blockable: { gallery_item_id: COVER_OLD } }
			]
		});
		assert.deepEqual(referencedGalleryItemIds(post, document), [COVER_NEW, BODY_IMG]);
		assert.deepEqual(referencedGalleryItemIds({}, {}), []);
	});
});
