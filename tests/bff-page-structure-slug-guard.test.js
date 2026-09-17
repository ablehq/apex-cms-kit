// @ts-nocheck — node:test suite over dynamic JSON shapes; behavior is the contract.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
	handleSavePageStructure,
	refuseRenamedSlug
} from '../src/server/bff/operations/save-page-structure.ts';
import { bindReservedRoutes } from '../src/cms/page-slug-validation.js';
import { createSessionSecret, sessionIdFor } from '../src/server/bff/session.ts';
import { parseAllowedOrigins } from '../src/server/bff/boundary.ts';
import { createMemorySessionStore } from './harness/session-store.ts';

/**
 * K41 / K67 — the reserved-slug guard on the structure save.
 *
 * `create` refused these five slugs and the structure save accepted every one of
 * them (measured 2026-09-09, both validators executed side by side), plus a
 * rename onto `__footer` measured live through the real BFF on 2026-09-10. The
 * page editor's Details tab writes the slug through THIS route, so that gap is
 * the whole exposure: a page renamed onto a generated route renders nothing
 * forever, and a page renamed onto `__footer` becomes the site's footer while
 * vanishing from its own address.
 *
 * The binding below is Poovayya's own shape (`src/lib/site.js`), because the
 * production case that makes this delicate is Poovayya's: a legitimate CMS page
 * lives at `/team-members`, which the site ALSO reserves as a generated tree. It
 * must keep saving.
 *
 * MUTATIONS this file kills — each was run:
 *   1. drop the stored-slug compare (validate every save) → "a reorder of the page
 *      that already lives at a now-reserved address still saves" goes RED.
 *   2. drop the `__` rule → "about-us cannot be renamed onto __footer" goes RED.
 *   3. make the `__` rule refuse regardless of where the page is now → "__header
 *      may still move within the reserved prefix" goes RED.
 *   4. compare the NORMALIZED paths instead of the raw strings → "the leading-slash
 *      spelling is a rename, not a no-op" goes RED.
 *   5. drop the try/catch around the validator → the unbound suite
 *      (`bff-page-structure-slug-unbound.test.js`) goes RED.
 */
const ORIGIN = 'https://site.test';
const CSRF = 'csrf-slug-guard';
const PAGE = '7a14e45f-ceea-467a-9a3c-3f1a7c9d2b55';
const BLOCK = 'a1000000-0000-4000-8000-000000000001';

// Poovayya's binding, as `src/lib/site.js` declares it.
bindReservedRoutes({
	prefixes: [
		'/awards-honours',
		'/industries',
		'/insights-and-updates',
		'/practice-areas',
		'/team-members'
	],
	routes: ['/contact']
});

function pageAt(slug) {
	return {
		id: PAGE,
		title: 'A page',
		slug,
		meta_properties: [],
		blocks: [
			{
				id: BLOCK,
				position: 0,
				blockable_type: 'Cms::PageBlock::RichText',
				blockable: { id: 'a1000000-0000-4000-8000-000000000002', content_html: '<p>A</p>' }
			}
		]
	};
}

/** What the editor sends on a save: the whole page, block order included. */
function bodyFor(slug) {
	return {
		title: 'A page',
		slug,
		summary: '',
		blocks_attributes: [
			{
				id: BLOCK,
				position: 0,
				blockable_type: 'Cms::PageBlock::RichText',
				blockable_attributes: {
					id: 'a1000000-0000-4000-8000-000000000002',
					content_html: '<p>A, edited</p>'
				},
				_destroy: false
			}
		]
	};
}

function apexStub(calls, page) {
	return {
		async getPage(id) {
			calls.push(['getPage', id]);
			return { ok: true, status: 200, body: { data: page } };
		},
		async updatePageStructure(id, body) {
			calls.push(['updatePageStructure', id, body]);
			return { ok: true, status: 200, body: { data: page } };
		}
	};
}

function ctxWith(calls, page) {
	return {
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
		createApexClient: () => apexStub(calls, page),
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
		staffId: 'staff-1',
		staffName: 'E',
		accessToken: 't',
		tokenType: 'Bearer',
		accessExpiresAt: now + 3600_000,
		refreshToken: 'r'
	});
	return secret;
}

function patch(session, body) {
	return new Request(`${ORIGIN}/api/admin/pages/${PAGE}/structure`, {
		method: 'PATCH',
		headers: {
			origin: ORIGIN,
			'sec-fetch-site': 'same-origin',
			'content-type': 'application/json',
			'x-csrf-token': CSRF,
			cookie: `apex_bff_csrf=${CSRF}; apex_admin_session=${session}`
		},
		body: JSON.stringify(body)
	});
}

/** Save `body` against a stored page whose slug is `storedSlug`. */
async function save(storedSlug, body) {
	const calls = [];
	const ctx = ctxWith(calls, pageAt(storedSlug));
	const res = await handleSavePageStructure(patch(await signIn(ctx), body), ctx, { pageId: PAGE });
	return { res, patches: calls.filter(([name]) => name === 'updatePageStructure') };
}

/** Rename the page currently at `from` to `to`. */
function rename(from, to) {
	return save(from, bodyFor(to));
}

describe('K41 — the five slugs `create` refuses and the structure save used to accept', () => {
	/**
	 * The measured table, row for row. Every one of these answered 200 and was
	 * STORED before this guard existed; `create` answered `400 reserved-slug` for
	 * all five on the same account on the same day.
	 */
	for (const slug of ['team-members', '/team-members', 'practice-areas', 'admin/x', 'About-Us']) {
		it(`refuses a rename of about-us onto \`${slug}\``, async () => {
			const { res, patches } = await rename('about-us', slug);
			assert.equal(res.status, 400, await res.clone().text());
			assert.deepEqual(await res.json(), { error: 'reserved-slug' });
			assert.deepEqual(patches, [], `${slug} must never reach Apex`);
		});
	}

	it('the scenario from the issue: About us renamed to `industries` is refused', async () => {
		// The page then renders nothing, forever, because a SvelteKit filesystem
		// route outranks `[[slug]]` — the failure `src/lib/site.js` exists to prevent.
		const { res, patches } = await rename('about-us', 'industries');
		assert.equal(res.status, 400);
		assert.deepEqual(patches, []);
	});
});

