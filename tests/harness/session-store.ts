/**
 * Test doubles for the two injected dependencies the admin session needs: the
 * session store and the Apex auth client.
 *
 * The MEMORY STORE is for the node suites, which drive the real operation handlers
 * in-process. It is deliberately the same `SessionStore` interface the production
 * D1 adapter implements — the SQL itself is covered where it belongs, in the
 * miniflare harness, against real D1 and the real migration.
 *
 * The STUB AUTH CLIENT lets a suite decide what Apex says without a network: which
 * credentials are correct, how long a token lasts, and whether `staffsMe` admits
 * the principal (the check that replaced the editor allowlist). It records the
 * calls it received so a test can assert that, for example, a refused login had its
 * freshly-minted token revoked again.
 */

import type { SessionRecord, SessionStore } from '../../src/server/bff/session';
import type {
	ApexAuthClient,
	ApexStaffIdentity,
	ApexTokenSet
} from '../../src/server/bff/apex-auth';

export function createMemorySessionStore(): SessionStore & {
	rows: Map<string, SessionRecord>;
} {
	const rows = new Map<string, SessionRecord>();
	return {
		rows,
		async create(record) {
			rows.set(record.id, { ...record });
		},
		async read(id) {
			const row = rows.get(id);
			return row ? { ...row } : null;
		},
		async update(record) {
			if (rows.has(record.id)) rows.set(record.id, { ...record });
		},
		async delete(id) {
			rows.delete(id);
		},
		async purgeExpired(now) {
			for (const [id, row] of rows) if (row.expiresAt <= now) rows.delete(id);
		}
	};
}

export interface StubAuthOptions {
	/** email (lower-cased) → password that works. */
	credentials?: Record<string, string>;
	/** email (lower-cased) → the identity `staffsMe` returns. Absent ⇒ Apex refuses. */
	identities?: Record<string, ApexStaffIdentity>;
	/** Access-token lifetime, in seconds (Apex issues 7200). */
	expiresInSec?: number;
}

export interface StubAuthClient extends ApexAuthClient {
	calls: { passwordGrant: string[]; refreshGrant: string[]; staffsMe: string[]; revoke: string[] };
	/** Make every subsequent refresh fail, as a revoked account would. */
	breakRefresh(): void;
}

export function createStubAuthClient(options: StubAuthOptions = {}): StubAuthClient {
	const credentials = options.credentials ?? {};
	const identities = options.identities ?? {};
	const expiresInSec = options.expiresInSec ?? 7200;
	const calls = {
		passwordGrant: [] as string[],
		refreshGrant: [] as string[],
		staffsMe: [] as string[],
		revoke: [] as string[]
	};
	let refreshWorks = true;
	let serial = 0;

	// Tokens are minted per email so `staffsMe` can map a token back to a principal —
	// which is what lets a test model "Apex admits A but refuses B".
	function mint(email: string): ApexTokenSet {
		serial += 1;
		return {
			accessToken: `stub-access-${email}-${serial}`,
			tokenType: 'Bearer',
			expiresInSec,
			refreshToken: `stub-refresh-${email}-${serial}`,
			createdAtSec: Math.floor(Date.now() / 1000)
		};
	}

	function emailFromToken(token: string): string {
		const match = /^stub-(?:access|refresh)-(.+)-\d+$/u.exec(token);
		return match ? match[1] : '';
	}

	return {
		calls,
		breakRefresh() {
			refreshWorks = false;
		},
		async passwordGrant(username, password) {
			calls.passwordGrant.push(username);
			const email = username.trim().toLowerCase();
			if (credentials[email] !== password) return null;
			return mint(email);
		},
		async refreshGrant(refreshToken) {
			calls.refreshGrant.push(refreshToken);
			if (!refreshWorks) return null;
			const email = emailFromToken(refreshToken);
			if (!email) return null;
			return mint(email);
		},
		async staffsMe(accessToken) {
			calls.staffsMe.push(accessToken);
			const email = emailFromToken(accessToken);
			return identities[email] ?? null;
		},
		async revoke(accessToken) {
			calls.revoke.push(accessToken);
		}
	};
}
