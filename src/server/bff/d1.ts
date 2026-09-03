/**
 * A minimal structural view of the Cloudflare D1 API — only the surface the BFF
 * scaffold actually uses. The real `D1Database` (from `@cloudflare/workers-types`,
 * and the object miniflare hands back in the harness) is a superset and is
 * assignable to these interfaces, so nothing is lost by not depending on the full
 * generated `worker-configuration.d.ts`. Keeping it local keeps the check surface
 * small and the scaffold self-contained.
 */

export interface BffPreparedStatement {
	bind(...values: unknown[]): BffPreparedStatement;
	/**
	 * `meta.changes` is the D1 row-change count. It is optional here because the
	 * scaffold's early fakes never reported it, but the real binding always does —
	 * and the ingest single-use claims (`ingest-token.ts`) DEPEND on it: a claim
	 * whose platform reports no change count fails CLOSED rather than double-spends.
	 */
	run(): Promise<{ success: boolean; meta?: { changes?: number } }>;
	first<T = Record<string, unknown>>(): Promise<T | null>;
	all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}

export interface BffDatabaseSession {
	prepare(query: string): BffPreparedStatement;
}

export interface BffDatabase {
	prepare(query: string): BffPreparedStatement;
	exec(query: string): Promise<{ count: number; duration: number }>;
	/**
	 * D1 Sessions API. Reads that must observe a just-committed write pass
	 * `'first-primary'` so they are routed to the primary and never a stale
	 * replica (plan §8 "primary-consistent reads"). Optional here because
	 * miniflare's local D1 is single-node; the production binding honours it.
	 */
	withSession?(constraintOrBookmark?: string): BffDatabaseSession;
}

/**
 * Split a `.sql` migration file into individual statements. D1 prepares one
 * statement at a time, so tests and the local-D1 bring-up apply migrations
 * statement by statement. Line comments are stripped FIRST (an inline `-- …` can
 * contain a semicolon, which would otherwise cut a statement in half), then the
 * remainder is split on `;`. This is a scaffold helper, not a general SQL parser:
 * it assumes the migrations contain no `--` sequence or `;` inside a string
 * literal — which these do not.
 */
export function splitSqlStatements(sql: string): string[] {
	const withoutComments = sql
		.split('\n')
		.map((line) => {
			const commentIndex = line.indexOf('--');
			return commentIndex === -1 ? line : line.slice(0, commentIndex);
		})
		.join('\n');
	return withoutComments
		.split(';')
		.map((statement) => statement.trim())
		.filter((statement) => statement.length > 0);
}

/** Apply a migration's statements to a D1 database (used by the harness + local bring-up). */
export async function applyMigration(db: BffDatabase, sql: string): Promise<void> {
	for (const statement of splitSqlStatements(sql)) {
		await db.prepare(statement).run();
	}
}
