// @ts-nocheck — node:test suite over dynamic JSON shapes; behavior is the contract.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	apexBlockRows,
	apexValidationErrors,
	buildBlocksAttributes,
	computePostVersion,
	coverAttributes,
	listAllPages,
	metaAttributes,
	normalizeBlocks,
	postSchemaOf,
	readCoverId,
	readMeta,
	savePostBodySchema,
	summarizePost
} from '../src/server/bff/operations/post-shape.ts';
import { createPostBodySchema } from '../src/server/bff/operations/create-post.ts';
import {
	handleUpdatePost,
	updatePostBodySchema
} from '../src/server/bff/operations/update-post.ts';
import { handleGetPost } from '../src/server/bff/operations/get-post.ts';
import { handleCreatePost } from '../src/server/bff/operations/create-post.ts';
import { createMigratedDatabase } from './harness/d1.ts';
import { handleDeletePost } from '../src/server/bff/operations/delete-post.ts';
import {
	handlePatchPostStatus,
	postStatusBodySchema
} from '../src/server/bff/operations/patch-post-status.ts';
import { countReferencesTo } from '../src/server/bff/operations/record-shape.ts';
import { handleListPosts, loadPostCatalogue } from '../src/server/bff/operations/post-list.ts';
import { createApexAdminClient } from '../src/server/bff/apex-admin-client.ts';
import { createSessionSecret, sessionIdFor } from '../src/server/bff/session.ts';
import { parseAllowedOrigins } from '../src/server/bff/boundary.ts';
import { createMemorySessionStore } from './harness/session-store.ts';

/**
 * The post operations' pure halves, pinned — and, with a recording client, the
 * two refusals that only a stub can prove cheaply: the cross-schema 404 (a story
 * id addressed through the update route finds nothing, so nothing is written) and
 * the slug collision surfaced as 409. What a stub cannot prove — that Apex
 * accepted a body — is proved by Godrej's real-Apex suite, write-then-re-read.
 */

const RICH = 'Cms::DocumentBlock::RichText';
const QUOTE = 'Cms::DocumentBlock::Quote';
const GALLERY = 'Cms::DocumentBlock::GalleryItem';

const uuid = (n) => `${`${n}`.repeat(8)}-1111-2222-3333-444444444444`.slice(0, 36);
const ID_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const ID_B = 'bbbbbbbb-1111-2222-3333-444444444444';
const ID_C = 'cccccccc-1111-2222-3333-444444444444';
const POST = 'dddddddd-1111-2222-3333-444444444444';
const ARCH = 'eeeeeeee-1111-2222-3333-444444444444';
const DOC = 'ffffffff-1111-2222-3333-444444444444';
const FA1 = '11111111-1111-2222-3333-444444444444';
const FA2 = '22222222-1111-2222-3333-444444444444';
const IMG1 = '33333333-1111-2222-3333-444444444444';
const IMG2 = '44444444-1111-2222-3333-444444444444';

/** A two-post-schema content model: `story` (kind + author/focus_area/partner) and `update`. */
const contract = {
	schema: (slug) =>
		['story', 'update', 'focus_area', 'author', 'partner'].includes(slug)
			? {
					slug,
					display_name: slug,
					target_model: slug === 'story' || slug === 'update' ? 'Cms::Post' : null,
					id: null,
					items: []
				}
			: null,
	isContentLibrarySlug: (slug) => ['focus_area', 'author', 'partner'].includes(slug),
	primitiveFieldDefs: (slug) =>
		slug === 'story'
			? [
					{
						field_name: 'kind',
						display_name: 'Kind',
						validator_kind: null,
						text_inclusion: ['article', 'video', 'interview'],
						is_required: false,
						place_holder: null,
						default_value: null
					}
				]
			: [],
	referenceItems: (slug) =>
		slug === 'story' || slug === 'update'
			? [
					{
						name: 'author',
						kind: 'reference',
						position: 0,
						field_defs: null,
						relationship_kind: 'has_one',
						target_schema: 'author',
						reference_display_field: 'name'
					},
					{
						name: 'focus_area',
						kind: 'reference',
						position: 1,
						field_defs: null,
						relationship_kind: 'has_many',
						target_schema: 'focus_area',
						reference_display_field: 'title'
					}
				]
			: [],
	referrersTo: (slug) =>
		slug === 'focus_area'
			? {
					countable: [
						{ slug: 'story', displayName: 'Stories', itemName: 'focus_area' },
						{ slug: 'update', displayName: 'Updates', itemName: 'focus_area' }
					],
					uncounted: []
				}
			: { countable: [], uncounted: [] }
};

function apexBlocks() {
	return [
		{
			id: ID_A,
			position: 0,
			blockable_type: RICH,
			blockable: { id: uuid(5), content_html: '<p>One.</p>' }
		},
		{
			id: ID_B,
			position: 1,
			blockable_type: QUOTE,
			blockable: { id: uuid(6), quote: 'Q.', quoted_by: 'W' }
		},
		{
			id: ID_C,
			position: 2,
			blockable_type: GALLERY,
			blockable: { id: uuid(7), gallery_item_id: IMG1 }
		}
	];
}

