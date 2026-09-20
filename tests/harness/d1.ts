/**
 * A real SQL database for the node suites, shaped like the `BffDatabase` surface
 * the BFF actually uses.
 *
 * The kit's node tests have always driven the handlers with in-memory doubles for
 * the STORES (`session-store.ts`), which is right when the thing under test is the
 * handler's decisions. It is not right when the thing under test is a STATEMENT —
 * and the media upload claim is exactly that: "exactly one of two concurrent
 * finalizes may spend this row" is a property of `UPDATE … WHERE redeemed_at IS
 * NULL` and its change count, not of the code that calls it. A hand-written double
 * would be asserting that the double behaves the way the SQL is assumed to.
 *
 * So this runs the real statements against `node:sqlite`, after applying the real
 * migration files out of `migrations/`. What it does not model is D1's replication
 * (`withSession` is deliberately absent, which exercises the fallback path) and its
 * network failures.
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { applyMigration } from '../../src/server/bff/d1.ts';
import type { BffDatabase, BffPreparedStatement } from '../../src/server/bff/d1.ts';

/** D1 accepts `undefined` for a null bind; `node:sqlite` does not. */
function bindable(value: unknown): null | number | bigint | string | Uint8Array {
	if (value === undefined || value === null) return null;
	if (typeof value === 'boolean') return value ? 1 : 0;
	if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string')
		return value;
	if (value instanceof Uint8Array) return value;
	return String(value);
}

/**
 * A hook a suite can install to hold a statement before it executes.
 *
 * Concurrency here cannot be left to the scheduler. `node:sqlite` is synchronous, so
 * two in-flight requests interleave only where their `await`s happen to line up —
 * and measured, they do not: a deliberately RACY `redeemUploadClaim` (a SELECT, then
 * an unconditional UPDATE) passed a plain `Promise.all` race of two finalizes three
 * runs out of three, because the first request got through both statements before
 * the second reached either. A test that a broken implementation passes is not a
 * test. `beforeStatement` lets a suite build a barrier instead, and park BOTH
 * requests on the claim table before either is allowed to touch it.
 */
export type StatementHook = (query: string) => void | Promise<void>;

interface Hooks {
	beforeStatement?: StatementHook;
}

function statement(
	db: DatabaseSync,
	hooks: Hooks,
	query: string,
	values: unknown[]
): BffPreparedStatement {
	const args = () => values.map(bindable);
	// The real D1 is a network call; crossing a macrotask boundary keeps a suite from
	// accidentally proving something that only holds because sqlite answered inline.
	const arrive = async () => {
		await new Promise((resolve) => setImmediate(resolve));
		if (hooks.beforeStatement) await hooks.beforeStatement(query);
	};
	return {
		bind(...next: unknown[]) {
			return statement(db, hooks, query, next);
		},
		async run() {
			await arrive();
			const result = db.prepare(query).run(...args());
			return { success: true, meta: { changes: Number(result.changes) } };
		},
		async first<T = Record<string, unknown>>() {
			await arrive();
			return (db.prepare(query).get(...args()) as T | undefined) ?? null;
		},
		async all<T = Record<string, unknown>>() {
			await arrive();
			return { results: db.prepare(query).all(...args()) as T[] };
		}
	};
}

export interface TestDatabase extends BffDatabase {
	/** The underlying handle, for a suite that wants to look at a row directly. */
	sqlite: DatabaseSync;
	/** Installed by a suite that needs to control when statements run. */
	beforeStatement?: StatementHook;
	close(): void;
}

/** An empty in-memory database with no schema. */
export function createSqliteDatabase(): TestDatabase {
	const sqlite = new DatabaseSync(':memory:');
	const db: TestDatabase = {
		sqlite,
		prepare(query: string) {
			return statement(sqlite, db, query, []);
		},
		async exec(query: string) {
			sqlite.exec(query);
			return { count: 0, duration: 0 };
		},
		close() {
			sqlite.close();
		}
	};
	return db;
}

/**
 * Park every request that touches `table` until `parties` of them have arrived, then
 * let them all go. This is what turns "two concurrent finalizes" into a fact rather
 * than a coincidence: both requests are held at their FIRST claim statement, so a
 * read-then-write implementation has both reads land before either write.
 */
export function barrierOn(db: TestDatabase, table: string, parties = 2): void {
	let arrived = 0;
	let open = () => {};
	const gate = new Promise<void>((resolve) => (open = resolve));
	db.beforeStatement = async (query) => {
		if (!query.includes(table)) return;
		arrived += 1;
		if (arrived >= parties) open();
		else await gate;
	};
}

/**
 * An in-memory database with every migration in `migrations/` applied, in filename
 * order — the same files a site copies and `wrangler d1 migrations apply` runs, so a
 * table the suites use but nobody migrated fails here rather than in production.
 */
export async function createMigratedDatabase(): Promise<TestDatabase> {
	const db = createSqliteDatabase();
	const dir = fileURLToPath(new URL('../../migrations/', import.meta.url));
	for (const name of readdirSync(dir).sort()) {
		if (name.endsWith('.sql')) await applyMigration(db, readFileSync(dir + name, 'utf8'));
	}
	return db;
}
