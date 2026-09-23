// @ts-nocheck — this suite drives the real guard, Apex envelope, and KV reader.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadPagePreview } from '../src/server/bff/operations/preview-page.ts';
import { projectCmsPage } from '../src/cms/page-data.js';
import { bindReservedRoutes } from '../src/cms/page-slug-validation.js';
import { readContent, resetContentMemo } from '../src/server/content/read.ts';
import { createSessionSecret, sessionIdFor } from '../src/server/bff/session.ts';
import { parseAllowedOrigins } from '../src/server/bff/boundary.ts';
import { createMemorySessionStore } from './harness/session-store.ts';

const ORIGIN = 'https://site.test';
const PAGE_ID = '7a14e45f-ceea-467a-9a3c-3f1a7c9d2b55';
const SAVED_AT = '2026-09-23T10:00:00.000Z';
const SITE_TITLE = 'GLC';
bindReservedRoutes({});
const known = {
	key: 'b0',
	template: 'hero',
	fields: { heading: 'Hello' },
	anchorId: '',
	children: []
};
const unknown = { key: 'b1', template: 'missing', fields: {}, anchorId: '', children: [] };

function block(slug, position) {
	return {
		id: `block-${position}`,
		position,
		blockable_type: 'Cms::PageBlock::TemplateInstance',
		blockable: {
			page_block_template: { slug },
			entity: { fields_data: slug === 'hero' ? { heading: 'Hello' } : {} }
		}
	};
}

function page(changes = {}) {
	return {
		id: PAGE_ID,
		slug: '/about',
		title: 'About',
		status: 'published',
		updated_at: SAVED_AT,
		meta_properties: [],
		blocks: [block('hero', 0)],
		...changes
	};
}

function projected(blocks = [known], changes = {}) {
	return {
		slug: '/about',
		title: 'About',
		meta: { title: 'About', description: '' },
		blocks,
		...changes
	};
}

function harness(raw = page(), pages = [projected()], apexStatus = 200, published = true) {
	resetContentMemo();
	const calls = [];
	const client = {
		async getPage(id) {
			calls.push(['getPage', id]);
			return { ok: apexStatus === 200, status: apexStatus, body: { data: raw } };
		}
	};
	const collections = {
		pages,
		images: [],
		files: [],
		videos: [],
		youtube_videos: [{ id: 'video' }]
	};
	const snapshot = {
		version: 'preview-a1',
		publishedAt: SAVED_AT,
		publishedBy: 'editor',
		accountId: 'a',
		counts: {},
		warnings: [],
		collections
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
		content: {
			async get() {
				return published ? JSON.stringify(snapshot) : null;
			},
			async put() {}
		}
	};
	return { ctx, calls, client };
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
	return new Request(`${ORIGIN}/admin/pages/${PAGE_ID}/preview`, {
		headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin', cookie }
	});
}

function options(messages) {
	return {
		partitionRenderableBlocks(blocks) {
			return {
				renderable: blocks.filter((entry) => entry.template === 'hero'),
				unknownSlugs: blocks
					.filter((entry) => entry.template !== 'hero')
					.map((entry) => entry.template)
			};
		},
		siteTitle: SITE_TITLE,
		...(messages ? { messages } : {})
	};
}

function expected(pageValue, changes = {}) {
	return {
		ok: true,
		preview: {
			pageId: PAGE_ID,
			page: pageValue,
			messages: [],
			unknownTemplates: [],
			status: 'published',
			routable: true,
			publicPath: '/about',
			savedAt: SAVED_AT,
			onSite: 'identical',
			...changes
		}
	};
}

function assertOutput(actual, wanted) {
	assert.deepEqual(actual, wanted);
	assert.equal(JSON.stringify(actual), JSON.stringify(wanted));
}