function view(overrides = {}) {
	return {
		id: POST,
		archetype_id: ARCH,
		title: 'A story',
		slug: 'a-story',
		summary: 'S',
		status: 'draft',
		published_date: '2026-07-01T00:00:00.000Z',
		updated_at: '2026-07-31T00:00:00.000Z',
		document: { id: DOC },
		archetype: { id: ARCH, updated_at: '2026-07-31T00:00:00.000Z' },
		meta_properties: [
			{ id: uuid(1), name: 'title', group: 'web', value: 'M' },
			{ id: uuid(2), name: 'description', group: 'web', value: 'D' },
			{ id: uuid(3), name: 'keywords', group: 'web', value: 'K' }
		],
		shared_gallery_items: [],
		...overrides
	};
}

function archetype(overrides = {}) {
	return {
		id: ARCH,
		updated_at: '2026-07-31T00:00:00.000Z',
		primitives: { kind: 'video' },
		archetype_items: [
			{
				id: uuid(8),
				relatable_type: 'PropertySet',
				archetype_schema_item: { name: 'kind' },
				fields_data: { kind: 'video' }
			},
			{
				id: uuid(9),
				relatable_type: 'Specification::Archetype',
				archetype_schema_item: { name: 'focus_area' },
				fields_data: { focus_area: FA1 }
			}
		],
		taggings: [],
		...overrides
	};
}

describe('post-shape — the schema gate', () => {
	it('serves a Cms::Post schema and refuses a content-library one', () => {
		assert.ok(postSchemaOf(contract, 'story'));
		assert.ok(postSchemaOf(contract, 'update'));
		assert.equal(postSchemaOf(contract, 'focus_area'), null);
		assert.equal(postSchemaOf(contract, 'nope'), null);
	});
});

describe('post body — the reconciliation, and what it never destroys', () => {
	it('keeps an unchanged block by id rather than appending a copy', () => {
		const attributes = buildBlocksAttributes(apexBlockRows(apexBlocks()), [
			{ id: ID_A, kind: 'rich_text', html: '<p>One.</p>' },
			{ id: ID_B, kind: 'quote', quote: 'Q.', quotedBy: 'W' }
		]);
		// Two editable rows by id, plus the gallery block's position-only row.
		assert.equal(attributes.length, 3);
		assert.ok(attributes.every((row) => row.id && !row._destroy));
		assert.deepEqual(
			attributes.map((row) => [row.id, row.position]),
			[
				[ID_A, 0],
				[ID_B, 1],
				[ID_C, 2]
			]
		);
	});

	it('NEVER destroys a GalleryItem block — a story body the editor was not shown', () => {
		// The editor round-trips only what `normalizeBlocks` handed it; the gallery
		// block is not in that list, and a save that did not mention it must not
		// delete it. This is the block Godrej's story bodies carry.
		const attributes = buildBlocksAttributes(apexBlockRows(apexBlocks()), []);
		assert.deepEqual(
			attributes
				.filter((row) => row._destroy)
				.map((row) => row.id)
				.sort(),
			[ID_A, ID_B].sort()
		);
		const gallery = attributes.find((row) => row.id === ID_C);
		assert.ok(gallery && !gallery._destroy, 'the gallery block survives');
		assert.deepEqual(gallery, { id: ID_C, position: 2 }, 'and only its position is restated');
	});

	it('numbers positions across ALL blocks in document order — a gallery block keeps its slot', () => {
		// Gallery block in the MIDDLE: [rich A @0, gallery C @1, quote B @2]. The editor
		// swaps its two blocks. Numbering only the editable blocks from 0 would put B
		// on 0 and A on 1 while the gallery stayed on 1 — a collision Apex resolves
		// arbitrarily. Every block gets a distinct slot instead.
		const current = apexBlockRows([
			{
				id: ID_A,
				position: 0,
				blockable_type: RICH,
				blockable: { id: uuid(5), content_html: '<p>A</p>' }
			},
			{ id: ID_C, position: 1, blockable_type: GALLERY, blockable: { id: uuid(7) } },
			{
				id: ID_B,
				position: 2,
				blockable_type: QUOTE,
				blockable: { id: uuid(6), quote: 'Q', quoted_by: 'W' }
			}
		]);
		const attributes = buildBlocksAttributes(current, [
			{ id: ID_B, kind: 'quote', quote: 'Q', quotedBy: 'W' },
			{ id: ID_A, kind: 'rich_text', html: '<p>A</p>' },
			{ id: null, kind: 'rich_text', html: '<p>new</p>' }
		]);
		const positions = attributes
			.filter((row) => !row._destroy)
			.map((row) => [row.id ?? 'new', row.position])
			.sort((a, b) => a[1] - b[1]);
		assert.deepEqual(positions, [
			[ID_B, 0],
			[ID_C, 1],
			[ID_A, 2],
			['new', 3]
		]);
		assert.equal(
			new Set(positions.map(([, p]) => p)).size,
			positions.length,
			'no two blocks share a position'
		);
		assert.ok(!attributes.some((row) => row._destroy), 'nothing destroyed');
	});

	it('normalizes the two editable kinds and drops the gallery block from the editor', () => {
		assert.deepEqual(
			normalizeBlocks(apexBlocks()).map((block) => block.kind),
			['rich_text', 'quote']
		);
	});

	it('turns a changed KIND into a create plus a destroy', () => {
		const attributes = buildBlocksAttributes(apexBlockRows(apexBlocks()), [
			{ id: ID_A, kind: 'quote', quote: 'Now a quotation.', quotedBy: '' }
		]);
		assert.ok(attributes.some((row) => row._destroy && row.id === ID_A));
		assert.ok(attributes.some((row) => !row.id && row.blockable_type === QUOTE));
	});

	it('sanitizes on the way in and the way out', () => {
		const attributes = buildBlocksAttributes(
			[],
			[{ id: null, kind: 'rich_text', html: '<p>Hi<script>alert(1)</script></p>' }]
		);
		assert.ok(!attributes[0].blockable_attributes.content_html.includes('<script'));
		const blocks = normalizeBlocks([
			{
				id: ID_A,
				position: 0,
				blockable_type: RICH,
				blockable: { content_html: '<p onclick="x()">T</p>' }
			}
		]);
		assert.ok(!blocks[0].html.includes('onclick'));
	});

	it('body: a block is one of two kinds and carries nothing else', () => {
		assert.ok(savePostBodySchema.safeParse({ blocks: [] }).success);
		assert.ok(!savePostBodySchema.safeParse({ blocks: [{ kind: 'image', url: 'x' }] }).success);
	});
});