describe('an UNCHANGED slug is never checked — the production case', () => {
	/**
	 * MUTATION 1: drop the stored-slug compare and validate the slug on every save.
	 * This goes RED — and on production it would make a real page permanently
	 * unsaveable, which is strictly worse than the defect.
	 */
	it('a reorder of the page that already lives at a now-reserved address still saves', async () => {
		const { res, patches } = await save('team-members', bodyFor('team-members'));
		assert.equal(res.status, 200, await res.clone().text());
		assert.equal(patches.length, 1);
		assert.equal(patches[0][2].slug, 'team-members');
	});

	it('the same holds for a page at an address the path grammar would refuse', async () => {
		// `About-Us` is not a usable NEW slug; a page already stored there keeps saving.
		const { res, patches } = await save('About-Us', bodyFor('About-Us'));
		assert.equal(res.status, 200);
		assert.equal(patches.length, 1);
	});

	it('a save that sends no slug at all is not a rename', async () => {
		const body = bodyFor('team-members');
		delete body.slug;
		const { res, patches } = await save('team-members', body);
		assert.equal(res.status, 200);
		assert.equal(patches.length, 1);
	});

	/**
	 * MUTATION 4: compare the normalized paths instead of the raw strings. This
	 * goes RED. It matters because `/team-members` and `team-members` normalize to
	 * the same path but are different stored strings, and only one of them was
	 * measured safe on this account.
	 */
	it('the leading-slash spelling is a rename, not a no-op', async () => {
		const { res, patches } = await save('team-members', bodyFor('/team-members'));
		assert.equal(res.status, 400);
		assert.deepEqual(patches, []);
	});

	it('an ordinary rename to an ordinary address still works', async () => {
		const { res, patches } = await rename('about-us', 'about-the-firm');
		assert.equal(res.status, 200, await res.clone().text());
		assert.equal(patches.length, 1);
		assert.equal(patches[0][2].slug, 'about-the-firm');
	});
});

describe('K67 — the `__` prefix, in both directions', () => {
	/**
	 * MUTATION 2: drop the `__` rule. This goes RED.
	 * `getPageSlugValidationError` deliberately returns '' for a `__` slug — they
	 * are reserved from public ROUTING, not from being created — so nothing else
	 * catches this.
	 */
	it('an ordinary page cannot be renamed onto `__footer`', async () => {
		const { res, patches } = await rename('about-us', '__footer');
		assert.equal(res.status, 400, await res.clone().text());
		assert.deepEqual(await res.json(), { error: 'reserved-slug' });
		assert.deepEqual(patches, []);
	});

	it('nor onto `__header`, which drives the site’s navigation', async () => {
		const { res, patches } = await rename('about-us', '__header');
		assert.equal(res.status, 400);
		assert.deepEqual(patches, []);
	});

	it('nor by the leading-slash spelling', async () => {
		const { res, patches } = await rename('about-us', '/__footer');
		assert.equal(res.status, 400);
		assert.deepEqual(patches, []);
	});

	it('`__header` may reorder its own blocks — the slug is unchanged', async () => {
		const { res, patches } = await save('__header', bodyFor('__header'));
		assert.equal(res.status, 200, await res.clone().text());
		assert.equal(patches.length, 1);
		assert.equal(patches[0][2].blocks_attributes.length, 1);
	});

	/**
	 * MUTATION 3: refuse a `__` destination regardless of where the page is now.
	 * This goes RED. The rule is about MOVING ONTO the reserved prefix, not about
	 * living there.
	 */
	it('`__header` may still move within the reserved prefix', async () => {
		const { res, patches } = await save('__header', bodyFor('__footer'));
		assert.equal(res.status, 200, await res.clone().text());
		assert.equal(patches.length, 1);
	});

	it('K67 direction 2: `__header` renamed to `industries` is refused', async () => {
		// Both bugs at once — the chrome loses its header AND the page never renders.
		const { res, patches } = await save('__header', bodyFor('industries'));
		assert.equal(res.status, 400);
		assert.deepEqual(patches, []);
	});
});

describe('refuseRenamedSlug — the rule on its own', () => {
	it('says nothing about an unchanged slug, whatever it is', () => {
		assert.equal(refuseRenamedSlug('team-members', 'team-members'), null);
		assert.equal(refuseRenamedSlug('About-Us', 'About-Us'), null);
		assert.equal(refuseRenamedSlug('__header', '__header'), null);
		assert.equal(refuseRenamedSlug('about-us', undefined), null);
	});

	it('names the reason, because `invalid body` sends an editor guessing', () => {
		assert.match(refuseRenamedSlug('about-us', 'admin/x'), /site administration area/u);
		assert.match(refuseRenamedSlug('about-us', 'practice-areas'), /route the site generates/u);
		assert.match(refuseRenamedSlug('about-us', 'About-Us'), /lowercase words/u);
		assert.match(refuseRenamedSlug('about-us', '__footer'), /site's own chrome/u);
	});

	it('a page whose stored slug Apex did not return is treated as a rename', () => {
		// Fail closed: with nothing to compare against, the incoming slug is validated.
		assert.match(refuseRenamedSlug(undefined, 'industries'), /route the site generates/u);
		assert.equal(refuseRenamedSlug(undefined, 'about-us'), null);
	});
});
