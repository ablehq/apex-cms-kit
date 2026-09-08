// @ts-nocheck — node:test suite over dynamic JSON shapes; behavior is the contract.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { handlePatchEntityFields } from '../src/server/bff/operations/patch-entity-fields.ts';
import { handleCreateRecord } from '../src/server/bff/operations/create-record.ts';
import { handleUpdateRecord } from '../src/server/bff/operations/update-record.ts';
import { handleUpdatePostArchetype } from '../src/server/bff/operations/update-post-archetype.ts';
import { handleCreatePost } from '../src/server/bff/operations/create-post.ts';
import { handleSavePostBody } from '../src/server/bff/operations/save-post-body.ts';
import { MAX_FIELD_VALUE_CHARS } from '../src/sanitize/write-boundary.ts';
import { createSessionSecret, sessionIdFor } from '../src/server/bff/session.ts';
import { parseAllowedOrigins } from '../src/server/bff/boundary.ts';
import { createMemorySessionStore } from './harness/session-store.ts';
import { createMigratedDatabase } from './harness/d1.ts';

/**
 * P4a: THE WRITE BOUNDARY AT THE OPERATIONS, not at the sanitizer.
 *
 * `sanitize-write-boundary.test.js` proves what the sanitizer DOES to a value.
 * This file proves that the value Apex is handed has been through it — which is a
 * different claim, and the one that was false: `patch-entity-fields.ts` forwarded
 * `fields_data` verbatim, and every block field on every site on the kit went to
 * Apex as authored. A `{@html}` sink reads those values on the public site.
 *
 * So every assertion here is on THE STORED VALUE the Apex double received, never on
 * the response code. A 200 over an unsanitized store is exactly the failure.
 *
 * It also proves the two mechanics that had no kit home at all:
 *
 *   - the 200 000-character per-field ceiling, on all four write paths. Poovayya
 *     carried it alone (`records.ts:349`); the kit had no `.max` and no body cap, so
 *     a single authenticated POST could push an unbounded value into Apex, into the
 *     published snapshot and into every render of the field;
 *   - `rejectGuardFailure` on the guard-failure exit, so an UNAUTHENTICATED request
 *     does not buy one D1 INSERT per attempt. The function existed in the kit and
 *     was called by nothing but GLC's four ingest operations; every record, entity,
 *     post, page and media operation took `rejectMutation` and wrote a row.
 */

const ORIGIN = 'https://site.test';
const CSRF = 'csrf-write-boundary';
const RECORD_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const TYPE_ID = '5c9f0a21-1b2c-4d3e-8f40-a1b2c3d4e5f6';
const ENTITY_ID = '8f14e45f-ceea-467a-9a3c-3f1a7c9d2b55';
const POST_ID = '7d1a2b3c-4e5f-4061-8172-9a8b7c6d5e4f';
const ARCHETYPE_ID = '1b2c3d4e-5f60-4718-a293-b4c5d6e7f809';
const DOCUMENT_ID = '2c3d4e5f-6071-4829-b3a4-c5d6e7f80912';

function fieldDef(field_name, validator_kind) {
	return {
		field_name,
		display_name: field_name,
		validator_kind,
		text_inclusion: null,
		is_required: false,
		place_holder: null,
		default_value: null
	};
}

const TEAM_MEMBER_FIELDS = [fieldDef('name', null), fieldDef('biography', 'rich_text')];
const ARTICLE_FIELDS = [fieldDef('kind', null), fieldDef('standfirst', 'rich_text')];

const contract = {
	schema: (slug) =>
		slug === 'team_member' || slug === 'article'
			? {
					slug,
					display_name: slug,
					target_model: slug === 'article' ? 'Cms::Post' : null,
					id: null,
					items: []
				}
			: null,
	isContentLibrarySlug: (slug) => slug === 'team_member',
	primitiveFieldDefs: (slug) => {
		if (slug === 'team_member') return TEAM_MEMBER_FIELDS;
		if (slug === 'article') return ARTICLE_FIELDS;
		return [];
	},
	referenceItems: () => [],
	referrersTo: () => ({ countable: [], uncounted: [] })
};

/**
 * An Apex that REMEMBERS what it was handed.
 *
 * `stored` is the assertion surface for this whole file: whatever the operation
 * decided to send, byte for byte. Nothing here rewrites a value, so a sanitizer that
 * stopped running shows up as script in `stored` rather than as a thrown error the
 * double invented.
 */
