import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import {
	getPageSlugValidationError,
	isReservedSlug,
	normalizeSlugPath,
	bindReservedRoutes
} from '../src/cms/page-slug-validation.js';

// A site's shape, bound the way its site module would.
const { RESERVED_PREFIXES, RESERVED_ROUTES, PORTABLE_ROUTES } = bindReservedRoutes({
	prefixes: ['/blogs', '/resources', '/sermons'],
	routes: ['/contact'],
	portable: ['/gospel', '/what-we-believe', '/who-we-are']
});

test('admin and api are reserved, as the admin location requires', () => {
	for (const slug of ['/admin', 'admin/pages', '/api', 'api/ingest/anything']) {
		assert.ok(isReservedSlug(slug), `${slug} must be reserved`);
		assert.match(getPageSlugValidationError(slug), /administration area/u);
	}
});

test('the data-type routes are reserved with their descendants', () => {
	for (const slug of ['blogs', 'blogs/a-post', 'sermons', 'sermons/a-message', 'resources']) {
		assert.ok(isReservedSlug(slug), `${slug} must be reserved`);
		assert.match(getPageSlugValidationError(slug), /a route the site generates/u);
	}
});

test('the home page is an ordinary CMS slug since the port', () => {
	// `/` used to be reserved by the hand-built home route. That route is gone:
	// the home page IS a CMS page, so `/` must validate — and it is the one slug
	// the hyphenated-words grammar cannot express, so it is allowed explicitly.
	assert.equal(isReservedSlug('/'), false);
	assert.equal(getPageSlugValidationError('/'), '');
	assert.equal(getPageSlugValidationError(''), '');
	assert.equal(getPageSlugValidationError('/////'), '');
});

test('/contact is still code, not content', () => {
	// The one exact route left in the reserved list: it has a server action.
	assert.ok(isReservedSlug('/contact'));
	assert.match(getPageSlugValidationError('/contact'), /a route the site generates/u);
});

test('a prefix does not swallow a slug that merely starts with its letters', () => {
	assert.equal(isReservedSlug('/blogsy'), false);
	assert.equal(isReservedSlug('/administration'), false);
	assert.equal(getPageSlugValidationError('/blogsy'), '');
});

// A `portable` route has a filesystem route AND is creatable as a CMS page, so the
// CMS page shadows it. That is the property worth pinning; the `isPortableRouteSlug`
// predicate that used to be asserted here had no caller in any repo.
test('the ported static routes are portable, not reserved', () => {
	for (const slug of ['/who-we-are', '/gospel', '/what-we-believe']) {
		assert.equal(isReservedSlug(slug), false);
		assert.equal(getPageSlugValidationError(slug), '');
	}
});

test('internal `__` slugs are creatable, since the singletons need them', () => {
	assert.equal(getPageSlugValidationError('__sermons'), '');
	assert.equal(getPageSlugValidationError('__header'), '');
});

test('a slug that is not a usable path is refused', () => {
	for (const slug of ['Who We Are', 'who_we_are', 'who--we--are', 'who we are', 'WHO-WE-ARE']) {
		assert.match(getPageSlugValidationError(slug), /not a usable page path/u, slug);
	}
	assert.equal(getPageSlugValidationError('a/b/c'), '');
	assert.equal(getPageSlugValidationError('our-story-2024'), '');
});

test('normalization is shared with the router', () => {
	assert.equal(normalizeSlugPath('who-we-are'), '/who-we-are');
	assert.equal(normalizeSlugPath('//who-we-are//'), '/who-we-are');
});