describe('GLC page preview characterisation', () => {
	/** The preview must keep the whole published payload and comparison from preview-page.ts:152-275. */
	it('reports an identical published page', async () => {
		const { ctx, calls } = harness();
		assertOutput(
			await loadPagePreview(await request(ctx), ctx, { pageId: PAGE_ID }, options()),
			expected(projected())
		);
		assert.deepEqual(calls, [['getPage', PAGE_ID]]);
	});

	/** An older snapshot must be visible as differs; preview-page.ts:227-233 compares projections. */
	it('reports a changed published page', async () => {
		const { ctx } = harness(page(), [projected([], { title: 'Old' })]);
		assert.deepEqual(
			await loadPagePreview(await request(ctx), ctx, { pageId: PAGE_ID }, options()),
			expected(projected(), { onSite: 'differs' })
		);
	});

	/** Drafts still render their last save, while preview-page.ts:219-245 withholds a public path. */
	it('reports a draft', async () => {
		const { ctx } = harness(page({ status: 'draft' }), []);
		assert.deepEqual(
			await loadPagePreview(await request(ctx), ctx, { pageId: PAGE_ID }, options()),
			expected(projected(), {
				status: 'draft',
				routable: false,
				publicPath: null,
				onSite: 'absent'
			})
		);
	});

	/** A missing snapshot row gives absent even when Apex marks the page published; preview-page.ts:227-233. */
	it('reports an absent published page', async () => {
		const { ctx } = harness(page(), []);
		assert.deepEqual(
			await loadPagePreview(await request(ctx), ctx, { pageId: PAGE_ID }, options()),
			expected(projected(), { onSite: 'absent' })
		);
	});

	/** The comparison at preview-page.ts:173 uses unpartitioned blocks; the renderer gets only known ones. */
	it('keeps an unknown block in the comparable and calls messages once with renderable blocks', async () => {
		const raw = page({ blocks: [block('hero', 0), block('missing', 1)] });
		const { ctx } = harness(raw, [projected([known, unknown])]);
		const messageCalls = [];
		const result = await loadPagePreview(
			await request(ctx),
			ctx,
			{ pageId: PAGE_ID },
			options((collections, blocks) => {
				messageCalls.push([collections, blocks]);
				return ['sermon'];
			})
		);
		assertOutput(
			result,
			expected(projected(), { messages: ['sermon'], unknownTemplates: ['missing'] })
		);
		const memo = await readContent(ctx.content);
		assert.equal(messageCalls.length, 1);
		assert.equal(messageCalls[0][0], memo.collections);
		assert.deepEqual(messageCalls[0][1], [known]);
	});

	/** GLC's siteTitle fallback at preview-page.ts:164 must also match published untitled pages. */
	it('keeps the site title fallback in an untitled published comparison', async () => {
		const raw = page({ title: undefined });
		const published = projected([known], {
			title: '',
			meta: { title: SITE_TITLE, description: '' }
		});
		const { ctx } = harness(raw, [published]);
		assert.deepEqual(
			await loadPagePreview(await request(ctx), ctx, { pageId: PAGE_ID }, options()),
			expected(published)
		);
		assert.equal(projectCmsPage(raw, { siteTitle: SITE_TITLE }).meta.title, SITE_TITLE);
	});

	/** The guard in preview-page.ts:195-196 must run before any draft read. */
	it('rejects a signed-out request without calling Apex', async () => {
		const { ctx, calls } = harness();
		assert.deepEqual(
			await loadPagePreview(await request(ctx, false), ctx, { pageId: PAGE_ID }, options()),
			{ ok: false, status: 401, reason: 'unauthorized' }
		);
		assert.deepEqual(calls, []);
	});

	/** Invalid ids and Apex failures must retain the status mapping at preview-page.ts:198-209. */
	it('maps invalid ids and Apex 404/500', async () => {
		const { ctx: invalid, calls } = harness();
		assert.deepEqual(
			await loadPagePreview(await request(invalid), invalid, { pageId: 'bad' }, options()),
			{ ok: false, status: 400, reason: 'invalid page id' }
		);
		assert.deepEqual(calls, []);
		for (const [status, expectedResult] of [
			[404, { ok: false, status: 404, reason: 'no such page' }],
			[500, { ok: false, status: 502, reason: 'upstream error' }]
		]) {
			const { ctx } = harness(page(), [], status);
			assert.deepEqual(
				await loadPagePreview(await request(ctx), ctx, { pageId: PAGE_ID }, options()),
				expectedResult
			);
		}
	});

	/** The content reader's unavailable state at preview-page.ts:211-216 must remain a 503. */
	it('reports an unpublished site snapshot', async () => {
		const { ctx } = harness(page(), [], 200, false);
		assert.deepEqual(
			await loadPagePreview(await request(ctx), ctx, { pageId: PAGE_ID }, options()),
			{ ok: false, status: 503, reason: 'the site has not been published yet' }
		);
	});
});