describe('SEO and the cover — written by id, never appended', () => {
	it('writes SEO by id, only for the names that changed, and never invents a row', () => {
		const attributes = metaAttributes(view(), { title: 'New' });
		assert.deepEqual(attributes, [
			{ id: uuid(1), name: 'title', group: 'web', value_type: 'string', value: 'New' }
		]);
		assert.deepEqual(metaAttributes({ meta_properties: [] }, { title: 'x' }), []);
		assert.deepEqual(readMeta(view()), { title: 'M', description: 'D', keywords: 'K' });
	});

	it('heals a DUPLICATE SEO row a no-id write left behind — the extra is destroyed, the first kept', () => {
		const v = view({
			meta_properties: [
				{ id: uuid(1), name: 'title', group: 'web', value: 'M' },
				{ id: uuid(2), name: 'description', group: 'web', value: 'D' },
				{ id: uuid(3), name: 'keywords', group: 'web', value: 'K' },
				{ id: uuid(4), name: 'title', group: 'web', value: 'a duplicate' }
			]
		});
		assert.deepEqual(metaAttributes(v, { description: 'D2' }), [
			{ id: uuid(2), name: 'description', group: 'web', value_type: 'string', value: 'D2' },
			{ id: uuid(4), _destroy: true }
		]);
		// The FIRST row is the one `readMeta` shows, so it is the one that survives.
		assert.equal(readMeta(v).title, 'M');
	});

	it('creates the cover row only when none exists', () => {
		assert.deepEqual(coverAttributes(view(), IMG1), [{ gallery_item_id: IMG1, kind: 'cover' }]);
	});

	it('updates the existing cover row IN PLACE by its join id', () => {
		const v = view({
			shared_gallery_items: [{ id: uuid(4), gallery_item_id: IMG1, kind: 'cover' }]
		});
		assert.deepEqual(coverAttributes(v, IMG2), [
			{ id: uuid(4), gallery_item_id: IMG2, kind: 'cover' }
		]);
		assert.equal(coverAttributes(v, IMG1), null, 'the same cover has nothing to say');
		assert.equal(readCoverId(v), IMG1);
	});

	it('destroys the cover on null, and heals a duplicate row an append left behind', () => {
		const v = view({
			shared_gallery_items: [
				{ id: uuid(4), gallery_item_id: IMG1, kind: 'cover' },
				{ id: uuid(5), gallery_item_id: IMG1, kind: 'cover' }
			]
		});
		assert.deepEqual(coverAttributes(v, null), [
			{ id: uuid(5), _destroy: true },
			{ id: uuid(4), _destroy: true }
		]);
		assert.deepEqual(coverAttributes(v, IMG2), [
			{ id: uuid(5), _destroy: true },
			{ id: uuid(4), gallery_item_id: IMG2, kind: 'cover' }
		]);
	});
});

