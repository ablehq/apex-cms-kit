// @ts-nocheck — node:test suite over dynamic JSON shapes; behavior is the contract.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	apexBlockRows,
	apexValidationErrors,
	buildBlocksAttributes,
	changedImageBlocks,
	computeBodyVersion,
	computePostVersion,
	coverAttributes,
	isCalendarDate,
	listAllPages,
	metaAttributes,
	normalizeBlocks,
	postSchemaOf,
	readCoverId,
	readMeta,
	savePostBodySchema,
	summarizePost
} from '../src/server/bff/operations/post-shape.ts';
import { handleSavePostBody } from '../src/server/bff/operations/save-post-body.ts';
import { createPostDraft, setPostBlocks } from '../src/admin/post-draft.js';
import { createPostBodySchema } from '../src/server/bff/operations/create-post.ts';
import {
	handleUpdatePost,
	updatePostBodySchema
} from '../src/server/bff/operations/update-post.ts';
import { handleGetPost, handleReadPostVersion } from '../src/server/bff/operations/get-post.ts';
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
const DIVIDER = 'Cms::DocumentBlock::Divider';
// The Disk-SAFE passthrough. `Video` and the legacy `Image` serialise `file … :url`
// and raise inside Apex on Disk storage, so `Spacer` is the block a real-Apex test
// can insert beside an editable one without setting the trap off.
const SPACER = 'Cms::DocumentBlock::Spacer';

const uuid = (n) => `${`${n}`.repeat(8)}-1111-2222-3333-444444444444`.slice(0, 36);
const ID_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const ID_B = 'bbbbbbbb-1111-2222-3333-444444444444';
const ID_C = 'cccccccc-1111-2222-3333-444444444444';
const ID_D = 'dddddddd-aaaa-2222-3333-444444444444';
const ID_E = 'eeeeeeee-aaaa-2222-3333-444444444444';
const POST = 'dddddddd-1111-2222-3333-444444444444';
const ARCH = 'eeeeeeee-1111-2222-3333-444444444444';
const DOC = 'ffffffff-1111-2222-3333-444444444444';
const FA1 = '11111111-1111-2222-3333-444444444444';
const FA2 = '22222222-1111-2222-3333-444444444444';
const IMG1 = '33333333-1111-2222-3333-444444444444';
const IMG2 = '44444444-1111-2222-3333-444444444444';
// A real gallery item that is NOT in the images gallery — the shape `shared_gallery_item.rb`
// happily accepts as a cover, and `gallery_item_id` happily stores on a block.
const VIDEO_ITEM = '55555555-1111-2222-3333-444444444444';
const GALLERY_ID = '66666666-1111-2222-3333-444444444444';
const VIDEO_GALLERY_ID = '77777777-1111-2222-3333-444444444444';

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

/**
 * The shared document fixture: three EDITABLE blocks, one of each of the kinds
 * whose payload differs. The GalleryItem at `ID_C` used to be here as the block
 * the editor was NOT shown; it is editable now, so the preservation property moved
 * to `apexBlocksWithSpacer()`.
 */
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