function recordingApex() {
	const stored = {
		entityFields: null,
		flat: null,
		created: null,
		postFlat: null,
		postCreated: null,
		documentBlocks: null
	};
	const record = () => ({
		id: RECORD_ID,
		updated_at: '2026-09-08T00:00:00Z',
		position: 1,
		primitives: { name: 'Asha', biography: { html: '<p>bio</p>' } },
		archetype_items: [
			{
				id: '44444444-4444-4444-8444-444444444444',
				relatable_type: 'PropertySet',
				archetype_schema_item: { name: 'name', slug: 'name' },
				fields_data: { name: 'Asha' }
			},
			{
				id: '55555555-5555-4555-8555-555555555555',
				relatable_type: 'PropertySet',
				archetype_schema_item: { name: 'biography', slug: 'biography' },
				fields_data: { biography: { html: '<p>bio</p>' } }
			}
		]
	});
	return {
		stored,
		async updateEntityFields(entityTypeId, entityId, fieldsData) {
			stored.entityFields = { entityTypeId, entityId, fieldsData };
			return { status: 200, ok: true, body: { data: {} } };
		},
		async getContentLibraryRecord() {
			return { status: 200, ok: true, body: { data: record() } };
		},
		async updateContentLibraryRecord(slug, id, fields) {
			stored.flat = { slug, id, fields };
			return { status: 200, ok: true, body: { data: record() } };
		},
		async createContentLibraryRecord(slug, fields) {
			stored.created = { slug, fields };
			return { status: 201, ok: true, body: { data: { id: RECORD_ID } } };
		},
		async listPosts() {
			return {
				status: 200,
				ok: true,
				body: {
					data: [
						{
							id: POST_ID,
							post_id: POST_ID,
							archetype_id: ARCHETYPE_ID,
							status: 'draft',
							title: 'A story',
							updated_at: '2026-09-08T00:00:00Z',
							document: { id: DOCUMENT_ID },
							primitives: { kind: 'news' },
							archetype_items: []
						}
					],
					pagination: { total_pages: 1 }
				}
			};
		},
		async createPost(slug, attributes, fields) {
			stored.postCreated = { slug, attributes, fields };
			return {
				status: 201,
				ok: true,
				body: { data: { id: ARCHETYPE_ID, target_model_id: POST_ID } }
			};
		},
		async updateDocumentBlocks(documentId, attributes) {
			stored.documentBlocks = { documentId, attributes };
			return { status: 200, ok: true, body: { data: {} } };
		},
		async updatePostArchetype(slug, archetypeId, fields) {
			stored.postFlat = { slug, archetypeId, fields };
			return { status: 200, ok: true, body: { data: {} } };
		},
		async getPostArchetype() {
			return {
				status: 200,
				ok: true,
				body: {
					data: {
						id: ARCHETYPE_ID,
						updated_at: '2026-09-08T00:00:00Z',
						primitives: { kind: 'news' },
						archetype_items: []
					}
				}
			};
		},
		async readDocument() {
			return { status: 200, ok: true, body: { data: { id: POST_ID, blocks: [] } } };
		},
		async getDocument() {
			return { status: 200, ok: true, body: { data: { id: POST_ID, blocks: [] } } };
		},
		async listContentLibrary() {
			return { status: 200, ok: true, body: { data: [], pagination: { total_pages: 1 } } };
		},
		async listPostArchetypes() {
			return { status: 200, ok: true, body: { data: [], pagination: { total_pages: 1 } } };
		}
	};
}

