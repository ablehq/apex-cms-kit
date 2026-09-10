// @ts-nocheck — node:test suite over dynamic JSON shapes; behavior is the contract.
import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import {
	isCmsPageRoutable,
	projectFields,
	routableCmsPages,
	toAnchorId
} from '../src/cms/page-data.js';
import { bindReservedRoutes } from '../src/cms/page-slug-validation.js';

/**
 * WHY THIS FILE EXISTS, given `gospel-life-church/tests/cms-page-data.test.js` is 478
 * lines and thorough: **no test in THIS repo imported `src/cms/page-data.js` at all.**
 *
 * The kit is released independently — all three sites pin it as
 * `github:ablehq/apex-cms-kit#<sha>` — so a kit-only commit touching this file had no
 * gate whatsoever. Measured before this file existed: deleting
 * `if (record.status !== PUBLISHED) return false` left the entire 675-test suite green.
 * That single line is what keeps an unpublished page from being publicly routable, and
 * a draft leaking to the public internet is not a hypothetical on this project —
 * Godrej served its full CMS inventory, drafts included, at `/page-listing` for months.
 *
 * This is deliberately NOT a copy of GLC's suite. It pins the GUARDS — the lines whose
 * removal changes who can see what — and leaves the projection's breadth to the site
 * that consumes it.
 */

before(() => {
	// A site must bind before a slug can be validated; `current()` fails closed.
	bindReservedRoutes({
		prefixes: ['/sermons', '/blogs'],
		routes: ['/about'],
		portable: ['/give']
	});
});

const published = (slug = 'welcome') => ({ slug, status: 'published' });

describe('isCmsPageRoutable — who is allowed to be a public URL', () => {
	it('an ordinary published page routes', () => {
		assert.equal(isCmsPageRoutable(published()), true);
	});

	it('A DRAFT DOES NOT ROUTE — the line that keeps unpublished work off the public site', () => {
		assert.equal(isCmsPageRoutable({ slug: 'welcome', status: 'draft' }), false);
		assert.equal(isCmsPageRoutable({ slug: 'welcome', status: 'archived' }), false);
		assert.equal(
			isCmsPageRoutable({ slug: 'welcome' }),
			false,
			'no status at all is not published either — fail closed'
		);
	});

	it('a `__`-prefixed slug does not route: chrome pages are storage, not URLs', () => {
		assert.equal(isCmsPageRoutable(published('__header')), false);
		assert.equal(isCmsPageRoutable(published('__footer')), false);
		assert.equal(isCmsPageRoutable(published('__navigation')), false);
	});

	it('a slug that collides with a generated tree does not route, and SAYS SO', () => {
		const warnings = [];
		const warn = (message) => warnings.push(message);
		assert.equal(isCmsPageRoutable(published('sermons'), { warn }), false);
		assert.equal(isCmsPageRoutable(published('sermons/easter'), { warn }), false);
		assert.equal(isCmsPageRoutable(published('about'), { warn }), false);
		assert.equal(warnings.length, 3);
		assert.match(
			warnings[0],
			/collides with a route the site generates/,
			'a page that silently never renders is the failure this message exists to prevent'
		);
	});

	it('a portable route MAY be shadowed — that is the whole point of `portable`', () => {
		assert.equal(isCmsPageRoutable(published('give')), true);
	});

	it('no slug, an empty slug, or a non-object is not routable', () => {
		assert.equal(isCmsPageRoutable(published('')), false);
		assert.equal(isCmsPageRoutable({ status: 'published' }), false);
		assert.equal(isCmsPageRoutable(null), false);
		assert.equal(isCmsPageRoutable('welcome'), false);
	});

	it('routableCmsPages keeps only what routes, and survives a non-array', () => {
		const pages = [
			published('a'),
			{ slug: 'b', status: 'draft' },
			published('__header'),
			published('sermons'),
			published('c')
		];
		assert.deepEqual(
			routableCmsPages(pages, { warn() {} }).map((page) => page.slug),
			['a', 'c']
		);
		assert.deepEqual(routableCmsPages(null), []);
	});
});

describe('projectFields — what reaches a component', () => {
	it('SANITIZES rich text: markup an editor stored cannot arrive executable', () => {
		const fields = projectFields({
			body: { html: '<p>ok</p><script>alert(1)</script>' },
			intro: { html: '<p>hi<img src=x onerror=alert(2)></p>' }
		});
		assert.ok(!fields.body.html.includes('<script'), `script survived: ${fields.body.html}`);
		assert.ok(fields.body.html.includes('ok'), 'the editor’s own text is kept');
		assert.ok(
			!/onerror/i.test(fields.intro.html),
			`event attribute survived: ${fields.intro.html}`
		);
		assert.ok(fields.intro.html.includes('hi'));
	});

	it('a rich-text value that sanitizes to nothing is dropped, not rendered empty', () => {
		const fields = projectFields({ body: { html: '<script>alert(1)</script>' } });
		assert.ok(!('body' in fields));
	});

	it('resolves a media id through the snapshot index, and degrades to the string when unknown', () => {
		const media = new Map([['img-1', { url: '/i.jpg', alt: 'A', contentType: 'image/jpeg' }]]);
		const fields = projectFields({ hero: 'img-1', other: 'img-missing' }, media);
		assert.deepEqual(fields.hero, { url: '/i.jpg', alt: 'A', contentType: 'image/jpeg' });
		assert.equal(fields.other, 'img-missing');
	});

	it('keeps scalars and string arrays, drops empty strings and shapes it cannot read', () => {
		const fields = projectFields({
			flag: true,
			count: 3,
			tags: ['a', 'b', 7],
			blank: '',
			weird: { not: 'rich text' },
			nothing: null
		});
		assert.equal(fields.flag, true);
		assert.equal(fields.count, 3);
		assert.deepEqual(fields.tags, ['a', 'b']);
		assert.ok(!('blank' in fields));
		assert.ok(!('weird' in fields), 'a shape with no `html` is dropped rather than guessed at');
		assert.ok(!('nothing' in fields));
	});

	it('survives a non-object', () => {
		assert.deepEqual(projectFields(null), {});
		assert.deepEqual(projectFields('x'), {});
	});
});

describe('toAnchorId — an editor string becoming a DOM id', () => {
	it('reduces to what is safe in an id and linkable with #', () => {
		assert.equal(toAnchorId('  Our Story!  '), 'our-story');
		assert.equal(toAnchorId('a/b?c=1'), 'a-b-c-1');
		assert.equal(toAnchorId('--x--'), 'x');
	});

	it('an unusable value becomes no anchor, never a broken one', () => {
		assert.equal(toAnchorId('!!!'), '');
		assert.equal(toAnchorId(42), '');
		assert.equal(toAnchorId(undefined), '');
	});

	it('is bounded, so one field cannot mint an unbounded id', () => {
		assert.equal(toAnchorId('a'.repeat(200)).length, 64);
	});
});