/** The same document with a PASSTHROUGH `Spacer` in the middle — what a save must never touch. */
function apexBlocksWithSpacer() {
	return [
		{
			id: ID_A,
			position: 0,
			blockable_type: RICH,
			blockable: { id: uuid(5), content_html: '<p>One.</p>' }
		},
		{ id: ID_D, position: 1, blockable_type: SPACER, blockable: { id: uuid(4), kind: 'small' } },
		{
			id: ID_B,
			position: 2,
			blockable_type: QUOTE,
			blockable: { id: uuid(6), quote: 'Q.', quoted_by: 'W' }
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
	it('keeps an unchanged block of every editable kind by id rather than appending a copy', () => {
		const attributes = buildBlocksAttributes(apexBlockRows(apexBlocks()), [
			{ id: ID_A, kind: 'rich_text', html: '<p>One.</p>' },
			{ id: ID_B, kind: 'quote', quote: 'Q.', quotedBy: 'W' },
			{ id: ID_C, kind: 'image', galleryItemId: IMG1 }
		]);
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
		// THE INNER ID travels on every one of them. Omit it and Apex mints a fresh
		// `blockable` row per save: the outer id holds while the row under it churns.
		assert.deepEqual(
			attributes.map((row) => row.blockable_attributes.id),
			[uuid(5), uuid(6), uuid(7)]
		);
		assert.deepEqual(attributes[2].blockable_attributes, { id: uuid(7), gallery_item_id: IMG1 });
	});

	it('NEVER destroys a passthrough block — a Spacer the editor was not shown', () => {
		// The editor round-trips only what `normalizeBlocks` handed it. `Spacer` is not
		// in that list, and a save that did not mention it must not delete it. Since the
		// four editable kinds now include `image`, this is the only remaining exercise
		// of the untouched-slot path.
		const attributes = buildBlocksAttributes(apexBlockRows(apexBlocksWithSpacer()), []);
		assert.deepEqual(
			attributes
				.filter((row) => row._destroy)
				.map((row) => row.id)
				.sort(),
			[ID_A, ID_B].sort()
		);
		const spacer = attributes.find((row) => row.id === ID_D);
		assert.ok(spacer && !spacer._destroy, 'the spacer survives');
		// …and its position is COMPACTED to 0, because it is the only row left. Leaving
		// it on 1 is the sparse numbering nothing upstream ever heals.
		assert.deepEqual(spacer, { id: ID_D, position: 0 }, 'only its position is restated');
	});

	it('numbers positions across ALL blocks in document order — a passthrough keeps its slot', () => {
		// Spacer in the MIDDLE: [rich A @0, spacer @1, quote B @2]. The editor swaps its
		// two blocks. Numbering only the editable blocks from 0 would put B on 0 and A on
		// 1 while the spacer stayed on 1 — a collision Apex resolves arbitrarily.
		const attributes = buildBlocksAttributes(apexBlockRows(apexBlocksWithSpacer()), [
			{ id: ID_B, kind: 'quote', quote: 'Q.', quotedBy: 'W' },
			{ id: ID_A, kind: 'rich_text', html: '<p>One.</p>' },
			{ id: null, kind: 'rich_text', html: '<p>new</p>' }
		]);
		const positions = attributes
			.filter((row) => !row._destroy)
			.map((row) => [row.id ?? 'new', row.position])
			.sort((a, b) => a[1] - b[1]);
		assert.deepEqual(positions, [
			[ID_B, 0],
			[ID_D, 1],
			[ID_A, 2],
			['new', 3]
		]);
		assert.ok(!attributes.some((row) => row._destroy), 'nothing destroyed');
	});

	it('compacts positions to 0…n-1 after removals around a passthrough', () => {
		// [A, B, Spacer, C] → keep A only. The slot algorithm alone emits `0, 2`; nothing
		// upstream renumbers (`document_block.rb` has no callback), so the gap is
		// permanent and the next removal widens it.
		const rows = apexBlockRows([
			{ id: ID_A, position: 0, blockable_type: RICH, blockable: { id: uuid(5) } },
			{ id: ID_B, position: 1, blockable_type: QUOTE, blockable: { id: uuid(6) } },
			{ id: ID_D, position: 2, blockable_type: SPACER, blockable: { id: uuid(4) } },
			{ id: ID_C, position: 3, blockable_type: GALLERY, blockable: { id: uuid(7) } }
		]);
		const attributes = buildBlocksAttributes(rows, [
			{ id: ID_A, kind: 'rich_text', html: '<p>One.</p>' }
		]);
		assert.deepEqual(
			attributes
				.filter((row) => !row._destroy)
				.map((row) => [row.id, row.position])
				.sort((a, b) => a[1] - b[1]),
			[
				[ID_A, 0],
				[ID_D, 1]
			],
			'contiguous BY VALUE, not merely unique'
		);

		// A TRAILING passthrough, and everything before it removed.
		const trailing = buildBlocksAttributes(
			apexBlockRows([
				{ id: ID_A, position: 0, blockable_type: RICH, blockable: { id: uuid(5) } },
				{ id: ID_B, position: 1, blockable_type: QUOTE, blockable: { id: uuid(6) } },
				{ id: ID_D, position: 2, blockable_type: SPACER, blockable: { id: uuid(4) } }
			]),
			[]
		);
		assert.deepEqual(
			trailing.filter((row) => !row._destroy),
			[{ id: ID_D, position: 0 }]
		);
	});

	it('normalizes the four editable kinds and drops the rest', () => {
		assert.deepEqual(
			normalizeBlocks([
				...apexBlocks(),
				{
					id: ID_D,
					position: 3,
					blockable_type: DIVIDER,
					blockable: { id: uuid(4), kind: 'large' }
				},
				{
					id: ID_E,
					position: 4,
					blockable_type: SPACER,
					blockable: { id: uuid(3), kind: 'small' }
				},
				{ id: uuid(2), position: 5, blockable_type: 'Cms::DocumentBlock::Video', blockable: {} },
				// The LEGACY image block — its own `Medium`, not a GalleryItem. A passthrough.
				{ id: uuid(1), position: 6, blockable_type: 'Cms::DocumentBlock::Image', blockable: {} }
			]).map((block) => block.kind),
			['rich_text', 'quote', 'image', 'divider']
		);
		assert.deepEqual(normalizeBlocks(apexBlocks())[2], {
			id: ID_C,
			kind: 'image',
			galleryItemId: IMG1
		});
	});

	it('a divider with no stored kind reads as medium; the three real kinds read as themselves', () => {
		const read = (kind) =>
			normalizeBlocks([
				{ id: ID_D, position: 0, blockable_type: DIVIDER, blockable: { id: uuid(4), kind } }
			])[0].dividerKind;
		assert.equal(read('small'), 'small');
		assert.equal(read('medium'), 'medium');
		assert.equal(read('large'), 'large');
		assert.equal(read(null), 'medium', 'kind is allow_nil upstream');
		assert.equal(read('enormous'), 'medium', 'and unvalidated values read as the default too');
	});

	it('a GalleryItem row with a NULL item reads as an image block with no picture', () => {
		assert.deepEqual(
			normalizeBlocks([
				{
					id: ID_C,
					position: 0,
					blockable_type: GALLERY,
					blockable: { id: uuid(7), gallery_item_id: null }
				}
			]),
			[{ id: ID_C, kind: 'image', galleryItemId: null }]
		);
	});

	it('writes a divider as `kind` and an image as `gallery_item_id` — the permitted keys', () => {
		const created = buildBlocksAttributes(
			[],
			[
				{ id: null, kind: 'divider', dividerKind: 'large' },
				{ id: null, kind: 'image', galleryItemId: IMG2 }
			]
		);
		assert.deepEqual(created, [
			{ blockable_type: DIVIDER, blockable_attributes: { kind: 'large' }, position: 0 },
			{ blockable_type: GALLERY, blockable_attributes: { gallery_item_id: IMG2 }, position: 1 }
		]);
	});

	it('updates a divider’s kind and an image’s item IN PLACE, keeping both ids', () => {
		const rows = apexBlockRows([
			{ id: ID_D, position: 0, blockable_type: DIVIDER, blockable: { id: uuid(4), kind: 'small' } },
			{
				id: ID_C,
				position: 1,
				blockable_type: GALLERY,
				blockable: { id: uuid(7), gallery_item_id: IMG1 }
			}
		]);
		const attributes = buildBlocksAttributes(rows, [
			{ id: ID_D, kind: 'divider', dividerKind: 'large' },
			{ id: ID_C, kind: 'image', galleryItemId: IMG2 }
		]);
		assert.deepEqual(attributes, [
			{
				id: ID_D,
				blockable_type: DIVIDER,
				blockable_attributes: { id: uuid(4), kind: 'large' },
				position: 0
			},
			{
				id: ID_C,
				blockable_type: GALLERY,
				blockable_attributes: { id: uuid(7), gallery_item_id: IMG2 },
				position: 1
			}
		]);
	});

	it('a stored NULL gallery_item_id round-trips on an unchanged block, both ids intact', () => {
		// The column is nullable and the association optional, so a GalleryItem block
		// with no item can exist upstream. Under a strict non-null schema it could not be
		// read back and re-sent, and once the kind is editable, omitting it destroys it.
		const rows = apexBlockRows([
			{
				id: ID_C,
				position: 0,
				blockable_type: GALLERY,
				blockable: { id: uuid(7), gallery_item_id: null }
			},
			{
				id: ID_A,
				position: 1,
				blockable_type: RICH,
				blockable: { id: uuid(5), content_html: '<p>x</p>' }
			}
		]);
		const attributes = buildBlocksAttributes(rows, [
			...normalizeBlocks([
				{
					id: ID_C,
					position: 0,
					blockable_type: GALLERY,
					blockable: { id: uuid(7), gallery_item_id: null }
				}
			]),
			{ id: ID_A, kind: 'rich_text', html: '<p>edited</p>' }
		]);
		assert.deepEqual(attributes[0], {
			id: ID_C,
			blockable_type: GALLERY,
			blockable_attributes: { id: uuid(7), gallery_item_id: null },
			position: 0
		});
		// …and it is NOT a changed image block, so it costs no gallery read.
		assert.deepEqual(
			changedImageBlocks(rows, [
				{ id: ID_C, kind: 'image', galleryItemId: null },
				{ id: ID_A, kind: 'rich_text', html: '<p>edited</p>' }
			]),
			[]
		);
		// Repairing it through the picker IS a change.
		assert.deepEqual(changedImageBlocks(rows, [{ id: ID_C, kind: 'image', galleryItemId: IMG1 }]), [
			{ index: 0, galleryItemId: IMG1 }
		]);
	});

	it('turns a changed KIND into a create plus a destroy, across all four kinds', () => {
		const attributes = buildBlocksAttributes(apexBlockRows(apexBlocks()), [
			{ id: ID_A, kind: 'quote', quote: 'Now a quotation.', quotedBy: '' },
			{ id: ID_C, kind: 'divider', dividerKind: 'small' }
		]);
		assert.ok(attributes.some((row) => row._destroy && row.id === ID_A));
		assert.ok(attributes.some((row) => row._destroy && row.id === ID_C));
		assert.ok(attributes.some((row) => !row.id && row.blockable_type === QUOTE));
		assert.ok(attributes.some((row) => !row.id && row.blockable_type === DIVIDER));
		// A kind change is a create, so it is a CHANGED image block even when the id is
		// carried over — otherwise the new GalleryItem row would skip the gallery check.
		assert.deepEqual(
			changedImageBlocks(apexBlockRows(apexBlocks()), [
				{ id: ID_A, kind: 'image', galleryItemId: IMG1 }
			]),
			[{ index: 0, galleryItemId: IMG1 }]
		);
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

	it('body: a block is one of FOUR kinds, each closed, and the version key is required', () => {
		const ok = (blocks) => savePostBodySchema.safeParse({ blocks, bodyVersion: 'v' }).success;
		assert.ok(ok([]));
		assert.ok(ok([{ kind: 'divider', dividerKind: 'small' }]));
		assert.ok(ok([{ kind: 'image', galleryItemId: IMG1 }]));
		assert.ok(ok([{ kind: 'image', galleryItemId: null }]));
		// `url` is not a key of the image block, and `galleryItemId` is not optional.
		assert.ok(!ok([{ kind: 'image', url: 'x' }]));
		assert.ok(!ok([{ kind: 'image', galleryItemId: IMG1, caption: 'read-only' }]));
		assert.ok(!ok([{ kind: 'divider' }]), 'a divider always names its size');
		assert.ok(!ok([{ kind: 'divider', dividerKind: 'enormous' }]));
		assert.ok(!ok([{ kind: 'quote', html: '<p>x</p>' }]), 'kinds do not share keys');
		assert.ok(!ok([{ kind: 'spacer' }]), 'a passthrough kind is not authorable');
		assert.ok(!savePostBodySchema.safeParse({ blocks: [] }).success, 'bodyVersion is required');
		assert.ok(
			!savePostBodySchema.safeParse({ blocks: [], bodyVersion: '' }).success,
			'and may not be empty'
		);
	});

	it('the ROUND TRIP: what the server hands out parses when it is handed straight back', async () => {
		// "Outbound shape = inbound shape" is what makes the draft able to hold the
		// server's blocks verbatim and send them verbatim into a `.strict()` schema. A
		// read-only convenience key added to the outbound block would break this.
		const rows = [
			...apexBlocks(),
			{ id: ID_D, position: 3, blockable_type: DIVIDER, blockable: { id: uuid(4), kind: 'large' } }
		];
		const blocks = normalizeBlocks(rows);
		const draft = createPostDraft('story', { id: POST, blocks }, 'v', contract, 'bv');
		setPostBlocks(draft, draft.blocks);
		const parsed = savePostBodySchema.safeParse({
			blocks: draft.blocks,
			bodyVersion: draft.bodyVersion
		});
		assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
		assert.deepEqual(parsed.data.blocks, blocks);
	});

	it('the body version moves for a divider’s size and an image’s item, and only for a real change', async () => {
		const base = await computeBodyVersion(apexBlocks());
		assert.equal(await computeBodyVersion(apexBlocks()), base, 'stable across identical reads');
		assert.equal(
			await computeBodyVersion([...apexBlocks()].reverse()),
			base,
			'and across key/row order, because it sorts by position'
		);
		const repointed = apexBlocks();
		repointed[2].blockable.gallery_item_id = IMG2;
		assert.notEqual(await computeBodyVersion(repointed), base);
		const resized = [
			{ id: ID_D, position: 0, blockable_type: DIVIDER, blockable: { id: uuid(4), kind: 'small' } }
		];
		const resizedLarge = [
			{ id: ID_D, position: 0, blockable_type: DIVIDER, blockable: { id: uuid(4), kind: 'large' } }
		];
		assert.notEqual(await computeBodyVersion(resized), await computeBodyVersion(resizedLarge));
		// A PASSTHROUGH row appearing moves it too — the save is about to renumber it.
		assert.notEqual(await computeBodyVersion(apexBlocksWithSpacer()), base);
	});

	it('the composite version moves for a divider’s size and an image’s item', async () => {
		const version = (blocks) => computePostVersion(view(), archetype(), blocks, contract, 'story');
		const base = await version(normalizeBlocks(apexBlocks()));
		const repointed = apexBlocks();
		repointed[2].blockable.gallery_item_id = IMG2;
		assert.notEqual(await version(normalizeBlocks(repointed)), base);
		assert.notEqual(
			await version([{ id: ID_D, kind: 'divider', dividerKind: 'small' }]),
			await version([{ id: ID_D, kind: 'divider', dividerKind: 'large' }])
		);
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
function apexStub(calls, options = {}, stored = {}) {
	let documentWritten = false;
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
		/**
		 * `documentStatus` drives the failure cases: a non-2xx read, and `'throw'` for a
		 * transport fault. `documentReads` lets one test answer DIFFERENT rows on the
		 * second read, which is the interleaved save.
		 */
		async getDocument(id) {
			calls.push(['getDocument', id]);
			const seen = calls.filter(([name]) => name === 'getDocument').length;
			if (options.documentStatus === 'throw') throw new TypeError('network');
			// A 2xx the client could not PARSE. It classes a non-JSON or truncated 200 as
			// a shape error and hands back `body: null` with `ok: true` — the third door
			// into the fail-open defect, and the one the status and throw guards miss.
			if (options.documentShapeFault && (!options.shapeFaultAfterWrite || documentWritten)) {
				return { ok: true, status: 200, body: null };
			}
			if (typeof options.documentStatus === 'number' && options.documentStatus >= 400) {
				return { ok: false, status: options.documentStatus, body: null };
			}
			if (options.documentStatusAfterWrite && documentWritten) {
				if (options.documentStatusAfterWrite === 'throw') throw new TypeError('network');
				return { ok: false, status: options.documentStatusAfterWrite, body: null };
			}
			const rows = options.documentReads
				? (options.documentReads[seen - 1] ?? options.documentReads.at(-1))
				: (options.blocks ?? apexBlocks());
			return { ok: true, status: 200, body: { data: { id, blocks: rows } } };
		},
		/**
		 * A PATCH double that MUTATES its stored rows BEFORE it answers, so a test can
		 * prove what a failing write left behind. Rails commits at `resource.update` and
		 * can still raise while rendering — a 500 is not evidence that nothing landed.
		 */
		async updateDocumentBlocks(id, attributes) {
			calls.push(['updateDocumentBlocks', id, attributes]);
			documentWritten = true;
			stored.documentBlocks = attributes;
			if (options.patchStatus === 'throw') throw new TypeError('network');
			if (typeof options.patchStatus === 'number' && options.patchStatus >= 400) {
				return { ok: false, status: options.patchStatus, body: null };
			}
			return { ok: true, status: 200, body: { data: { id } } };
		},
		async readCmsConfig() {
			calls.push(['readCmsConfig']);
			if (options.galleryStatus && options.galleryStatus >= 400) {
				return { ok: false, status: options.galleryStatus, body: null };
			}
			return {
				ok: true,
				status: 200,
				body: {
					data: {
						asset_library: [
							{ gallery: { id: GALLERY_ID, name: 'images' } },
							{ gallery: { id: VIDEO_GALLERY_ID, name: 'videos' } }
						]
					}
				}
			};
		},
		async listGalleryItems(galleryId) {
			calls.push(['listGalleryItems', galleryId]);
			if (options.itemsStatus && options.itemsStatus >= 400) {
				return { ok: false, status: options.itemsStatus, body: null };
			}
			const members = options.galleryMembers ?? [IMG1, IMG2];
			return {
				ok: true,
				status: 200,
				body: {
					data: members.map((id, index) => ({
						id,
						gallery_id: galleryId,
						position: index,
						created_at: `2026-09-0${index + 1}T00:00:00Z`
					})),
					pagination: { total_count: members.length, current_page: 1, total_pages: 1 }
				}
			};
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
			if (options.updatePostFieldsStatus === 422) {
				return {
					ok: false,
					status: 422,
					body: {
						data: [
							{ attribute_name: 'shared_gallery_items.gallery_item', messages: ['must exist'] }
						]
					}
				};
			}
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

function ctxWith(calls, options = {}, db) {
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
		createApexClient: () => apexStub(calls, options, (options.stored ??= {})),
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

	it('a failed post-create RE-READ is 201 `unread`, not 502 — the post exists', async () => {
		// The post exists and this operation can NAME it, so the acceptance is true and
		// so is the 201. Answering 502 sent a minted post back as an error: the "New …"
		// dialog offered the same slug again and the second attempt was `409 slug-taken`
		// for a post the editor could not see.
		const { res, audit } = await create({ createdPostId: OTHER_POST });
		assert.equal(res.status, 201);
		const body = await res.json();
		assert.equal(body.ok, true);
		assert.equal(body.unread, true);
		assert.equal(body.post.id, OTHER_POST, 'the list screen reads result.post.id');
		assert.equal(body.post.archetypeId, ARCH);
		assert.equal(body.post.status, 'draft');
		assert.ok(!('version' in body), 'no version is offered for a record nobody could read');
		// Two rows: the create landed, and the degraded answer is not silent.
		assert.equal(audit.length, 2);
		assert.equal(audit[0].outcome, 'accepted');
		assert.equal(audit[0].detail.postId, OTHER_POST);
		assert.equal(audit[1].outcome, 'accepted');
		assert.equal(audit[1].detail.unread, true);
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

/**
 * The body save END TO END, through the real operation with a recording Apex.
 *
 * Everything here is about a failure the old code could not express: a read that
 * failed and was reported as "the document is empty", and a write that landed and
 * was reported as "nothing was saved".
 */
describe('save-post-body — a failed read, and a write that may have landed', () => {
	const bodyRequest = (body, session) =>
		request(`/api/admin/posts/story/${POST}/body`, 'PUT', body, session);

	async function saveBody(options, blocks, bodyVersionOverride) {
		const calls = [];
		const db = await createMigratedDatabase();
		const ctx = ctxWith(calls, options, db);
		const session = await signIn(ctx);
		const bodyVersion =
			bodyVersionOverride ?? (await computeBodyVersion(options.blocks ?? apexBlocks()));
		const res = await handleSavePostBody(bodyRequest({ blocks, bodyVersion }, session), ctx, {
			schema: 'story',
			postId: POST
		});
		const { results } = await db.prepare('SELECT outcome, detail FROM bff_audit_log').bind().all();
		db.close();
		return {
			res,
			calls,
			audit: results.map((row) => ({ outcome: row.outcome, detail: JSON.parse(row.detail) })),
			stored: options.stored ?? {}
		};
	}

	const KEEP = [
		{ id: ID_A, kind: 'rich_text', html: '<p>One.</p>' },
		{ id: ID_B, kind: 'quote', quote: 'Q.', quotedBy: 'W' },
		{ id: ID_C, kind: 'image', galleryItemId: IMG1 }
	];

	it('(a) the pre-write read fails → 502 BEFORE any PATCH, and the document is untouched', async () => {
		// THE DEFECT THIS PHASE EXISTS FOR. `readDocumentBlocks` answered `[]` on a
		// failed read; the diff then saw an empty document, every block became an id-less
		// CREATE, the body DOUBLED, and the editor was told 200.
		const { res, calls, audit } = await saveBody({ documentStatus: 500, stored: {} }, KEEP);
		assert.equal(res.status, 502);
		assert.deepEqual(await res.json(), { error: 'upstream error' });
		assert.equal(
			calls.filter(([name]) => name === 'updateDocumentBlocks').length,
			0,
			'ZERO PATCHes'
		);
		assert.equal(audit.length, 1);
		assert.equal(audit[0].outcome, 'rejected', 'nothing reached Apex, so a rejection is honest');
		assert.match(audit[0].detail.reason, /document unreadable/u);
	});

	it('(a′) a transport THROW on the pre-write read is the same 502, not a 500', async () => {
		const { res, calls } = await saveBody({ documentStatus: 'throw', stored: {} }, KEEP);
		assert.equal(res.status, 502);
		assert.equal(calls.filter(([name]) => name === 'updateDocumentBlocks').length, 0);
	});

	it('(a″) a 2xx the client could NOT PARSE is a failed read, not an empty document', async () => {
		// The third door into the same defect. `apex-admin-client` deliberately classes a
		// non-JSON or truncated 200 as a SHAPE error — `{ok:true, status:200, body:null}` —
		// so the status guard and the throw guard both wave it through. It used to reduce
		// to `[]` here, which is the fail-open state this phase exists to remove.
		const { res, calls, audit } = await saveBody({ documentShapeFault: true, stored: {} }, KEEP);
		assert.equal(res.status, 502, 'a read that did not parse is 502, never a 409 or a 200');
		assert.deepEqual(await res.json(), { error: 'upstream error' });
		assert.equal(
			calls.filter(([name]) => name === 'updateDocumentBlocks').length,
			0,
			'ZERO PATCHes'
		);
		assert.equal(audit[0].outcome, 'rejected');
		assert.match(audit[0].detail.reason, /document unreadable/u);
	});

	it('(b) PATCH 200 then a failed re-read → `body-written-unread`, ONE patch, audited accepted', async () => {
		const { res, calls, audit } = await saveBody({ documentStatusAfterWrite: 500, stored: {} }, [
			...KEEP,
			{ id: null, kind: 'divider', dividerKind: 'large' }
		]);
		assert.equal(res.status, 502);
		assert.deepEqual(await res.json(), {
			error: 'body-written-unread',
			code: 'body-written-unread'
		});
		assert.equal(calls.filter(([name]) => name === 'updateDocumentBlocks').length, 1);
		assert.equal(audit.length, 1);
		assert.equal(audit[0].outcome, 'accepted', 'a write that may have landed is not a rejection');
		assert.equal(audit[0].detail.unread, true);
		assert.equal(audit[0].detail.apexStatus, 200);
	});

	it('(b′) a PATCH that MUTATES its rows and then answers 500 is write-uncertain', async () => {
		// Rails commits at `resource.update` and can raise while RENDERING the response
		// — exactly what the Disk-service trap does. The double writes first, then fails.
		const { res, calls, audit, stored } = await saveBody({ patchStatus: 500, stored: {} }, [
			...KEEP,
			{ id: null, kind: 'divider', dividerKind: 'small' }
		]);
		assert.equal(res.status, 502);
		assert.equal((await res.json()).code, 'body-written-unread');
		assert.equal(calls.filter(([name]) => name === 'updateDocumentBlocks').length, 1);
		// The double's own rows prove the write landed even though the answer was 500.
		assert.ok(stored.documentBlocks, 'the PATCH stored its attributes before failing');
		assert.ok(
			stored.documentBlocks.some((row) => row.blockable_type === DIVIDER),
			'including the new divider'
		);
		assert.equal(audit[0].outcome, 'accepted');
		assert.equal(audit[0].detail.unread, true);
		assert.equal(audit[0].detail.apexStatus, 500);
	});

	it('(b″) a PATCH that THROWS is write-uncertain too — the request left the process', async () => {
		const { res, audit } = await saveBody({ patchStatus: 'throw', stored: {} }, [
			...KEEP,
			{ id: null, kind: 'rich_text', html: '<p>new</p>' }
		]);
		assert.equal(res.status, 502);
		assert.equal((await res.json()).code, 'body-written-unread');
		assert.equal(audit[0].outcome, 'accepted');
		assert.equal(audit[0].detail.unread, true);
	});

	it('a 4xx from the PATCH is an ORDINARY failure — Apex validates before it commits', async () => {
		const { res, audit } = await saveBody({ patchStatus: 422, stored: {} }, [
			...KEEP,
			{ id: null, kind: 'rich_text', html: '<p>new</p>' }
		]);
		assert.equal(res.status, 502);
		assert.deepEqual(await res.json(), { error: 'upstream error' });
		assert.equal(audit[0].outcome, 'apex_error');
		assert.ok(!('unread' in audit[0].detail));
	});

	it('the happy path answers the new blocks AND the document’s new version', async () => {
		const { res, calls } = await saveBody({ stored: {} }, [
			...KEEP,
			{ id: null, kind: 'rich_text', html: '<p>new</p>' }
		]);
		assert.equal(res.status, 200);
		const body = await res.json();
		assert.equal(body.ok, true);
		assert.equal(body.bodyVersion, await computeBodyVersion(apexBlocks()));
		assert.deepEqual(
			body.blocks.map((block) => block.kind),
			['rich_text', 'quote', 'image']
		);
		assert.equal(calls.filter(([name]) => name === 'updateDocumentBlocks').length, 1);
	});

	// ── The interleaved-save guard ──────────────────────────────────────────────
	it('a block added between the load and the save → 409, NO patch, nothing destroyed', async () => {
		// Tab A loads; tab B adds a divider; A saves a body that does not mention it.
		// Without the check, A's save `_destroy`s B's divider with a 200.
		const withDivider = [
			...apexBlocks(),
			{ id: ID_D, position: 3, blockable_type: DIVIDER, blockable: { id: uuid(4), kind: 'large' } }
		];
		const { res, calls, audit } = await saveBody(
			{ blocks: withDivider, stored: {} },
			KEEP,
			await computeBodyVersion(apexBlocks())
		);
		assert.equal(res.status, 409);
		assert.deepEqual(await res.json(), { error: 'stale' });
		assert.equal(calls.filter(([name]) => name === 'updateDocumentBlocks').length, 0);
		assert.equal(audit[0].outcome, 'rejected');
	});

	it('a block DELETED between the load and the save is refused the same way', async () => {
		const { res, calls } = await saveBody(
			{ blocks: apexBlocks().slice(0, 2), stored: {} },
			KEEP,
			await computeBodyVersion(apexBlocks())
		);
		assert.equal(res.status, 409);
		assert.equal(calls.filter(([name]) => name === 'updateDocumentBlocks').length, 0);
	});

	it('an unchanged document proceeds — the control that keeps the guard from refusing everything', async () => {
		const { res } = await saveBody({ stored: {} }, [
			...KEEP,
			{ id: null, kind: 'divider', dividerKind: 'medium' }
		]);
		assert.equal(res.status, 200);
	});

	// ── Gallery membership ──────────────────────────────────────────────────────
	it('an image block naming an id outside the images gallery → 400, NO patch', async () => {
		for (const stranger of [VIDEO_ITEM, uuid(9)]) {
			const { res, calls, audit } = await saveBody({ stored: {} }, [
				{ id: ID_A, kind: 'rich_text', html: '<p>One.</p>' },
				{ id: ID_B, kind: 'quote', quote: 'Q.', quotedBy: 'W' },
				{ id: ID_C, kind: 'image', galleryItemId: stranger }
			]);
			assert.equal(res.status, 400);
			assert.deepEqual(await res.json(), { error: 'unknown-image' });
			assert.equal(calls.filter(([name]) => name === 'updateDocumentBlocks').length, 0);
			// The audit row NAMES the block; the wire body stays opaque.
			assert.match(audit[0].detail.reason, /blocks\[2\]\.galleryItemId/u);
		}
	});

	it('a NEW image block with a null item is refused by name — null round-trips, it does not create', async () => {
		const { res, calls, audit } = await saveBody({ stored: {} }, [
			...KEEP,
			{ id: null, kind: 'image', galleryItemId: null }
		]);
		assert.equal(res.status, 400);
		assert.deepEqual(await res.json(), { error: 'unknown-image' });
		assert.equal(calls.filter(([name]) => name === 'updateDocumentBlocks').length, 0);
		assert.match(audit[0].detail.reason, /blocks\[3\]\.galleryItemId/u);
	});

	it('an UNREADABLE gallery is 502, never `unknown-image` — and writes nothing', async () => {
		for (const options of [{ galleryStatus: 502 }, { itemsStatus: 500 }]) {
			const { res, calls } = await saveBody({ ...options, stored: {} }, [
				{ id: ID_C, kind: 'image', galleryItemId: IMG2 }
			]);
			assert.equal(res.status, 502);
			assert.deepEqual(await res.json(), { error: 'upstream error' });
			assert.equal(calls.filter(([name]) => name === 'updateDocumentBlocks').length, 0);
		}
	});

	it('a save touching no image block performs NO gallery read; one that does, does', async () => {
		// The counter has a POSITIVE control in the same test, so a permanently-zero
		// count cannot pass.
		const unchanged = await saveBody({ stored: {} }, [
			{ id: ID_A, kind: 'rich_text', html: '<p>edited</p>' },
			{ id: ID_B, kind: 'quote', quote: 'Q.', quotedBy: 'W' },
			{ id: ID_C, kind: 'image', galleryItemId: IMG1 }
		]);
		assert.equal(unchanged.res.status, 200);
		assert.equal(unchanged.calls.filter(([name]) => name === 'readCmsConfig').length, 0);
		assert.equal(unchanged.calls.filter(([name]) => name === 'listGalleryItems').length, 0);

		const changed = await saveBody({ stored: {} }, [
			{ id: ID_A, kind: 'rich_text', html: '<p>One.</p>' },
			{ id: ID_B, kind: 'quote', quote: 'Q.', quotedBy: 'W' },
			{ id: ID_C, kind: 'image', galleryItemId: IMG2 }
		]);
		assert.equal(changed.res.status, 200);
		assert.equal(changed.calls.filter(([name]) => name === 'readCmsConfig').length, 1, 'ONCE');
		assert.equal(changed.calls.filter(([name]) => name === 'listGalleryItems').length, 1);
	});

	it('the gallery is read ONCE for a body full of new image blocks, not once per block', async () => {
		const { res, calls } = await saveBody({ stored: {} }, [
			...KEEP,
			{ id: null, kind: 'image', galleryItemId: IMG2 },
			{ id: null, kind: 'image', galleryItemId: IMG2 },
			{ id: null, kind: 'image', galleryItemId: IMG1 }
		]);
		assert.equal(res.status, 200);
		assert.equal(calls.filter(([name]) => name === 'listGalleryItems').length, 1);
	});
});

describe('get-post — an unreadable document is 502, a missing post is 404', () => {
	it('the load: 404 for no view, 502 for a document that will not read, never a 200', async () => {
		const calls = [];
		const missing = ctxWith(calls, {});
		const session = await signIn(missing);
		assert.equal(
			(
				await handleGetPost(
					request(`/api/admin/posts/update/${POST}`, 'GET', undefined, session),
					missing,
					{ schema: 'update', postId: POST }
				)
			).status,
			404
		);

		// The third case is a 2xx the client could not PARSE. It is the dangerous one:
		// a 500 or a throw is visibly a failure, but an unparsed 200 used to reduce to
		// `[]` and answer 200 with an EMPTY BODY and `hash([])`. The editor would open a
		// post that has paragraphs, see "no body yet", retype it, and save — both sides
		// agreeing on `hash([])`, so the diff emitted only creates and destroyed nothing.
		// The document would then hold the old body underneath the new one.
		for (const options of [
			{ documentStatus: 500 },
			{ documentStatus: 'throw' },
			{ documentShapeFault: true }
		]) {
			const ctx = ctxWith([], options);
			const s = await signIn(ctx);
			const res = await handleGetPost(
				request(`/api/admin/posts/story/${POST}`, 'GET', undefined, s),
				ctx,
				{ schema: 'story', postId: POST }
			);
			assert.equal(res.status, 502, JSON.stringify(options));
			assert.deepEqual(await res.json(), { error: 'upstream error' });
		}
	});

	it('the load carries the document’s own version beside the composite one', async () => {
		const ctx = ctxWith([], {});
		const session = await signIn(ctx);
		const res = await handleGetPost(
			request(`/api/admin/posts/story/${POST}`, 'GET', undefined, session),
			ctx,
			{ schema: 'story', postId: POST }
		);
		const body = await res.json();
		assert.equal(body.bodyVersion, await computeBodyVersion(apexBlocks()));
		assert.ok(body.version && body.version !== body.bodyVersion);
	});

	it('the version read: 502 for an unreadable document — not a token that agrees with `[]`', async () => {
		// Hashing an empty read produced a token the NEXT save then agreed with, so the
		// stale check passed and the body was diffed against nothing.
		for (const options of [{ documentStatus: 500 }, { documentShapeFault: true }]) {
			const ctx = ctxWith([], options);
			const session = await signIn(ctx);
			const res = await handleReadPostVersion(
				request(`/api/admin/posts/story/${POST}/version`, 'GET', undefined, session),
				ctx,
				{ schema: 'story', postId: POST }
			);
			assert.equal(res.status, 502, JSON.stringify(options));
		}
	});
});

describe('the cover is checked against the images gallery before it is written', () => {
	async function setCover(coverId, options = {}) {
		const calls = [];
		const db = await createMigratedDatabase();
		const ctx = ctxWith(
			calls,
			{
				view: { shared_gallery_items: [{ id: uuid(4), gallery_item_id: IMG1, kind: 'cover' }] },
				...options
			},
			db
		);
		const session = await signIn(ctx);
		const res = await handleUpdatePost(
			request(`/api/admin/posts/story/${POST}`, 'PATCH', { coverId }, session),
			ctx,
			{ schema: 'story', postId: POST }
		);
		const { results } = await db.prepare('SELECT outcome, detail FROM bff_audit_log').bind().all();
		db.close();
		return { res, calls, audit: results };
	}

	it('a WRONG-GALLERY item and a random uuid are both `400 unknown-image`, with no PATCH', async () => {
		// `Cms::SharedGalleryItem` is five lines with no gallery scoping, so a videos
		// item validates and becomes the cover with a 200 — a cover with no image in it.
		for (const stranger of [VIDEO_ITEM, uuid(9)]) {
			const { res, calls, audit } = await setCover(stranger);
			assert.equal(res.status, 400);
			assert.deepEqual(await res.json(), { error: 'unknown-image' });
			assert.equal(calls.filter(([name]) => name === 'updatePostFields').length, 0);
			assert.equal(audit[0].outcome, 'rejected');
			assert.match(JSON.parse(audit[0].detail).reason, /coverId/u);
		}
	});

	it('an unreadable gallery is 502 with no PATCH — unreadable is not absent', async () => {
		const { res, calls } = await setCover(IMG2, { galleryStatus: 500 });
		assert.equal(res.status, 502);
		assert.deepEqual(await res.json(), { error: 'upstream error' });
		assert.equal(calls.filter(([name]) => name === 'updatePostFields').length, 0);
	});

	it('the controls: a member is written, and the SAME cover costs no gallery read', async () => {
		const good = await setCover(IMG2);
		assert.equal(good.res.status, 200);
		assert.deepEqual(good.calls.find(([name]) => name === 'updatePostFields')[2], {
			shared_gallery_items_attributes: [{ id: uuid(4), gallery_item_id: IMG2, kind: 'cover' }]
		});

		const same = await setCover(IMG1);
		assert.equal(same.res.status, 200);
		assert.equal(same.calls.filter(([name]) => name === 'readCmsConfig').length, 0);

		const cleared = await setCover(null);
		assert.equal(cleared.res.status, 200);
		assert.equal(cleared.calls.filter(([name]) => name === 'readCmsConfig').length, 0);
		assert.deepEqual(cleared.calls.find(([name]) => name === 'updatePostFields')[2], {
			shared_gallery_items_attributes: [{ id: uuid(4), _destroy: true }]
		});
	});

	it('the race Apex still owns: a member deleted between the check and the write is `422 invalid`', async () => {
		// The membership check is a read, and the write that follows is not atomic with
		// it. The 422 path is therefore reachable — for this one window and no other.
		const calls = [];
		const ctx = ctxWith(calls, {
			view: { shared_gallery_items: [] },
			updatePostFieldsStatus: 422
		});
		const session = await signIn(ctx);
		const res = await handleUpdatePost(
			request(`/api/admin/posts/story/${POST}`, 'PATCH', { coverId: IMG2 }, session),
			ctx,
			{ schema: 'story', postId: POST }
		);
		assert.equal(res.status, 422);
		const body = await res.json();
		assert.equal(body.code, 'invalid');
		assert.deepEqual(body.errors, [
			{ attribute: 'shared_gallery_items.gallery_item', messages: ['must exist'] }
		]);
	});
});

describe('a published date must name a day that exists', () => {
	it('the calendar judge', () => {
		assert.ok(isCalendarDate(''));
		assert.ok(isCalendarDate('2026-02-28'));
		assert.ok(isCalendarDate('2024-02-29'), 'a leap day');
		assert.ok(!isCalendarDate('2026-02-29'), 'and not in a common year');
		assert.ok(!isCalendarDate('2026-13-45'));
		assert.ok(!isCalendarDate('2026-02-30'));
		assert.ok(!isCalendarDate('2026-00-10'));
		assert.ok(!isCalendarDate('2026-04-31'));
	});

	it('both write schemas refuse it, and Apex is never asked', async () => {
		for (const bad of ['2026-13-45', '2026-02-30', 'not-a-date']) {
			assert.ok(!updatePostBodySchema.safeParse({ publishedDate: bad }).success, bad);
			assert.ok(
				!createPostBodySchema(contract, 'story').safeParse({
					title: 'T',
					slug: 't',
					publishedDate: bad
				}).success,
				bad
			);
		}
		assert.ok(updatePostBodySchema.safeParse({ publishedDate: '2026-02-28' }).success);
		assert.ok(updatePostBodySchema.safeParse({ publishedDate: '' }).success, 'the clear');

		// …and through the route: `400 invalid body`, nothing written.
		const calls = [];
		const ctx = ctxWith(calls, {});
		const session = await signIn(ctx);
		const res = await handleUpdatePost(
			request(`/api/admin/posts/story/${POST}`, 'PATCH', { publishedDate: '2026-13-45' }, session),
			ctx,
			{ schema: 'story', postId: POST }
		);
		assert.equal(res.status, 400);
		assert.deepEqual(await res.json(), { error: 'invalid body' });
		assert.equal(calls.filter(([name]) => name === 'updatePostFields').length, 0);
	});
});