describe('the post summary and the stale-guard token', () => {
	it('reads primitives, references, tags and the cover off the two records', () => {
		const post = summarizePost(
			contract,
			'story',
			view({ shared_gallery_items: [{ id: uuid(4), gallery_item_id: IMG1, kind: 'cover' }] }),
			archetype({ taggings: [{ id: uuid(3), tag_id: uuid(2), tag: { name: 'Water' } }] }),
			[]
		);
		assert.equal(post.id, POST);
		assert.equal(post.archetypeId, ARCH);
		assert.equal(post.documentId, DOC);
		assert.equal(post.publishedDate, '2026-07-01');
		assert.deepEqual(post.fields, { kind: 'video' });
		assert.deepEqual(post.references.focus_area, [{ itemId: uuid(9), targetId: FA1 }]);
		assert.deepEqual(post.references.author, []);
		assert.deepEqual(post.tags, [{ id: uuid(3), tagId: uuid(2), tagName: 'Water' }]);
		assert.equal(post.coverId, IMG1);
	});

	it('moves on a reference, a cover or a tag edit — none of which move a timestamp', async () => {
		const base = await computePostVersion(view(), archetype(), [], contract, 'story');
		const referenceMoved = await computePostVersion(
			view(),
			archetype({
				archetype_items: [
					{
						id: uuid(9),
						relatable_type: 'Specification::Archetype',
						archetype_schema_item: { name: 'focus_area' },
						fields_data: { focus_area: FA2 }
					}
				]
			}),
			[],
			contract,
			'story'
		);
		const coverMoved = await computePostVersion(
			view({ shared_gallery_items: [{ id: uuid(4), gallery_item_id: IMG1, kind: 'cover' }] }),
			archetype(),
			[],
			contract,
			'story'
		);
		const tagMoved = await computePostVersion(
			view(),
			archetype({ taggings: [{ id: uuid(3), tag_id: uuid(2) }] }),
			[],
			contract,
			'story'
		);
		const kindMoved = await computePostVersion(
			view(),
			archetype({ primitives: { kind: 'article' }, archetype_items: [] }),
			[],
			contract,
			'story'
		);
		assert.notEqual(base, referenceMoved);
		assert.notEqual(base, coverMoved);
		assert.notEqual(base, tagMoved);
		assert.notEqual(base, kindMoved);
		assert.equal(
			base,
			await computePostVersion(view(), archetype(), [], contract, 'story'),
			'stable'
		);
	});

	it('moves when a block changes or the blocks reorder', async () => {
		const one = { id: ID_A, kind: 'rich_text', html: '<p>a</p>' };
		const two = { id: ID_B, kind: 'rich_text', html: '<p>b</p>' };
		assert.notEqual(
			await computePostVersion(view(), archetype(), [one, two], contract, 'story'),
			await computePostVersion(view(), archetype(), [two, one], contract, 'story')
		);
	});
});

describe('the route schemas are closed', () => {
	it('create: title + slug, optional archetype fields from the contract, nothing else', () => {
		const schema = createPostBodySchema(contract, 'story');
		assert.ok(schema.safeParse({ title: 'T', slug: 'a-story', fields: { kind: 'video' } }).success);
		assert.ok(!schema.safeParse({ title: 'T', slug: 'Not A Slug' }).success);
		assert.ok(!schema.safeParse({ title: 'T', slug: 'a', fields: { author: 'x' } }).success);
		assert.ok(!schema.safeParse({ title: 'T', slug: 'a', status: 'published' }).success);
		assert.ok(
			!createPostBodySchema(contract, 'update').safeParse({
				title: 'T',
				slug: 'a',
				fields: { kind: 'video' }
			}).success
		);
	});

	it('update: every field optional; `coverId` may be null; `status` and `kind` are not here', () => {
		assert.ok(updatePostBodySchema.safeParse({}).success);
		assert.ok(updatePostBodySchema.safeParse({ coverId: null }).success);
		assert.ok(updatePostBodySchema.safeParse({ coverId: IMG1, meta: { title: 'x' } }).success);
		assert.ok(!updatePostBodySchema.safeParse({ status: 'published' }).success);
		assert.ok(!updatePostBodySchema.safeParse({ kind: 'video' }).success);
		assert.ok(!updatePostBodySchema.safeParse({ title: null }).success);
	});

	it('status: exactly two events, and our wire name is `statusEvent`', () => {
		assert.ok(postStatusBodySchema.safeParse({ statusEvent: 'publish' }).success);
		assert.ok(!postStatusBodySchema.safeParse({ event: 'publish' }).success);
	});
});

// ── The operations, with a recording client ────────────────────────────────

const ORIGIN = 'https://site.test';
const CSRF = 'csrf-posts';

/**
 * An Apex stub that answers the schema-scoped view read HONESTLY: the story is
 * found under `story` and NOT under `update`. Every call is recorded so a refusal
 * can be proved to have written nothing.
 */
