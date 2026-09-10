// @ts-nocheck — node:test suite over the package's own file names.
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';

/**
 * Vite 6.2's package `exports` matcher treats a bare subpath whose BASENAME ends
 * in `ts` or `js` as a hit for this package's `./*.ts` / `./*.js` patterns and
 * then looks for a file that does not exist — measured 2026-09-05 with
 * `zz-ends-ts` (fails), `zz-ends-js` (fails), `zz-ends-xx` (resolves); Node's own
 * resolver gets all three right. A site's `vite build` for the Worker uses Vite's
 * resolver, so a module named that way is a build break in every consumer. This
 * test is the rule, enforced: no module under `src/` may be named that way.
 */
function walk(dir) {
	const out = [];
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) out.push(...walk(path));
		else out.push(path);
	}
	return out;
}

describe('module names a Vite consumer can resolve', () => {
	it('no src/** module basename ends in `ts` or `js` (before its extension)', () => {
		const offenders = walk('src')
			.filter((path) => /\.(ts|js)$/u.test(path))
			.map((path) => relative('src', path))
			.filter((path) => /(ts|js)\.(ts|js)$/u.test(path));
		assert.deepEqual(
			offenders,
			[],
			`rename these: a bare import of a module named …ts or …js fails under Vite 6.2: ${offenders.join(', ')}`
		);
	});
});
