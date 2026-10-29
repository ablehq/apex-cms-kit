// @ts-nocheck — this suite drives the real guard, contract check and KV reader.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	GALLERY_ITEM_FIELD,
	collectionsWithSavedPost,
	loadSitePostPreview,
	mediaFieldIds,
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
const AUTHOR = '66666666-1111-2222-3333-444444444444';
const AUTHOR_IMG = '77777777-1111-2222-3333-444444444444';
const PARTNER = '88888888-1111-2222-3333-444444444444';
const RELATED_STORY = '99999999-1111-2222-3333-444444444444';
const GALLERY = 'Cms::DocumentBlock::GalleryItem';
const RICH = 'Cms::DocumentBlock::RichText';
const PLATFORM = '/api/platform/v1';

/**
 * Two post schemas. An update references an author (whose photo is a media field),
 * partners, and — to prove only content-library targets are read — a story.
 */
const contract = {
	schema: (slug) =>
		['story', 'update', 'author', 'partner'].includes(slug)
			? {
					slug,
					display_name: slug,
					target_model: slug === 'story' || slug === 'update' ? 'Cms::Post' : null,
					id: null,
					items: []
				}
			: null,
	isContentLibrarySlug: (slug) => slug === 'author' || slug === 'partner',
	primitiveFieldDefs: (slug) =>
		slug === 'author'
			? [
					{ field_name: 'name', validator_kind: null },
					{ field_name: 'image', validator_kind: GALLERY_ITEM_FIELD }
				]
			: [],
	referenceItems: (slug) =>
		slug === 'update'
			? [
					{ name: 'author', kind: 'reference', target_schema: 'author' },
					{ name: 'partner', kind: 'reference', target_schema: 'partner' },
					{ name: 'related', kind: 'reference', target_schema: 'story' }
				]
			: []
};

function referenceItem(name, targetId) {
	return {
		id: `ai-${name}-${targetId.slice(0, 4)}`,
		relatable_type: 'Specification::Archetype',
		archetype_schema_item: { name },
		fields_data: { [name]: targetId }
	};
}

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
		archetype_items: [
			referenceItem('author', AUTHOR),
			referenceItem('partner', PARTNER),
			referenceItem('related', RELATED_STORY)
		],
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

function image(id, caption = `img ${id.slice(0, 4)}`) {
	return { id, caption, medium: { file: { key: `key-${id.slice(0, 4)}` } } };
}

function author(name = 'Aarefa', photo = AUTHOR_IMG) {
	return { id: AUTHOR, primitives: { name, image: photo } };
}

function partner(title = 'Agami') {
	return { id: PARTNER, primitives: { title } };
}

/** What Apex holds now, by default: every image and target, current. */
function liveAnswers() {
	return {
		listPosts: { ok: true, status: 200, body: { data: [postView()] } },
		getPostArchetype: { ok: true, status: 200, body: { data: archetype() } },
		documents: { ok: true, status: 200, body: { data: [documentRow()] } },
		galleryItems: {
			ok: true,
			status: 200,
			body: { data: [image(COVER_NEW), image(BODY_IMG), image(AUTHOR_IMG)] }
		},
		targets: {
			author: { ok: true, status: 200, body: { data: [author()] } },
			partner: { ok: true, status: 200, body: { data: [partner()] } }
		}
	};
}