function apexStub(calls, options = {}) {
	return {
		async listPosts(slug, query) {
			calls.push(['listPosts', slug, query]);
			const found = slug === 'story' && query['q[id_eq]'] === POST;
			return { ok: true, status: 200, body: { data: found ? [view(options.view)] : [] } };
		},
		async listPostArchetypes(slug, query) {
			calls.push(['listPostArchetypes', slug, query]);
			const rows = options.archetypesFor?.(slug) ?? [];
			return {
				ok: true,
				status: 200,
				body: {
					data: rows,
					pagination: { total_count: rows.length, current_page: 1, total_pages: 1 }
				}
			};
		},
		async getPostArchetype(slug, id) {
			calls.push(['getPostArchetype', slug, id]);
			return { ok: true, status: 200, body: { data: archetype() } };
		},
		async getDocument(id) {
			calls.push(['getDocument', id]);
			return { ok: true, status: 200, body: { data: { id, blocks: apexBlocks() } } };
		},
		async listContentLibrary(slug) {
			calls.push(['listContentLibrary', slug]);
			return {
				ok: true,
				status: 200,
				body: { data: [], pagination: { total_count: 0, current_page: 1, total_pages: 1 } }
			};
		},
		async createPost(slug, target, fields) {
			calls.push(['createPost', slug, target, fields]);
			if (options.createStatus === 422) {
				return {
					ok: false,
					status: 422,
					body: {
						data: options.createErrors ?? [
							{ attribute_name: 'slug', messages: ['has already been taken'] }
						]
					}
				};
			}
			if (options.createdPostId === null)
				return { ok: true, status: 200, body: { data: { id: ARCH } } };
			return {
				ok: true,
				status: 200,
				body: { data: { id: ARCH, target_model_id: options.createdPostId ?? POST } }
			};
		},
		async updatePostFields(id, fields) {
			calls.push(['updatePostFields', id, fields]);
			return { ok: true, status: 200, body: { data: { id } } };
		},
		async deletePost(slug, id) {
			calls.push(['deletePost', slug, id]);
			return { ok: true, status: 200, body: null };
		},
		async changePostStatus(id, statusEvent) {
			calls.push(['changePostStatus', id, statusEvent]);
			// Stateful on purpose: the route RE-READS rather than echoing the event, so
			// the double has to be able to answer differently afterwards or the test
			// cannot tell an echo from a read.
			options.view = { ...(options.view ?? {}), status: 'published' };
			return { ok: true, status: 200, body: { data: { id } } };
		}
	};
}

function ctxWith(calls, options, db) {
	return {
		...(db ? { db } : {}),
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
		createApexClient: () => apexStub(calls, options),
		contract
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
		staffId: uuid(1),
		staffName: 'E',
		accessToken: 't',
		tokenType: 'Bearer',
		accessExpiresAt: now + 3600_000,
		refreshToken: 'r'
	});
	return secret;
}

function request(path, method, body, session) {
	return new Request(`${ORIGIN}${path}`, {
		method,
		headers: {
			origin: ORIGIN,
			'sec-fetch-site': 'same-origin',
			'content-type': 'application/json',
			'x-csrf-token': CSRF,
			cookie: `apex_admin_session=${session}; apex_bff_csrf=${CSRF}`
		},
		body: body === undefined ? undefined : JSON.stringify(body)
	});
}

describe('cross-schema refusal — a story addressed through the update route', () => {
	it('GET finds nothing (404), and the archetype is never read', async () => {
		const calls = [];
		const ctx = ctxWith(calls);
		const session = await signIn(ctx);
		const res = await handleGetPost(
			request(`/api/admin/posts/update/${POST}`, 'GET', undefined, session),
			ctx,
			{
				schema: 'update',
				postId: POST
			}
		);
		assert.equal(res.status, 404);
		assert.ok(!calls.some(([name]) => name === 'getPostArchetype'));
		// …and the same id under its OWN schema loads.
		const ok = await handleGetPost(
			request(`/api/admin/posts/story/${POST}`, 'GET', undefined, session),
			ctx,
			{
				schema: 'story',
				postId: POST
			}
		);
		assert.equal(ok.status, 200);
		const body = await ok.json();
		assert.equal(body.post.id, POST);
		assert.deepEqual(body.post.fields, { kind: 'video' });
	});

	it('PATCH and DELETE find nothing (404), and write nothing', async () => {
		const calls = [];
		const ctx = ctxWith(calls);
		const session = await signIn(ctx);
		const patched = await handleUpdatePost(
			request(`/api/admin/posts/update/${POST}`, 'PATCH', { title: 'x' }, session),
			ctx,
			{ schema: 'update', postId: POST }
		);
		assert.equal(patched.status, 404);
		const deleted = await handleDeletePost(
			request(`/api/admin/posts/update/${POST}`, 'DELETE', undefined, session),
			ctx,
			{ schema: 'update', postId: POST }
		);
		assert.equal(deleted.status, 404);
		assert.ok(!calls.some(([name]) => name === 'updatePostFields' || name === 'deletePost'));
	});

	it('a content-library slug on the post route is 404, before any read', async () => {
		const calls = [];
		const ctx = ctxWith(calls);
		const session = await signIn(ctx);
		const res = await handleGetPost(
			request(`/api/admin/posts/focus_area/${POST}`, 'GET', undefined, session),
			ctx,
			{
				schema: 'focus_area',
				postId: POST
			}
		);
		assert.equal(res.status, 404);
		assert.deepEqual(calls, []);
	});
});

