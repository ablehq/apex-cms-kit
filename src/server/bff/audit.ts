import type { BffDatabase } from './d1';

/**
 * The append-only audit row the BFF writes for every mutation (plan §8, 3a).
 *
 * `actor_email` is the signed-in editor's canonical APEX STAFF email, and
 * `actor_sub` their Apex staff uuid — the same principal Apex records on its own
 * side, because every upstream call is made with that person's own token. Before
 * 2026-07-31 this was a Cloudflare Access identity that Apex never saw, and Apex's
 * audit read `glc-admin-bff` for every change no matter who made it.
 *
 * This log did not become redundant when that was fixed. It records what Apex
 * cannot: attempts that were REJECTED and never reached Apex at all (a bad login, a
 * cross-origin write, a missing CSRF token, a review-only field smuggled into a
 * payload), plus the BFF-side shape of each accepted write.
 */
export interface AuditEntry {
	id: string;
	occurredAt: string;
	actorEmail: string;
	actorSub?: string | null;
	/**
	 * 'human' | 'service' (3c, NEW-D4). The ingest surface writes 'service' with
	 * `actorEmail = 'service:' + staff_email`, so a machine actor can never be
	 * mistaken for a person even when the email half looks like one. Absent/null
	 * means a legacy row, which was always a human.
	 */
	actorKind?: 'human' | 'service' | null;
	action: string;
	method: string;
	path: string;
	accountId?: string | null;
	pageId?: string | null;
	requestId?: string | null;
	outcome: 'accepted' | 'rejected' | 'apex_error';
	detail?: unknown;
}

/** A stored audit row, as it comes back out of D1 (snake_case columns). */
export interface AuditRow {
	id: string;
	occurred_at: string;
	actor_email: string;
	actor_sub: string | null;
	actor_kind: string | null;
	action: string;
	method: string;
	path: string;
	account_id: string | null;
	page_id: string | null;
	request_id: string | null;
	outcome: string;
	detail: string | null;
}

/**
 * Insert one audit row. Append-only: there is no update or delete path. `detail`
 * is serialized to a compact JSON string; callers must never put a token or other
 * secret in it.
 */
export async function appendAuditEntry(db: BffDatabase, entry: AuditEntry): Promise<void> {
	await db
		.prepare(
			`INSERT INTO bff_audit_log
				(id, occurred_at, actor_email, actor_sub, actor_kind, action, method, path, account_id, page_id, request_id, outcome, detail)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			entry.id,
			entry.occurredAt,
			entry.actorEmail,
			entry.actorSub ?? null,
			entry.actorKind ?? null,
			entry.action,
			entry.method,
			entry.path,
			entry.accountId ?? null,
			entry.pageId ?? null,
			entry.requestId ?? null,
			entry.outcome,
			entry.detail === undefined ? null : JSON.stringify(entry.detail)
		)
		.run();
}

/**
 * F4 (3a.1 review hardening): record a REJECTED mutation. Previously only the
 * accepted / apex_error paths of a mutation wrote a row — a request that failed the
 * guard (forged token, cross-origin, missing CSRF) or strict validation (unknown
 * field, bad id) left no trace, so the audit log could not show attempts that were
 * turned away. This writes the `outcome: 'rejected'` row for exactly those paths.
 *
 * The actor is often UNKNOWN here (the JWT never verified), so `actorEmail` falls
 * back to `'unknown'` and the reason code goes in `detail` — never a token or the
 * raw header. Best-effort: a logging failure must never turn a correct rejection
 * into a 500, so callers wrap this so its own error is swallowed.
 */
export async function auditRejection(
	db: BffDatabase,
	entry: Omit<AuditEntry, 'outcome'> & { reason: string }
): Promise<void> {
	const { reason, detail, ...rest } = entry;
	await appendAuditEntry(db, {
		...rest,
		outcome: 'rejected',
		detail: detail === undefined ? { reason } : { reason, ...(detail as object) }
	});
}

/**
 * Read one audit row by id. Uses the D1 Sessions API with `'first-primary'` when
 * available so a read that must observe a just-written row is routed to the
 * primary, never a stale replica (plan §8 "primary-consistent reads"). Local
 * miniflare D1 is single-node, so the fallback path is exercised in the harness.
 */
export async function readAuditEntry(db: BffDatabase, id: string): Promise<AuditRow | null> {
	const source = db.withSession ? db.withSession('first-primary') : db;
	return source.prepare(`SELECT * FROM bff_audit_log WHERE id = ?`).bind(id).first<AuditRow>();
}