function ctxWith(apex, db) {
	return {
		allowedOrigins: parseAllowedOrigins(ORIGIN),
		sessions: createMemorySessionStore(),
		...(db ? { db } : {}),
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
		createApexClient: () => apex,
		contract,
		reviewOnlyFields: []
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

function signedRequest(session, path, body, method = 'PATCH') {
	return new Request(`${ORIGIN}${path}`, {
		method,
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

/** PATCH one entity's `fields_data`, signed in. */
async function patchEntity(ctx, fieldsData) {
	const session = await signIn(ctx);
	return handlePatchEntityFields(
		signedRequest(session, `/api/admin/entities/${TYPE_ID}/${ENTITY_ID}`, {
			fields_data: fieldsData
		}),
		ctx,
		{ entityTypeId: TYPE_ID, entityId: ENTITY_ID }
	);
}

async function updateRecord(ctx, body) {
	const session = await signIn(ctx);
	return handleUpdateRecord(
		signedRequest(session, `/api/admin/records/team_member/${RECORD_ID}`, body),
		ctx,
		{ schema: 'team_member', recordId: RECORD_ID }
	);
}

async function createRecord(ctx, body) {
	const session = await signIn(ctx);
	return handleCreateRecord(
		signedRequest(session, '/api/admin/records/team_member', body, 'POST'),
		ctx,
		{ schema: 'team_member' }
	);
}

async function createPost(ctx, body) {
	const session = await signIn(ctx);
	return handleCreatePost(signedRequest(session, '/api/admin/posts/article', body, 'POST'), ctx, {
		schema: 'article'
	});
}

async function savePostBody(ctx, body) {
	const session = await signIn(ctx);
	return handleSavePostBody(
		signedRequest(session, `/api/admin/posts/article/${POST_ID}/body`, body, 'PUT'),
		ctx,
		{ schema: 'article', postId: POST_ID }
	);
}

async function updatePostArchetype(ctx, body) {
	const session = await signIn(ctx);
	return handleUpdatePostArchetype(
		signedRequest(session, `/api/admin/posts/article/${POST_ID}/archetype`, body, 'PUT'),
		ctx,
		{ schema: 'article', postId: POST_ID }
	);
}

describe('patch-entity-fields sanitizes what it stores', () => {
	/**
	 * The corpus is the one §3.6.1 names, because these are the shapes a block field
	 * actually holds: a rich-text object, a bare HTML string, and a list of either.
	 * Each case asserts the STORED value, so "the response was 200" proves nothing.
	 */
	it('strips a bare <script> element out of a rich-text value', async () => {
		const apex = recordingApex();
		const ctx = ctxWith(apex);
		const response = await patchEntity(ctx, {
			headline: { editor: 'quilljs', html: '<p>hi</p><script>alert(1)</script>', content: {} }
		});
		assert.equal(response.status, 200);
		assert.deepEqual(apex.stored.entityFields.fieldsData, {
			headline: { editor: 'quilljs', html: '<p>hi</p>', content: {} }
		});
	});

	it('drops a javascript: href, spelled plainly and entity-encoded', async () => {
		const apex = recordingApex();
		const ctx = ctxWith(apex);
		await patchEntity(ctx, {
			plain: '<a href="javascript:alert(1)">x</a>',
			encoded: '<a href="&#106;avascript:alert(1)">x</a>',
			colon_entity: '<a href="javascript&colon;alert(1)">x</a>'
		});
		assert.deepEqual(apex.stored.entityFields.fieldsData, {
			plain: '<a>x</a>',
			encoded: '<a>x</a>',
			colon_entity: '<a>x</a>'
		});
	});

	it('drops an inline onerror= handler and keeps the safe src', async () => {
		const apex = recordingApex();
		const ctx = ctxWith(apex);
		await patchEntity(ctx, { image: '<img src="/a.png" onerror="alert(1)">' });
		assert.deepEqual(apex.stored.entityFields.fieldsData, { image: '<img src="/a.png">' });
	});

	it('reaches a NESTED {html} object, not only a top-level one', async () => {
		// The case that decided which of the two sanitizers survived the merge: the
		// kit's looked at `value.html` and nothing else, so this came back untouched.
		const apex = recordingApex();
		const ctx = ctxWith(apex);
		await patchEntity(ctx, {
			body: {
				editor: 'quilljs',
				html: '<p>ok</p>',
				content: { blocks: [{ html: '<script>alert(1)</script>' }] }
			}
		});
		assert.deepEqual(apex.stored.entityFields.fieldsData, {
			body: { editor: 'quilljs', html: '<p>ok</p>', content: { blocks: [{ html: '' }] } }
		});
	});

	it('walks an array of objects', async () => {
		const apex = recordingApex();
		const ctx = ctxWith(apex);
		await patchEntity(ctx, {
			cards: [
				{ title: 'a', body: { html: '<a href="javascript:alert(1)">x</a>' } },
				{ title: 'b', body: { html: '<p>fine</p>' } }
			]
		});
		assert.deepEqual(apex.stored.entityFields.fieldsData, {
			cards: [
				{ title: 'a', body: { html: '<a>x</a>' } },
				{ title: 'b', body: { html: '<p>fine</p>' } }
			]
		});
	});

	it('accepts the entity TYPE as a slug as well as a uuid, and refuses anything else', async () => {
		// Apex resolves `:entity_type_id` by id OR slug
		// (`content_library/entities_controller.rb:10-11`), and Poovayya's `array_ref`
		// validator names the child type by slug with no uuid anywhere in its committed
		// contract. A uuid-only check made this operation unreachable from that site.
		const apex = recordingApex();
		const ctx = ctxWith(apex);
		const session = await signIn(ctx);
		const bySlug = await handlePatchEntityFields(
			signedRequest(session, `/api/admin/entities/quote-item/${ENTITY_ID}`, {
				fields_data: { quote: '<script>alert(1)</script>' }
			}),
			ctx,
			{ entityTypeId: 'quote-item', entityId: ENTITY_ID }
		);
		assert.equal(bySlug.status, 200);
		assert.equal(apex.stored.entityFields.entityTypeId, 'quote-item');
		assert.deepEqual(apex.stored.entityFields.fieldsData, { quote: '' });

		// Still a closed shape. A separator, a dot segment or an encoded one is a 400
		// before anything is sent.
		const refused = recordingApex();
		const refusedCtx = ctxWith(refused);
		for (const bad of ['../secrets', 'a/b', '%2e%2e', '.', 'a b']) {
			const response = await handlePatchEntityFields(
				signedRequest(await signIn(refusedCtx), `/api/admin/entities/x/${ENTITY_ID}`, {
					fields_data: { quote: 'x' }
				}),
				refusedCtx,
				{ entityTypeId: bad, entityId: ENTITY_ID }
			);
			assert.equal(response.status, 400, bad);
		}
		assert.equal(refused.stored.entityFields, null);
	});

	/**
	 * THE ROUTE AND THE CLIENT AGREE ABOUT WHAT AN ENTITY TYPE IS.
	 *
	 * This route spelled its own `/^[0-9a-z][0-9a-z-]*$/iu` while
	 * `assertEntityTypeRef` uses `/u`. Under `iu` unicode case folding puts U+212A
	 * (KELVIN SIGN) and U+017F (LATIN SMALL LETTER LONG S) inside `[a-z]`, and `i`
	 * admits plain uppercase — so all three passed route validation and were then
	 * refused by a THROW inside the client. A throw out of an operation is a framework
	 * 500 with no audit row, in place of this route's own audited 400 (codex's P5 fix
	 * review, 2026-09-08).
	 *
	 * MUTATION: put the `i` back on `entityTypeRef` in `patch-entity-fields.ts` — the
	 * three cases below stop being 400s.
	 */
	it('refuses a case-folded or uppercase entity type HERE, not by throwing in the client', async () => {
		const apex = recordingApex();
		const ctx = ctxWith(apex);
		// Escapes, not literals: U+212A and U+017F are invisible in a diff.
		for (const bad of ['\u212a', 'quote-\u017fitem', 'Quote-Item']) {
			const response = await handlePatchEntityFields(
				signedRequest(await signIn(ctx), `/api/admin/entities/x/${ENTITY_ID}`, {
					fields_data: { quote: 'x' }
				}),
				ctx,
				{ entityTypeId: bad, entityId: ENTITY_ID }
			);
			assert.equal(response.status, 400, JSON.stringify(bad));
			assert.equal((await response.json()).error, 'invalid id');
		}
		assert.equal(apex.stored.entityFields, null, 'and nothing was sent upstream');
	});

	it('stores none of the EIGHT payloads the P4 review proved reached Apex verbatim', async () => {
		/**
		 * Every one of these was sent through this operation against the recording
		 * stub during the P4 review and arrived UNCHANGED. Three were a REGRESSION
		 * the kit/Poovayya sanitizer merge introduced — the old
		 * `sanitize-rich-text.ts` stripped every character reference before judging a
		 * URL, so `&Tab;` and an over-long numeric reference had nowhere to hide.
		 * The other five were live in both.
		 *
		 * The assertion is on the STORED value, not the status: a 200 over an
		 * unsanitized store is exactly the failure this file exists to catch.
		 *
		 * TWO OF THE EIGHT MOVED (Opus O5). The over-long numeric references are the
		 * two the write judge cannot READ rather than the six it can read and refuse,
		 * and a value it cannot read is now a typed 400 naming the field rather than a
		 * silent strip — see the test below, which is strictly stronger than this one
		 * (nothing is stored at all, not even a sanitized version).
		 */
		const apex = recordingApex();
		const ctx = ctxWith(apex);
		await patchEntity(ctx, {
			// (a) `&Tab;` — the real entity. The local table spelled it `tab`.
			named_tab: '<a href="java&Tab;script:alert(1)">x</a>',
			// (c) a handler with no whitespace before it — a slash, a quote, a slash.
			svg_onload: '<svg/onload=alert(1)></svg>',
			img_onerror: '<img src="x"onerror=alert(1)>',
			anchor_onclick: '<a href="/x"/onclick=alert(1)>y</a>',
			// (d) a URL sink that is not `href`, and an SVG animation that needs no
			// handler and no href on the element the allowlist was watching.
			form_action: '<button formaction="javascript:alert(1)">go</button>',
			svg_animate: '<svg><animate attributeName="href" values="javascript:alert(1)"/></svg>'
		});
		assert.deepEqual(apex.stored.entityFields.fieldsData, {
			named_tab: '<a>x</a>',
			svg_onload: '',
			img_onerror: '<img src="x">',
			anchor_onclick: '<a href="/x"/>y</a>',
			form_action: '',
			svg_animate: ''
		});
		// And the blunt cross-check: nothing executable survives anywhere in the store.
		const serialized = JSON.stringify(apex.stored.entityFields.fieldsData);
		assert.doesNotMatch(serialized, /javascript/iu);
		assert.doesNotMatch(serialized, /on(?:load|error|click)\s*=/iu);
		assert.doesNotMatch(serialized, /<(?:svg|button|animate)/iu);
	});

	it('REFUSES BY NAME the two payloads whose URL the judge cannot read', async () => {
		/**
		 * OPUS O5, and the other two of the eight. `&#00000000106;avascript:` and
		 * `&#x0000006A;avascript:` are longer than `decodeReferences`'s 7-decimal and
		 * 6-hex windows; a browser has no window, so both ARE `javascript:` to it. The
		 * write boundary fails closed on a reference that survives decoding — right —
		 * but it did so by SILENTLY DROPPING the attribute, which is how an editor
		 * saves a link, gets a 200, and finds the link gone with no explanation.
		 *
		 * Now the whole write is refused, 400 `unreadable-url`, with the field named.
		 * Strictly stronger than the strip: NOTHING is stored, and the person who typed
		 * it is told which field to look at.
		 *
		 * The known false positives — a double-encoded `&amp;amp;`, a `?a=1&#2024` — are
		 * refusals of something harmless, which is the correct direction for a
		 * fail-closed rule and the reason it must not be silent.
		 */
		const apex = recordingApex();
		const db = await createMigratedDatabase();
		try {
			const ctx = ctxWith(apex, db);
			const response = await patchEntity(ctx, {
				long_decimal: '<a href="&#00000000106;avascript:alert(1)">x</a>',
				long_hex: '<a href="&#x0000006A;avascript:alert(1)">x</a>',
				untouched: '<p>ok</p>'
			});
			assert.equal(response.status, 400);
			assert.equal(apex.stored.entityFields, null, 'the write never reached Apex');

			// The audit row names both fields, so the refusal is answerable.
			const { results } = await db
				.prepare("SELECT outcome, detail FROM bff_audit_log WHERE outcome = 'rejected'")
				.bind()
				.all();
			const detail = `${results.at(-1)?.detail ?? ''}`;
			assert.match(detail, /unreadable-url|long_decimal/u);
			assert.match(detail, /long_decimal/u);
			assert.match(detail, /long_hex/u);
			assert.doesNotMatch(detail, /untouched/u);
		} finally {
			db.close();
		}
	});

	it('a plain ampersand in a query string is not mistaken for a reference', async () => {
		// The bound on the rule above: `&b=` is what every second URL looks like, and
		// refusing it would make the boundary unusable. Only a TERMINATED reference —
		// `&name;`, `&#…`, `&#x…` — is refused.
		const apex = recordingApex();
		const ctx = ctxWith(apex);
		await patchEntity(ctx, { body: '<a href="/search?a=1&b=2">x</a>', name: 'Ravi & Co' });
		assert.deepEqual(apex.stored.entityFields.fieldsData, {
			body: '<a href="/search?a=1&b=2">x</a>',
			name: 'Ravi & Co'
		});
	});

	it('leaves an ordinary value exactly as it arrived', async () => {
		const apex = recordingApex();
		const ctx = ctxWith(apex);
		await patchEntity(ctx, { name: 'Ravi & Co', count: 3, live: true, cleared: '' });
		assert.deepEqual(apex.stored.entityFields.fieldsData, {
			name: 'Ravi & Co',
			count: 3,
			live: true,
			cleared: ''
		});
	});
});

describe('the record write paths sanitize too — the same sanitizer, one place', () => {
	it('update-record strips script out of a rich-text field', async () => {
		const apex = recordingApex();
		const ctx = ctxWith(apex);
		await updateRecord(ctx, {
			fields: { biography: { editor: 'quilljs', html: '<p>a</p><script>alert(1)</script>' } }
		});
		assert.deepEqual(apex.stored.flat.fields, {
			biography: { editor: 'quilljs', html: '<p>a</p>' }
		});
	});

	it('create-record strips script out of a rich-text field', async () => {
		const apex = recordingApex();
		const ctx = ctxWith(apex);
		await createRecord(ctx, { fields: { name: '<a href="javascript:alert(1)">x</a>' } });
		assert.deepEqual(apex.stored.created.fields, { name: '<a>x</a>' });
	});

	it('update-post-archetype strips script out of a rich-text field', async () => {
		const apex = recordingApex();
		const ctx = ctxWith(apex);
		await updatePostArchetype(ctx, {
			fields: { standfirst: { editor: 'quilljs', html: '<iframe src="/x"></iframe>ok' } }
		});
		assert.deepEqual(apex.stored.postFlat.fields, {
			standfirst: { editor: 'quilljs', html: 'ok' }
		});
	});
});

describe('the per-field ceiling, on every write path', () => {
	const atCeiling = 'x'.repeat(MAX_FIELD_VALUE_CHARS);
	const overCeiling = 'x'.repeat(MAX_FIELD_VALUE_CHARS + 1);

	it('is the same number everywhere', () => {
		assert.equal(MAX_FIELD_VALUE_CHARS, 200_000);
	});

	it('patch-entity-fields: 200 000 passes, 200 001 is a typed 400 and never reaches Apex', async () => {
		const pass = recordingApex();
		assert.equal((await patchEntity(ctxWith(pass), { note: atCeiling })).status, 200);
		assert.equal(pass.stored.entityFields.fieldsData.note.length, MAX_FIELD_VALUE_CHARS);

		const refuse = recordingApex();
		const response = await patchEntity(ctxWith(refuse), { note: overCeiling });
		assert.equal(response.status, 400);
		assert.equal((await response.json()).error, 'field-too-large');
		assert.equal(refuse.stored.entityFields, null, 'nothing was sent upstream');
	});

	it('update-record: 200 000 passes, 200 001 is a typed 400 and never reaches Apex', async () => {
		const pass = recordingApex();
		assert.equal((await updateRecord(ctxWith(pass), { fields: { name: atCeiling } })).status, 200);
		assert.equal(pass.stored.flat.fields.name.length, MAX_FIELD_VALUE_CHARS);

		const refuse = recordingApex();
		const response = await updateRecord(ctxWith(refuse), { fields: { name: overCeiling } });
		assert.equal(response.status, 400);
		assert.equal((await response.json()).error, 'field-too-large');
		assert.equal(refuse.stored.flat, null, 'nothing was sent upstream');
	});

	it('create-record: 200 000 passes, 200 001 is a typed 400 and never reaches Apex', async () => {
		const pass = recordingApex();
		assert.equal((await createRecord(ctxWith(pass), { fields: { name: atCeiling } })).status, 201);
		assert.equal(pass.stored.created.fields.name.length, MAX_FIELD_VALUE_CHARS);

		const refuse = recordingApex();
		const response = await createRecord(ctxWith(refuse), { fields: { name: overCeiling } });
		assert.equal(response.status, 400);
		assert.equal((await response.json()).error, 'field-too-large');
		assert.equal(refuse.stored.created, null, 'nothing was sent upstream');
	});

	it('update-post-archetype: 200 000 passes, 200 001 is a typed 400 and never reaches Apex', async () => {
		const pass = recordingApex();
		assert.equal(
			(await updatePostArchetype(ctxWith(pass), { fields: { kind: atCeiling } })).status,
			200
		);
		assert.equal(pass.stored.postFlat.fields.kind.length, MAX_FIELD_VALUE_CHARS);

		const refuse = recordingApex();
		const response = await updatePostArchetype(ctxWith(refuse), {
			fields: { kind: overCeiling }
		});
		assert.equal(response.status, 400);
		assert.equal((await response.json()).error, 'field-too-large');
		assert.equal(refuse.stored.postFlat, null, 'nothing was sent upstream');
	});

	it('create-post: 200 000 passes, 200 001 is a typed 400 and never reaches Apex', async () => {
		// P4 review finding 2: this path had NO ceiling. `fields` is `z.unknown()` per
		// primitive (`create-post.ts:59`), so nothing capped it between the null check
		// and `toApexFields` — the only create on the kit that could push an unbounded
		// value into Apex while its three siblings refused it.
		const pass = recordingApex();
		await createPost(ctxWith(pass), {
			title: 'A story',
			slug: 'a-story',
			fields: { kind: atCeiling }
		});
		assert.equal(pass.stored.postCreated.fields.kind.length, MAX_FIELD_VALUE_CHARS);

		const refuse = recordingApex();
		const response = await createPost(ctxWith(refuse), {
			title: 'A story',
			slug: 'a-story',
			fields: { kind: overCeiling }
		});
		assert.equal(response.status, 400);
		assert.equal((await response.json()).error, 'field-too-large');
		assert.equal(refuse.stored.postCreated, null, 'nothing was sent upstream');
	});

	it('save-post-body: an over-long block is `field-too-large` NAMING the block', async () => {
		// The block path always refused — `blockSchema.html` carries the same
		// `.max(MAX_FIELD_VALUE_CHARS)` — but as a generic `invalid body`, which does
		// not tell an editor which of up to two hundred blocks to fix.
		const pass = recordingApex();
		assert.equal(
			(await savePostBody(ctxWith(pass), { blocks: [{ kind: 'rich_text', html: atCeiling }] }))
				.status,
			200
		);

		const refuse = recordingApex();
		const db = await createMigratedDatabase();
		const response = await savePostBody(ctxWith(refuse, db), {
			blocks: [
				{ kind: 'rich_text', html: '<p>fine</p>' },
				{ kind: 'rich_text', html: '<p>also fine</p>' },
				{ kind: 'rich_text', html: overCeiling }
			]
		});
		assert.equal(response.status, 400);
		assert.equal((await response.json()).error, 'field-too-large');
		assert.equal(refuse.stored.documentBlocks, null, 'nothing was sent upstream');
		// The name is carried where every other ceiling refusal carries it: the audit
		// row's `reason`. The wire body stays opaque (`bffError`).
		const { results } = await db.prepare('SELECT outcome, detail FROM bff_audit_log').bind().all();
		assert.equal(results.length, 1);
		assert.equal(results[0].outcome, 'rejected');
		assert.match(JSON.parse(results[0].detail).reason, /blocks\[2\]\.html/u);
		db.close();
	});

	it('a structured value is measured by what actually travels, and the refusal names the field', async () => {
		// A rich-text object is not a string, and `value.length` on one is `undefined`
		// — which compares false against any ceiling. Measuring the JSON is what makes
		// the object case bounded at all.
		const apex = recordingApex();
		const response = await patchEntity(ctxWith(apex), {
			small: 'fine',
			body: { editor: 'quilljs', html: `<p>${overCeiling}</p>` }
		});
		assert.equal(response.status, 400);
		assert.equal(apex.stored.entityFields, null);

		const db = await createMigratedDatabase();
		await patchEntity(ctxWith(recordingApex(), db), {
			small: 'fine',
			body: { editor: 'quilljs', html: `<p>${overCeiling}</p>` }
		});
		const rows = await db
			.prepare('SELECT outcome, detail FROM bff_audit_log')
			.bind()
			.all()
			.then((r) => r.results);
		assert.equal(rows.length, 1);
		assert.equal(rows[0].outcome, 'rejected');
		const detail = JSON.parse(rows[0].detail);
		assert.match(detail.reason, /field too large: body/u, 'the field is NAMED, not just counted');
		assert.doesNotMatch(detail.reason, /small/u, 'and the field that was fine is not');
		db.close();
	});

	it('the ceiling counts characters, not bytes, so a multi-byte value is not penalised', async () => {
		const apex = recordingApex();
		const response = await patchEntity(ctxWith(apex), {
			note: 'é'.repeat(MAX_FIELD_VALUE_CHARS)
		});
		assert.equal(response.status, 200);
		assert.equal(apex.stored.entityFields.fieldsData.note.length, MAX_FIELD_VALUE_CHARS);
	});
});

describe('a failed guard buys no D1 write', () => {
	/**
	 * §3.6 item 8, ported as the FIX rather than the defect. `rejectGuardFailure` was
	 * exported, documented and called by nothing in the kit — every operation took
	 * `rejectMutation` on guard failure, so an unauthenticated caller could drive one
	 * INSERT per request into the audit table, at a rate it chose.
	 *
	 * Both directions matter. Nobody signed in must cost no row; a REAL editor who
	 * fails the boundary must still be audited, or a CSRF failure by a signed-in
	 * session becomes invisible.
	 */
	function unauthenticated(path, method = 'PATCH') {
		return new Request(`${ORIGIN}${path}`, {
			method,
			headers: {
				origin: ORIGIN,
				'sec-fetch-site': 'same-origin',
				'content-type': 'application/json'
			},
			body: JSON.stringify({ fields_data: { note: 'x' } })
		});
	}

	async function auditRows(db) {
		const { results } = await db.prepare('SELECT * FROM bff_audit_log').bind().all();
		return results;
	}

	/** Passes the browser boundary — origin, fetch metadata, matching CSRF — but carries no session. */
	function boundaryCleanNoSession(path, method = 'PATCH') {
		return new Request(`${ORIGIN}${path}`, {
			method,
			headers: {
				origin: ORIGIN,
				'sec-fetch-site': 'same-origin',
				'x-csrf-token': CSRF,
				'content-type': 'application/json',
				cookie: `apex_bff_csrf=${CSRF}`
			},
			body: JSON.stringify({ fields_data: { note: 'x' } })
		});
	}

	it('a request that clears the boundary but has NO session is a 401 with zero audit rows', async () => {
		const db = await createMigratedDatabase();
		const ctx = ctxWith(recordingApex(), db);
		const response = await handlePatchEntityFields(
			boundaryCleanNoSession(`/api/admin/entities/${TYPE_ID}/${ENTITY_ID}`),
			ctx,
			{ entityTypeId: TYPE_ID, entityId: ENTITY_ID }
		);
		assert.equal(response.status, 401);
		assert.deepEqual(await auditRows(db), [], 'a 401 is already proof nobody was signed in');
		db.close();
	});

	it('a cross-origin/CSRF-less PATCH with no session is a 403 with zero audit rows', async () => {
		const db = await createMigratedDatabase();
		const ctx = ctxWith(recordingApex(), db);
		const response = await handlePatchEntityFields(
			unauthenticated(`/api/admin/entities/${TYPE_ID}/${ENTITY_ID}`),
			ctx,
			{ entityTypeId: TYPE_ID, entityId: ENTITY_ID }
		);
		// The boundary runs BEFORE the session, so this is a 403 rather than a 401 —
		// and answering "was anyone actually signed in?" costs one indexed READ, not a
		// write. That is the whole point: the read is bounded, the INSERT was not.
		assert.equal(response.status, 403);
		assert.deepEqual(await auditRows(db), []);
		db.close();
	});

	it('a hundred unauthenticated attempts still cost zero rows', async () => {
		const db = await createMigratedDatabase();
		const ctx = ctxWith(recordingApex(), db);
		for (let i = 0; i < 100; i += 1) {
			await handlePatchEntityFields(
				unauthenticated(`/api/admin/entities/${TYPE_ID}/${ENTITY_ID}`),
				ctx,
				{ entityTypeId: TYPE_ID, entityId: ENTITY_ID }
			);
		}
		assert.deepEqual(await auditRows(db), [], 'write amplification an attacker controls');
		db.close();
	});

	it('an unauthenticated record UPDATE and CREATE cost zero rows either', async () => {
		const db = await createMigratedDatabase();
		const ctx = ctxWith(recordingApex(), db);
		await handleUpdateRecord(unauthenticated(`/api/admin/records/team_member/${RECORD_ID}`), ctx, {
			schema: 'team_member',
			recordId: RECORD_ID
		});
		await handleCreateRecord(unauthenticated('/api/admin/records/team_member', 'POST'), ctx, {
			schema: 'team_member'
		});
		assert.deepEqual(await auditRows(db), []);
		db.close();
	});

	it('a refused request never DELETES an expired session, and never refreshes a token', async () => {
		/**
		 * OPUS O6. `rejectGuardFailure` resolves the session on a non-401 failure to
		 * ATTRIBUTE the audit row — and `resolveSession`'s default does more than
		 * answer: an expired envelope is deleted, and a session near its access-token
		 * cutoff is refreshed against Apex. Both are WRITES (a D1 delete, an upstream
		 * round-trip) bought by a request that has already been refused, on a path the
		 * open internet can reach. And ending somebody's session as a side effect of
		 * refusing one request is the wrong moment for it.
		 *
		 * `{ refresh: false }` answers the question and stops. The two halves are
		 * asserted separately below, because they fail differently.
		 *
		 * MUTATION: drop `{ refresh: false }` from `rejectGuardFailure` — the expired
		 * row is gone from the store, and the refresh stub records a call.
		 */
		const db = await createMigratedDatabase();
		try {
			// (a) AN EXPIRED SESSION IS NOT DELETED.
			const expiredCtx = ctxWith(recordingApex(), db);
			const secret = createSessionSecret();
			const id = await sessionIdFor(secret);
			const past = Date.now() - 10_000;
			await expiredCtx.sessions.create({
				id,
				createdAt: past - 3600_000,
				lastSeenAt: past,
				expiresAt: past,
				staffEmail: 'e@site.test',
				staffId: 'aaaaaaaa-1111-4222-8333-444444444444',
				staffName: 'E',
				accessToken: 't',
				tokenType: 'Bearer',
				accessExpiresAt: past,
				refreshToken: 'r'
			});
			const refusedExpired = await handlePatchEntityFields(
				new Request(`${ORIGIN}/api/admin/entities/${TYPE_ID}/${ENTITY_ID}`, {
					method: 'PATCH',
					headers: {
						origin: ORIGIN,
						'sec-fetch-site': 'same-origin',
						'x-csrf-token': 'not-the-cookie',
						'content-type': 'application/json',
						cookie: `apex_admin_session=${secret}; apex_bff_csrf=${CSRF}`
					},
					body: JSON.stringify({ fields_data: { note: 'x' } })
				}),
				expiredCtx,
				{ entityTypeId: TYPE_ID, entityId: ENTITY_ID }
			);
			assert.equal(refusedExpired.status, 403);
			assert.ok(expiredCtx.sessions.rows.has(id), 'the refused request did not end the session');
			assert.deepEqual(await auditRows(db), [], 'and an expired session attributes nothing');

			// (b) A LIVE SESSION DUE FOR A REFRESH IS NOT REFRESHED — it is only named.
			const refreshes = [];
			const refreshCtx = ctxWith(recordingApex(), db);
			refreshCtx.auth.refreshGrant = async (token) => {
				refreshes.push(token);
				return {
					accessToken: 'new',
					tokenType: 'Bearer',
					refreshToken: 'r2',
					expiresInSec: 3600
				};
			};
			const liveSecret = createSessionSecret();
			const liveId = await sessionIdFor(liveSecret);
			const now = Date.now();
			await refreshCtx.sessions.create({
				id: liveId,
				createdAt: now,
				lastSeenAt: now,
				expiresAt: now + 3600_000,
				staffEmail: 'e@site.test',
				staffId: 'aaaaaaaa-1111-4222-8333-444444444444',
				staffName: 'E',
				accessToken: 't',
				tokenType: 'Bearer',
				// Already past the access-token cutoff, so the default path WOULD refresh.
				accessExpiresAt: now - 1,
				refreshToken: 'r'
			});
			const refusedLive = await handlePatchEntityFields(
				new Request(`${ORIGIN}/api/admin/entities/${TYPE_ID}/${ENTITY_ID}`, {
					method: 'PATCH',
					headers: {
						origin: ORIGIN,
						'sec-fetch-site': 'same-origin',
						'x-csrf-token': 'not-the-cookie',
						'content-type': 'application/json',
						cookie: `apex_admin_session=${liveSecret}; apex_bff_csrf=${CSRF}`
					},
					body: JSON.stringify({ fields_data: { note: 'x' } })
				}),
				refreshCtx,
				{ entityTypeId: TYPE_ID, entityId: ENTITY_ID }
			);
			assert.equal(refusedLive.status, 403);
			assert.deepEqual(refreshes, [], 'a refused request bought no upstream refresh');
			assert.equal(
				refreshCtx.sessions.rows.get(liveId)?.accessToken,
				't',
				'and the stored token is untouched'
			);
			// Attribution still works, which is the whole reason the resolve happens.
			const rows = await auditRows(db);
			assert.equal(rows.length, 1);
			assert.equal(rows[0].actor_email, 'e@site.test');
		} finally {
			db.close();
		}
	});

	it('a REAL session that fails the boundary IS audited, attributed to that editor', async () => {
		const db = await createMigratedDatabase();
		const ctx = ctxWith(recordingApex(), db);
		const session = await signIn(ctx);
		// Signed in, and the CSRF header does not match the cookie: a 403 by a known
		// actor, which is exactly the row an audit log exists to carry.
		const response = await handlePatchEntityFields(
			new Request(`${ORIGIN}/api/admin/entities/${TYPE_ID}/${ENTITY_ID}`, {
				method: 'PATCH',
				headers: {
					origin: ORIGIN,
					'sec-fetch-site': 'same-origin',
					'x-csrf-token': 'not-the-cookie',
					'content-type': 'application/json',
					cookie: `apex_admin_session=${session}; apex_bff_csrf=${CSRF}`
				},
				body: JSON.stringify({ fields_data: { note: 'x' } })
			}),
			ctx,
			{ entityTypeId: TYPE_ID, entityId: ENTITY_ID }
		);
		assert.equal(response.status, 403);
		const rows = await auditRows(db);
		assert.equal(rows.length, 1);
		assert.equal(rows[0].outcome, 'rejected');
		assert.equal(rows[0].actor_email, 'e@site.test');
		db.close();
	});
});

describe('an audited rejection records the route TEMPLATE, never the caller’s path', () => {
	/**
	 * `reject.ts` states the rule — "a route PARAMETER never belongs in `path`; put it
	 * in `detail`, and only once it has been validated" — and `postRouteMeta` was the
	 * only thing following it. Six operations interpolated the raw parameters into
	 * the meta they build BEFORE validating anything, so a refused request wrote an
	 * arbitrary caller-supplied string into the audit table's `path` column, at a rate
	 * the caller chose. Found by Poovayya's P0 gate, which had asserted the template
	 * since before the kit existed.
	 */
	it('a bad entity id is audited against the template, with the ids only in detail', async () => {
		const db = await createMigratedDatabase();
		const ctx = ctxWith(recordingApex(), db);
		const session = await signIn(ctx);
		const injected = 'not-a-uuid-<script>alert(1)</script>';
		const response = await handlePatchEntityFields(
			signedRequest(session, `/api/admin/entities/${TYPE_ID}/x`, { fields_data: { a: 'b' } }),
			ctx,
			{ entityTypeId: TYPE_ID, entityId: injected }
		);
		assert.equal(response.status, 400);

		const { results } = await db.prepare('SELECT * FROM bff_audit_log').bind().all();
		assert.equal(results.length, 1);
		assert.equal(results[0].path, '/api/admin/entities/[entityTypeId]/[entityId]');
		assert.doesNotMatch(results[0].path, /script/u, 'the caller’s string is not in the column');
		db.close();
	});

	it('a bad record id on the update path is audited against the template too', async () => {
		const db = await createMigratedDatabase();
		const ctx = ctxWith(recordingApex(), db);
		const session = await signIn(ctx);
		const response = await handleUpdateRecord(
			signedRequest(session, '/api/admin/records/team_member/x', { fields: { name: 'a' } }),
			ctx,
			{ schema: 'team_member', recordId: '../../etc/passwd' }
		);
		assert.equal(response.status, 400);

		const { results } = await db.prepare('SELECT * FROM bff_audit_log').bind().all();
		assert.equal(results.length, 1);
		assert.equal(results[0].path, '/api/admin/records/[schema]/[recordId]');
		db.close();
	});
});