describe('create and update — what reaches Apex', () => {
	it('create sends the post attributes and the archetype primitive in ONE call, then re-reads', async () => {
		const calls = [];
		const ctx = ctxWith(calls);
		const session = await signIn(ctx);
		const res = await handleCreatePost(
			request(
				'/api/admin/posts/story',
				'POST',
				{ title: 'T', slug: 'a-story', fields: { kind: 'video' } },
				session
			),
			ctx,
			{ schema: 'story' }
		);
		assert.equal(res.status, 201, await res.clone().text());
		const create = calls.find(([name]) => name === 'createPost');
		assert.deepEqual(create[2], { title: 'T', slug: 'a-story', summary: '', published_date: '' });
		assert.deepEqual(create[3], { kind: 'video' });
		assert.ok(
			calls.some(([name]) => name === 'listPosts'),
			'the create re-reads through the scoped view'
		);
	});

	it('reads Apex’s 422 body into field errors', () => {
		assert.deepEqual(
			apexValidationErrors({
				data: [
					{ attribute_name: 'published_date', messages: ['is invalid'] },
					{ attribute_name: 'slug', messages: ['has already been taken'] },
					'junk'
				]
			}),
			[
				{ attribute: 'published_date', messages: ['is invalid'] },
				{ attribute: 'slug', messages: ['has already been taken'] }
			]
		);
		assert.deepEqual(apexValidationErrors(null), []);
	});

	it('a 422 that is NOT about the slug is surfaced as 422 invalid with the field errors', async () => {
		const calls = [];
		const ctx = ctxWith(calls, {
			createStatus: 422,
			createErrors: [{ attribute_name: 'published_date', messages: ['is invalid'] }]
		});
		const session = await signIn(ctx);
		const res = await handleCreatePost(
			request('/api/admin/posts/story', 'POST', { title: 'T', slug: 'fine' }, session),
			ctx,
			{ schema: 'story' }
		);
		assert.equal(res.status, 422);
		assert.deepEqual(await res.json(), {
			error: 'invalid',
			code: 'invalid',
			errors: [{ attribute: 'published_date', messages: ['is invalid'] }]
		});
	});

	it('a slug collision is a 409 the editor can act on', async () => {
		const calls = [];
		const ctx = ctxWith(calls, { createStatus: 422 });
		const session = await signIn(ctx);
		const res = await handleCreatePost(
			request('/api/admin/posts/story', 'POST', { title: 'T', slug: 'taken' }, session),
			ctx,
			{ schema: 'story' }
		);
		assert.equal(res.status, 409);
		assert.deepEqual(await res.json(), { error: 'slug-taken' });
	});

	it('update writes the cover by join id and the SEO by row id, on the POST', async () => {
		const calls = [];
		const ctx = ctxWith(calls, {
			view: { shared_gallery_items: [{ id: uuid(4), gallery_item_id: IMG1, kind: 'cover' }] }
		});
		const session = await signIn(ctx);
		const res = await handleUpdatePost(
			request(
				`/api/admin/posts/story/${POST}`,
				'PATCH',
				{ coverId: IMG2, meta: { title: 'New' } },
				session
			),
			ctx,
			{ schema: 'story', postId: POST }
		);
		assert.equal(res.status, 200, await res.clone().text());
		const write = calls.find(([name]) => name === 'updatePostFields');
		assert.equal(write[1], POST);
		assert.deepEqual(write[2], {
			meta_properties_attributes: [
				{ id: uuid(1), name: 'title', group: 'web', value_type: 'string', value: 'New' }
			],
			shared_gallery_items_attributes: [{ id: uuid(4), gallery_item_id: IMG2, kind: 'cover' }]
		});
	});

	it('update refuses `null` on a primitive but accepts it on the cover', async () => {
		const calls = [];
		const ctx = ctxWith(calls);
		const session = await signIn(ctx);
		const refused = await handleUpdatePost(
			request(`/api/admin/posts/story/${POST}`, 'PATCH', { title: null }, session),
			ctx,
			{ schema: 'story', postId: POST }
		);
		assert.equal(refused.status, 400);
		assert.deepEqual(await refused.json(), { error: 'null-field' });
		const cleared = await handleUpdatePost(
			request(`/api/admin/posts/story/${POST}`, 'PATCH', { coverId: null }, session),
			ctx,
			{ schema: 'story', postId: POST }
		);
		assert.equal(cleared.status, 200);
	});
});