/** A recording Apex stub, plus the snapshot in KV. `apex` overrides any answer. */
function harness({ collections, published = true, apex = {}, contractValue = contract } = {}) {
	resetContentMemo();
	const calls = [];
	const base = liveAnswers();
	const answers = { ...base, ...apex, targets: { ...base.targets, ...(apex.targets ?? {}) } };
	const answer = (value) => {
		if (value instanceof Error) throw value;
		return value;
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
			if (path === `${PLATFORM}/cms/documents/search_and_filter`) return answers.documents;
			if (path === `${PLATFORM}/cms/gallery_items/search_and_filter`)
				return answer(answers.galleryItems);
			if (path === `${PLATFORM}/specification/archetypes/search_and_filter`)
				return answer(answers.targets[query.q.archetype_schema_slug_eq]);
			throw new Error(`unexpected read ${path}`);
		}
	};
	const snapshotCollections = collections ?? {
		updates: [],
		documents: [],
		archetypes: [],
		authors: [],
		partners: [],
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
 * A minimal site adapter. Its "public projection" is what a post page draws from
 * joins: title, body length, the cover's caption, the author's name and photo key,
 * the partner's title — each resolved by id through the collections, the way a
 * site's loader does. Like a site's route, it finds the saved post by its slug.
 * It records what it was handed.
 */
function adapter(seen = {}) {
	const project = (collections, post) => {
		const byId = (name, id) => (collections[name] ?? []).find((row) => row.id === id);
		const doc = byId('documents', post.document?.id);
		const arch = (collections.archetypes ?? []).find((a) => a.target_model_id === post.id);
		const ref = (name) =>
			arch?.archetype_items?.find((i) => i.archetype_schema_item?.name === name)?.fields_data?.[
				name
			];
		const coverId = post.shared_gallery_items?.find((r) => r.kind === 'cover')?.gallery_item_id;
		const authorRow = byId('authors', ref('author'));
		return {
			title: post.title,
			blocks: doc?.blocks?.length ?? 0,
			cover: byId('images', coverId)?.caption ?? null,
			author: authorRow?.primitives?.name ?? 'Default byline',
			authorPhoto: byId('images', authorRow?.primitives?.image)?.medium?.file?.key ?? null,
			partner: byId('partners', ref('partner'))?.primitives?.title ?? null
		};
	};
	return {
		async projectSaved(input) {
			seen.input = input;
			const collections = collectionsWithSavedPost(input, {
				postsCollection: 'updates',
				imagesCollection: 'images',
				referenceCollections: { author: 'authors', partner: 'partners' }
			});
			const post = collections.updates.find((p) => p.slug === input.saved.post.slug);
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

const reads = (calls, path) => calls.filter(([kind, p]) => kind === 'get' && p === path);

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
	it('draws the saved draft with everything it shows read live, and reports it absent from the site', async () => {
		const seen = {};
		const { ctx, calls } = harness();
		const result = await loadSitePostPreview(await request(ctx), ctx, params, adapter(seen));
		assert.deepEqual(result, {
			ok: true,
			preview: {
				schema: 'update',
				postId: POST,
				payload: {
					post: {
						title: 'A partnership',
						blocks: 2,
						cover: 'img 3333',
						// Neither the author nor the partner is in the snapshot.
						author: 'Aarefa',
						authorPhoto: 'key-7777',
						partner: 'Agami'
					}
				},
				status: 'draft',
				routable: false,
				publicPath: null,
				// The archetype's, the latest of the three.
				savedAt: '2026-10-28T09:30:00.000Z',
				onSite: 'absent'
			}
		});
		// The document is read where the publish reads documents.
		assert.equal(reads(calls, `${PLATFORM}/cms/documents/search_and_filter`)[0][2].q.id_eq, DOC);
		// One read per content-library target schema, where the publish lists them.
		// The `related` story is a post, not a content-library record, and is not read.
		assert.deepEqual(
			reads(calls, `${PLATFORM}/specification/archetypes/search_and_filter`).map(([, , q]) => q),
			[
				{ q: { archetype_schema_slug_eq: 'author', id_in: [AUTHOR] }, per_page: 1 },
				{ q: { archetype_schema_slug_eq: 'partner', id_in: [PARTNER] }, per_page: 1 }
			]
		);
		// ONE gallery read: the cover, the body image, and the live author's photo.
		assert.deepEqual(
			reads(calls, `${PLATFORM}/cms/gallery_items/search_and_filter`).map(([, , q]) => q),
			[{ q: { id_in: [COVER_NEW, BODY_IMG, AUTHOR_IMG] }, per_page: 3 }]
		);
		assert.deepEqual(Object.keys(seen.input.referenceTargets).sort(), ['author', 'partner']);
		assert.deepEqual(
			seen.input.galleryItems.map((i) => i.id),
			[COVER_NEW, BODY_IMG, AUTHOR_IMG]
		);
	});

	it('falls back to the snapshot, and still draws, when the live reads fail', async () => {
		for (const failure of [{ ok: false, status: 500, body: null }, new Error('network down')]) {
			const { ctx } = harness({
				apex: { galleryItems: failure, targets: { author: failure, partner: failure } },
				collections: {
					updates: [],
					documents: [],
					archetypes: [],
					authors: [author('Published name')],
					partners: [],
					images: [image(COVER_NEW, 'Published caption')]
				}
			});
			const result = await loadSitePostPreview(await request(ctx), ctx, params, adapter());
			assert.equal(result.ok, true);
			assert.equal(result.preview.payload.post.cover, 'Published caption');
			assert.equal(result.preview.payload.post.author, 'Published name');
			assert.equal(result.preview.payload.post.partner, null);
		}
	});

	it('draws the draft, not a renamed post the snapshot still holds at its slug', async () => {
		// Another post was published at this slug, then renamed in Apex; this draft
		// took the freed slug before the site was published again.
		const { ctx } = harness({
			collections: {
				updates: [
					postView({
						id: OTHER_POST,
						title: 'Announcing Tomorrow Makers',
						status: 'published',
						document: { id: 'stale-doc' }
					})
				],
				documents: [],
				archetypes: [],
				images: []
			}
		});
		const result = await loadSitePostPreview(await request(ctx), ctx, params, adapter());
		assert.equal(result.ok, true);
		assert.equal(result.preview.postId, POST);
		assert.equal(result.preview.payload.post.title, 'A partnership');
		assert.equal(result.preview.payload.post.blocks, 2);
		assert.equal(result.preview.onSite, 'absent');
	});

	it("hands the adapter copies, so a splice cannot reach the public site's snapshot", async () => {
		const { ctx } = harness();
		const mutating = {
			...adapter(),
			async projectSaved(input) {
				input.collections.images.splice(0);
				input.collections.updates.push({ id: 'junk' });
				input.saved.post.title = 'changed';
				input.referenceTargets.author.push({ id: 'junk' });
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
	/** The snapshot as the last publish left it: this post, its cover, author and partner. */
	function publishedHarness({ snapshot = {}, apex = {} } = {}) {
		return harness({
			apex: {
				listPosts: {
					ok: true,
					status: 200,
					body: { data: [postView({ status: 'published' })] }
				},
				...apex
			},
			collections: {
				updates: [postView({ status: 'published' })],
				documents: [documentRow()],
				archetypes: [archetype()],
				authors: [author()],
				partners: [partner()],
				images: [image(COVER_NEW), image(BODY_IMG), image(AUTHOR_IMG)],
				...snapshot
			}
		});
	}

	it('is identical when nothing has changed since the publish', async () => {
		const { ctx } = publishedHarness();
		const result = await loadSitePostPreview(await request(ctx), ctx, params, adapter());
		assert.equal(result.preview.onSite, 'identical');
		assert.equal(result.preview.routable, true);
		assert.equal(result.preview.publicPath, '/blogs/a-partnership');
	});

	it('differs when the published copy of the post is older', async () => {
		const { ctx } = publishedHarness({
			snapshot: { updates: [postView({ status: 'published', title: 'Old title' })] }
		});
		const result = await loadSitePostPreview(await request(ctx), ctx, params, adapter());
		assert.equal(result.preview.onSite, 'differs');
		assert.equal(result.preview.payload.post.title, 'A partnership');
	});

	it('shows a corrected caption on an existing cover, and differs — the id did not change', async () => {
		const { ctx, calls } = publishedHarness({
			snapshot: { images: [image(COVER_NEW, 'Old caption'), image(BODY_IMG), image(AUTHOR_IMG)] },
			apex: {
				galleryItems: {
					ok: true,
					status: 200,
					body: {
						data: [image(COVER_NEW, 'Corrected caption'), image(BODY_IMG), image(AUTHOR_IMG)]
					}
				}
			}
		});
		const result = await loadSitePostPreview(await request(ctx), ctx, params, adapter());
		assert.equal(result.preview.payload.post.cover, 'Corrected caption');
		assert.equal(result.preview.onSite, 'differs');
		// Read although the snapshot holds every one of them.
		assert.equal(reads(calls, `${PLATFORM}/cms/gallery_items/search_and_filter`).length, 1);
	});

	it('shows an edited author and their new photo, and differs', async () => {
		const NEW_PHOTO = 'abcdabcd-1111-2222-3333-444444444444';
		const { ctx } = publishedHarness({
			apex: {
				targets: {
					author: { ok: true, status: 200, body: { data: [author('Aarefa K.', NEW_PHOTO)] } }
				},
				galleryItems: {
					ok: true,
					status: 200,
					body: { data: [image(COVER_NEW), image(BODY_IMG), image(NEW_PHOTO)] }
				}
			}
		});
		const result = await loadSitePostPreview(await request(ctx), ctx, params, adapter());
		assert.equal(result.preview.payload.post.author, 'Aarefa K.');
		assert.equal(result.preview.payload.post.authorPhoto, 'key-abcd');
		assert.equal(result.preview.onSite, 'differs');
	});
});

describe('collectionsWithSavedPost', () => {
	const saved = { post: postView(), archetype: archetype(), document: documentRow() };
	const base = {
		updates: [postView({ title: 'Published' }), { id: OTHER_POST, title: 'Another' }],
		documents: [documentRow({ blocks: [] })],
		archetypes: [],
		authors: [author('Old name')],
		partners: [],
		images: [image(COVER_NEW, 'Old caption'), image(COVER_OLD)],
		tags: [{ id: 't' }]
	};

	it('stands the saved records and every live row in for the published ones', () => {
		const input = {
			schema: 'update',
			saved,
			referenceTargets: {
				author: [author('New name')],
				partner: [partner()],
				story: [{ id: RELATED_STORY }]
			},
			galleryItems: [image(COVER_NEW, 'New caption'), image(BODY_IMG)],
			collections: structuredClone(base),
			apex: null
		};
		const next = collectionsWithSavedPost(input, {
			postsCollection: 'updates',
			imagesCollection: 'images',
			referenceCollections: { author: 'authors', partner: 'partners' }
		});
		// The saved post first, its published copy dropped.
		assert.deepEqual(
			next.updates.map((p) => p.title),
			['A partnership', 'Another']
		);
		assert.equal(next.documents.length, 1);
		assert.equal(next.documents[0].blocks.length, 2);
		assert.deepEqual(next.archetypes, [saved.archetype]);
		assert.deepEqual(next.authors, [author('New name')]);
		assert.deepEqual(next.partners, [partner()]);
		// No collection is named for `story`, so nothing is put anywhere for it.
		assert.equal(next.stories, undefined);
		assert.deepEqual(
			next.images.map((i) => [i.id, i.caption]),
			[
				[COVER_NEW, 'New caption'],
				[COVER_OLD, 'img 4444'],
				[BODY_IMG, 'img 5555']
			]
		);
		assert.deepEqual(next.tags, base.tags);
		// The snapshot copy is not changed: the published comparison reads it.
		assert.deepEqual(input.collections, base);
	});

	it('puts the saved records ahead of stale rows a site could match first', () => {
		// A post renamed since the publish still holds this slug in the snapshot, and
		// an older archetype still points at this post. The published copy of the
		// post sits after them.
		const collections = {
			updates: [
				{ id: OTHER_POST, slug: 'a-partnership', title: 'Announcing Tomorrow Makers' },
				postView({ title: 'Published' })
			],
			archetypes: [{ id: 'stale-arch', target_model_id: POST }],
			documents: [documentRow({ blocks: [] })]
		};
		const input = {
			schema: 'update',
			saved,
			referenceTargets: {},
			galleryItems: [],
			collections: structuredClone(collections),
			apex: null
		};
		const next = collectionsWithSavedPost(input, {
			postsCollection: 'updates',
			imagesCollection: 'images'
		});
		assert.equal(next.updates.find((p) => p.slug === 'a-partnership').id, POST);
		assert.deepEqual(
			next.updates.map((p) => p.title),
			['A partnership', 'Announcing Tomorrow Makers']
		);
		assert.equal(next.archetypes.find((a) => a.target_model_id === POST).id, ARCH);
		assert.deepEqual(next.documents, [saved.document]);
		assert.deepEqual(input.collections, collections);
	});

	it('creates collections the snapshot does not have', () => {
		const next = collectionsWithSavedPost(
			{
				schema: 'story',
				saved,
				referenceTargets: {},
				galleryItems: [],
				collections: {},
				apex: null
			},
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

describe('mediaFieldIds', () => {
	it("reads the contract's media fields, from an item row or the primitives cache", () => {
		assert.deepEqual(mediaFieldIds(contract, 'author', author()), [AUTHOR_IMG]);
		const fromItem = {
			id: AUTHOR,
			archetype_items: [
				{
					relatable_type: 'PropertySet',
					archetype_schema_item: { name: 'image' },
					fields_data: { image: AUTHOR_IMG }
				}
			]
		};
		assert.deepEqual(mediaFieldIds(contract, 'author', fromItem), [AUTHOR_IMG]);
	});

	it('ignores other fields, empty values, and schemas with no media fields', () => {
		assert.deepEqual(mediaFieldIds(contract, 'author', author('Name', '')), []);
		assert.deepEqual(mediaFieldIds(contract, 'partner', { primitives: { logo: AUTHOR_IMG } }), []);
	});
});