describe('site page preview adapter contract', () => {
	function adapter(calls, overrides = {}) {
		return {
			routable(raw) {
				calls.push(['routable', raw.slug]);
				return raw.status === 'published';
			},
			publicPath(raw) {
				calls.push(['publicPath', raw.slug]);
				return raw.slug;
			},
			async projectSaved(input) {
				calls.push(['projectSaved', input]);
				return {
					ok: true,
					payload: { title: 'Saved' },
					comparable: { a: 1, b: 2 },
					unknownTemplates: []
				};
			},
			async publishedComparable(input) {
				calls.push(['publishedComparable', input]);
				return { b: 2, a: 1 };
			},
			...overrides
		};
	}

	/** §2.2: a site receives the guarded client and shared snapshot at preview-page.ts:224, never a cloned substitute. */
	it('passes raw, snapshot collections, and the guarded Apex client', async () => {
		const { loadSitePagePreview } = await import('../src/server/bff/operations/preview-page.ts');
		const raw = page();
		const { ctx, calls: apexCalls, client } = harness(raw);
		const calls = [];
		const result = await loadSitePagePreview(
			await request(ctx),
			ctx,
			{ pageId: PAGE_ID },
			adapter(calls)
		);
		assert.deepEqual(result, {
			ok: true,
			preview: {
				pageId: PAGE_ID,
				payload: { title: 'Saved' },
				unknownTemplates: [],
				status: 'published',
				routable: true,
				publicPath: '/about',
				savedAt: SAVED_AT,
				onSite: 'identical'
			}
		});
		const memo = await readContent(ctx.content);
		assert.equal(calls[2][1].raw, raw);
		assert.equal(calls[2][1].collections, memo.collections);
		assert.equal(calls[2][1].apex, client);
		assert.equal(calls[2][1].apex, calls[3][1].apex);
		assert.deepEqual(apexCalls, [['getPage', PAGE_ID]]);
	});

	/** §2.2: a site's explicit refusal carries its reason and status unchanged through preview-page.ts:225-226. */
	it('returns a projection refusal as-is', async () => {
		const { loadSitePagePreview } = await import('../src/server/bff/operations/preview-page.ts');
		const { ctx } = harness();
		const result = await loadSitePagePreview(
			await request(ctx),
			ctx,
			{ pageId: PAGE_ID },
			adapter([], {
				async projectSaved() {
					return { ok: false, status: 404, reason: 'chrome' };
				}
			})
		);
		assert.deepEqual(result, { ok: false, status: 404, reason: 'chrome' });
	});

	/** preview-page.ts:227-233: canonical equality ignores key order; null and unequal comparables have distinct states. */
	it('computes absent, identical, and differs from adapter comparables', async () => {
		const { loadSitePagePreview } = await import('../src/server/bff/operations/preview-page.ts');
		for (const [published, onSite] of [
			[null, 'absent'],
			[{ b: 2, a: 1 }, 'identical'],
			[{ a: 9 }, 'differs']
		]) {
			const { ctx } = harness();
			const result = await loadSitePagePreview(
				await request(ctx),
				ctx,
				{ pageId: PAGE_ID },
				adapter([], {
					async publishedComparable() {
						return published;
					}
				})
			);
			assert.equal(result.preview.onSite, onSite);
		}
	});

	/** preview-page.ts:195-216 must not consult an adapter before guard or snapshot availability succeeds. */
	it('does not call Apex or the adapter after guard failure, or the adapter after 503', async () => {
		const { loadSitePagePreview } = await import('../src/server/bff/operations/preview-page.ts');
		const { ctx, calls: apexCalls } = harness();
		const calls = [];
		assert.deepEqual(
			await loadSitePagePreview(
				await request(ctx, false),
				ctx,
				{ pageId: PAGE_ID },
				adapter(calls)
			),
			{ ok: false, status: 401, reason: 'unauthorized' }
		);
		assert.deepEqual(apexCalls, []);
		assert.deepEqual(calls, []);
		const missing = harness(page(), [], 200, false);
		assert.deepEqual(
			await loadSitePagePreview(
				await request(missing.ctx),
				missing.ctx,
				{ pageId: PAGE_ID },
				adapter(calls)
			),
			{ ok: false, status: 503, reason: 'the site has not been published yet' }
		);
		assert.deepEqual(calls, []);
	});

	/** preview-page.ts:219-225 captures raw-derived facts before an errant adapter changes raw. */
	it('captures status, routability, and public path before projection', async () => {
		const { loadSitePagePreview } = await import('../src/server/bff/operations/preview-page.ts');
		const { ctx } = harness();
		const result = await loadSitePagePreview(
			await request(ctx),
			ctx,
			{ pageId: PAGE_ID },
			adapter([], {
				async projectSaved(input) {
					input.raw.slug = '/wrong';
					input.raw.status = 'draft';
					return { ok: true, payload: {}, comparable: {}, unknownTemplates: [] };
				},
				async publishedComparable() {
					return null;
				}
			})
		);
		assert.deepEqual(result, {
			ok: true,
			preview: {
				pageId: PAGE_ID,
				payload: {},
				unknownTemplates: [],
				status: 'published',
				routable: true,
				publicPath: '/about',
				savedAt: SAVED_AT,
				onSite: 'absent'
			}
		});
	});

	/** §2.2: GLC's raw slug path must equal page-data.js:239 for every relevant slug shape. */
	it('uses the public projection slug normalisation', async () => {
		const { glcPagePreviewAdapter } = await import('../src/server/bff/operations/preview-page.ts');
		for (const slug of ['/', 'about', '/About/']) {
			const raw = page({ slug });
			assert.equal(glcPagePreviewAdapter(options()).publicPath(raw), projectCmsPage(raw).slug);
		}
	});
});