describe('the post list reads EVERY page of both surfaces', () => {
	/** A paginating Apex: `count` rows per surface, `perPage` per page, joined by archetype id. */
	function paginating(count, perPage) {
		const views = Array.from({ length: count }, (_, i) => ({
			...view({
				id: `${String(i).padStart(8, '0')}-1111-2222-3333-444444444444`,
				archetype_id: `${String(i).padStart(8, 'a')}-1111-2222-3333-444444444444`.replace(
					/^a+/,
					(m) => m.replace(/a/g, 'a')
				),
				title: `Post ${i}`
			})
		}));
		// Archetype ids must be valid strings; use the view's archetype_id.
		const archetypes = views.map((v, i) =>
			archetype({
				id: v.archetype_id,
				primitives: { kind: i % 2 ? 'video' : 'article' },
				archetype_items: []
			})
		);
		const calls = [];
		const page = (rows, n) => ({
			ok: true,
			status: 200,
			body: {
				data: rows.slice((n - 1) * perPage, n * perPage),
				pagination: {
					total_count: rows.length,
					current_page: n,
					total_pages: Math.max(1, Math.ceil(rows.length / perPage))
				}
			}
		});
		return {
			calls,
			async listPosts(slug, query) {
				calls.push(['listPosts', query.page]);
				return page(views, query.page);
			},
			async listPostArchetypes(slug, query) {
				calls.push(['listPostArchetypes', query.page]);
				return page(archetypes, query.page);
			},
			async listContentLibrary() {
				return {
					ok: true,
					status: 200,
					body: { data: [], pagination: { total_count: 0, current_page: 1, total_pages: 1 } }
				};
			}
		};
	}

	it('joins every post to its archetype across three pages', async () => {
		const apex = paginating(250, 100);
		const catalogue = await loadPostCatalogue(contract, apex, 'story');
		assert.equal(catalogue.posts.length, 250);
		assert.ok(
			catalogue.posts.every((post) => post.fields.kind !== ''),
			'every post found its archetype half'
		);
		assert.deepEqual(
			apex.calls.filter(([name]) => name === 'listPosts').map(([, p]) => p),
			[1, 2, 3]
		);
		assert.deepEqual(
			apex.calls.filter(([name]) => name === 'listPostArchetypes').map(([, p]) => p),
			[1, 2, 3]
		);
	});

	it('page 2 failing after page 1 succeeded is no catalogue at all — 502, not half a list', async () => {
		const apex = paginating(250, 100);
		const archetypes = apex.listPostArchetypes;
		apex.listPostArchetypes = async (slug, query) =>
			query.page === 2 ? { ok: false, status: 500, body: null } : archetypes(slug, query);
		assert.equal(await loadPostCatalogue(contract, apex, 'story'), null);

		const ctx = { ...ctxWith([]), createApexClient: () => apex };
		const session = await signIn(ctx);
		const res = await handleListPosts(
			request('/api/admin/posts/story', 'GET', undefined, session),
			ctx,
			{ schema: 'story' }
		);
		assert.equal(res.status, 502);
		assert.deepEqual(await res.json(), { error: 'upstream error' });
		assert.equal(res.headers.get('cache-control'), 'no-store');
	});

	it('fails CLOSED when a page will not read or the pagination is missing', async () => {
		assert.equal(await listAllPages(async () => ({ ok: false, body: null })), null);
		// Page 2 fails AFTER page 1 succeeded: the rows already read are not a
		// partial answer, they are no answer.
		const asked = [];
		assert.equal(
			await listAllPages(async (n) => {
				asked.push(n);
				return n === 1
					? { ok: true, body: { data: [{ id: 'p1' }], pagination: { total_pages: 3 } } }
					: { ok: false, body: null };
			}),
			null
		);
		assert.deepEqual(asked, [1, 2], 'page 1 was read, page 2 failed, page 3 never asked for');
		assert.equal(
			await listAllPages(async () => ({ ok: true, body: { data: [{ id: 'x' }] } })),
			null
		);
		assert.deepEqual(
			await listAllPages(async (n) => ({
				ok: true,
				body: { data: [{ id: `p${n}` }], pagination: { total_pages: 2 } }
			})),
			[{ id: 'p1' }, { id: 'p2' }]
		);
	});
});

describe('countReferencesTo — posts are counted through the archetypes surface', () => {
	it('counts a story and an update that hold the focus area, and no others', async () => {
		const calls = [];
		const apex = apexStub(calls, {
			archetypesFor: (slug) =>
				slug === 'story'
					? [archetype(), { id: uuid(2), archetype_items: [] }]
					: [
							{
								id: uuid(3),
								archetype_items: [
									{
										id: uuid(4),
										relatable_type: 'Specification::Archetype',
										archetype_schema_item: { name: 'focus_area' },
										fields_data: { focus_area: FA1 }
									}
								]
							}
						]
		});
		const counted = await countReferencesTo(contract, apex, 'focus_area', FA1);
		assert.deepEqual(counted, { ok: true, count: 2 });
		assert.deepEqual(
			calls.map(([name, slug]) => `${name}:${slug}`),
			['listPostArchetypes:story', 'listPostArchetypes:update']
		);
		assert.deepEqual(await countReferencesTo(contract, apex, 'focus_area', FA2), {
			ok: true,
			count: 0
		});
	});

	it('fails CLOSED when the client refuses the post slug', async () => {
		// A real client with no `allowedPostSlugs` throws; the count must not become 500.
		const apex = createApexAdminClient({
			baseUrl: 'https://apex.internal',
			token: 't',
			fetchImpl: async () => {
				throw new Error('must not be reached');
			}
		});
		assert.deepEqual(await countReferencesTo(contract, apex, 'focus_area', FA1), { ok: false });
	});
});

describe('the status route does not put a post status in a key called `status`', () => {
	/**
	 * `bff-client.js`'s `mutate` writes the HTTP status onto its result and THEN
	 * spreads the body over it, so a body key called `status` REPLACES the real one.
	 * Nine operations were fixed when the numeric case was found; this one held a
	 * post-status STRING, which is worse — `result.status === 'published'` type-checks
	 * and reads like a deliberate API, and a caller comparing it to `200` sees false.
	 */
	it('answers { ok, postStatus } and never a body key named status', async () => {
		const calls = [];
		const ctx = ctxWith(calls, {});
		const session = await signIn(ctx);
		const res = await handlePatchPostStatus(
			request(`/api/admin/posts/story/${POST}/status`, 'POST', { statusEvent: 'publish' }, session),
			ctx,
			{ schema: 'story', postId: POST }
		);
		assert.equal(res.status, 200);
		const body = await res.json();
		assert.equal(body.ok, true);
		assert.equal(body.postStatus, 'published');
		assert.equal('status' in body, false, 'the key that shadows the HTTP status is gone');
		assert.deepEqual(
			calls.filter((call) => call[0] === 'changePostStatus'),
			[['changePostStatus', POST, 'publish']]
		);
	});
});

describe('create — the audit row may not contradict the response', () => {
	/**
	 * P5 fix 3, item 2 — the same rule `handleCreateEntity` got, applied here.
	 *
	 * `createPost` wrote `accepted` before it knew the 2xx carried a usable post id,
	 * and could then answer 502 while the log said the operation had been accepted.
	 * The post id is the archetype's `target_model_id`, so an idless or malformed
	 * archetype echo is the case that matters. And the post-create RE-READ could fail
	 * with no trace: the post really does exist and is named, so `accepted` is true
	 * and stays — but the 502 the editor was sent has to be in the log too.
	 *
	 * MUTATIONS: audit `apexResponse.ok ? 'accepted' : 'apex_error'` again — the
	 * first two cases fail; drop the second `auditOutcome` in the `!loaded` branch —
	 * the third fails.
	 */
	const OTHER_POST = 'bbbbbbbb-1111-2222-3333-444444444444';

	async function rows(db) {
		return db.sqlite
			.prepare('SELECT outcome, detail FROM bff_audit_log ORDER BY occurred_at, rowid')
			.all()
			.map((row) => ({ ...row, detail: JSON.parse(row.detail) }));
	}

	async function create(options) {
		const db = await createMigratedDatabase();
		const ctx = ctxWith([], options, db);
		const session = await signIn(ctx);
		const res = await handleCreatePost(
			request('/api/admin/posts/story', 'POST', { title: 'T', slug: 'a-story' }, session),
			ctx,
			{ schema: 'story' }
		);
		const audit = await rows(db);
		db.close();
		return { res, audit };
	}

	it('an archetype echo with NO target_model_id is `upstream_shape_error`', async () => {
		const { res, audit } = await create({ createdPostId: null });
		assert.equal(res.status, 502);
		assert.equal(audit.length, 1);
		assert.equal(audit[0].outcome, 'upstream_shape_error');
		assert.equal(audit[0].detail.reason, 'missing-post-id');
		assert.equal(audit[0].detail.postId, null);
	});

	it('a NON-UUID target_model_id is `malformed-post-id`, and keeps the raw value', async () => {
		const { res, audit } = await create({ createdPostId: 'yes' });
		assert.equal(res.status, 502);
		assert.equal(audit[0].outcome, 'upstream_shape_error');
		assert.equal(audit[0].detail.reason, 'malformed-post-id');
		assert.equal(audit[0].detail.returnedId, 'yes');
	});

	it('a failed post-create RE-READ stays accepted AND records the read failure', async () => {
		// The post exists and this operation can name it, so the acceptance is true.
		// Without the second row the log would say a create succeeded and be silent
		// about the 502 the editor was actually sent.
		const { res, audit } = await create({ createdPostId: OTHER_POST });
		assert.equal(res.status, 502);
		assert.equal(audit.length, 2);
		assert.equal(audit[0].outcome, 'accepted');
		assert.equal(audit[0].detail.postId, OTHER_POST);
		assert.equal(audit[1].outcome, 'apex_error');
		assert.equal(audit[1].detail.reason, 'post-create-read-failed');
		assert.equal(audit[1].detail.postId, OTHER_POST);
	});

	it('the control: a real uuid is accepted, ONE row, and the post named in it', async () => {
		const { res, audit } = await create({});
		assert.equal(res.status, 201);
		assert.equal(audit.length, 1);
		assert.equal(audit[0].outcome, 'accepted');
		assert.equal(audit[0].detail.postId, POST);
		assert.ok(!('reason' in audit[0].detail));
	});
});
