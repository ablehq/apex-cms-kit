/**
 * The admin session — the piece that replaced Cloudflare Access (plan §8, 3a,
 * ADR-1 as revised 2026-07-31). The admin authenticates a HUMAN against Apex staff
 * credentials and then holds that person's Apex token SERVER-SIDE, keyed by an
 * opaque cookie. Two properties are load-bearing and everything here exists to
 * keep them:
 *
 *   1. THE BROWSER NEVER RECEIVES AN APEX TOKEN. The cookie value is 32 bytes of
 *      `crypto.getRandomValues` and carries no information — it is a lookup key,
 *      not a credential for Apex. The Apex access/refresh tokens live only in D1
 *      and in the Worker's memory for the life of one request. This is the whole
 *      reason the BFF was kept instead of copying Keus's browser-side token model,
 *      which puts the Apex token in `localStorage` where any XSS can read it.
 *   2. WHAT IS STORED IS NOT WHAT IS SENT. The row is keyed by the SHA-256 of the
 *      cookie value, so a dump of the session table yields no usable cookie: an
 *      attacker holding the table cannot mint a session without inverting SHA-256.
 *
 * Lifetime is bounded three ways, all checked on every authenticated request:
 * an ABSOLUTE end (`expiresAt`), an IDLE cutoff (`lastSeenAt` + idle TTL), and the
 * Apex access token's own expiry — which is refreshed in place via the refresh
 * grant so a working session survives the 2-hour Apex token lifetime without the
 * editor logging in again.
 *
 * The store is an INTERFACE with one production implementation over the existing
 * D1 binding (`createD1SessionStore`, table `bff_session`, migration 0002). It is
 * an interface for the same reason `apex` is injectable: the node suites drive the
 * real handlers with an in-memory adapter, while the miniflare harness exercises
 * the real SQL against real D1.
 */

import type { BffDatabase } from './d1';

/** The opaque session cookie. httpOnly — the browser's JS must never read it. */
export { SESSION_COOKIE } from '../../cookies';
import { SESSION_COOKIE } from '../../cookies';

/**
 * How long a session may live at most, regardless of activity. Twelve hours is one
 * working day: an editor signs in in the morning and is asked again tomorrow.
 */
export const SESSION_ABSOLUTE_TTL_MS = 12 * 60 * 60 * 1000;

/** How long a session may sit unused before it is dropped (shared-machine hygiene). */
export const SESSION_IDLE_TTL_MS = 4 * 60 * 60 * 1000;

/**
 * Refresh the Apex access token when it is within this of expiry. Apex issues
 * `expires_in: 7200`, so this renews well before a request could race the clock.
 */
export const ACCESS_REFRESH_SKEW_MS = 2 * 60 * 1000;

/**
 * Only rewrite `last_seen_at` when it is at least this stale. Without it every
 * authenticated GET would cost a D1 write for a field read at minute resolution.
 */
export const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

/** Maximum accepted cookie length — a lookup key is 43 chars; nothing legitimate is longer. */
const MAX_COOKIE_LENGTH = 256;

/**
 * One signed-in editor. `accessToken` / `refreshToken` are the Apex staff tokens
 * for THAT PERSON — every Apex call the BFF makes on their behalf uses them, which
 * is what makes Apex's own audit name the human instead of a shared machine login.
 * All times are ms since epoch.
 */
export interface SessionRecord {
	/** SHA-256 (hex) of the cookie value. The cookie value itself is never stored. */
	id: string;
	createdAt: number;
	lastSeenAt: number;
	/** Absolute end of the session. */
	expiresAt: number;
	staffEmail: string;
	staffId: string | null;
	staffName: string | null;
	accessToken: string;
	tokenType: string;
	/** When the Apex ACCESS token expires (not the session). */
	accessExpiresAt: number;
	refreshToken: string;
}

export interface SessionStore {
	/**
	 * Whether this store can actually store anything.
	 *
	 * The D1 implementation answers `false` when the binding is absent — a real
	 * state: a bare `vite dev` has no D1, and a Pages deploy whose binding was
	 * never wired has none either. Without this, the first thing to notice would be
	 * `create()` throwing AFTER Apex had already minted a token for a real person,
	 * stranding that token live and unrevoked on a login that then 500s.
	 *
	 * Optional so an in-memory test double need not implement it; absent means
	 * ready, which is true of any store that exists at all.
	 */
	ready?(): boolean;
	create(record: SessionRecord): Promise<void>;
	read(id: string): Promise<SessionRecord | null>;
	/** Persist a refreshed token set / a touched `lastSeenAt`. Never changes identity. */
	update(record: SessionRecord): Promise<void>;
	delete(id: string): Promise<void>;
	/** Best-effort sweep of rows past their absolute end. */
	purgeExpired(now: number): Promise<void>;
}

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function toBase64Url(bytes: Uint8Array): string {
	let out = '';
	for (let i = 0; i < bytes.length; i += 3) {
		const b0 = bytes[i];
		const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined;
		const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined;
		out += BASE64URL_ALPHABET[b0 >> 2];
		out += BASE64URL_ALPHABET[((b0 & 0b11) << 4) | ((b1 ?? 0) >> 4)];
		if (b1 === undefined) break;
		out += BASE64URL_ALPHABET[((b1 & 0b1111) << 2) | ((b2 ?? 0) >> 6)];
		if (b2 === undefined) break;
		out += BASE64URL_ALPHABET[b2 & 0b111111];
	}
	return out;
}

/**
 * Mint a fresh cookie value: 256 bits from the platform CSPRNG, base64url-encoded.
 * Unguessable, and carrying nothing about the editor — the identity lives in D1.
 */
export function createSessionSecret(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return toBase64Url(bytes);
}

/**
 * The stored key for a cookie value. Hashing before storage means the session table
 * is not itself a set of live credentials. Uses `crypto.subtle`, so the same code
 * runs in workerd and Node.
 */
export async function sessionIdFor(secret: string): Promise<string> {
	const data = new TextEncoder().encode(secret);
	const digest = await crypto.subtle.digest('SHA-256', data);
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

/** Read the session cookie off a request, or null. Length-capped before any work. */
export function readSessionCookie(request: { headers: Headers }): string | null {
	const header = request.headers.get('cookie');
	if (!header) return null;
	for (const pair of header.split(';')) {
		const index = pair.indexOf('=');
		if (index === -1) continue;
		if (pair.slice(0, index).trim() !== SESSION_COOKIE) continue;
		const value = pair.slice(index + 1).trim();
		if (!value || value.length > MAX_COOKIE_LENGTH) return null;
		return value;
	}
	return null;
}

/**
 * `Secure` follows the request scheme rather than being hardcoded, so the cookie
 * still lands on `http://localhost:4173` during local bring-up while every deployed
 * (https) origin gets it. Same rule the CSRF cookie uses in `hooks.server.ts`.
 */
export function isSecureRequest(request: { url: string }): boolean {
	try {
		return new URL(request.url).protocol === 'https:';
	} catch {
		return false;
	}
}

/** Serialize the session cookie. httpOnly + SameSite=Strict are not negotiable here. */
export function sessionCookieHeader(
	secret: string,
	options: { secure: boolean; maxAgeSeconds: number }
): string {
	const parts = [
		`${SESSION_COOKIE}=${secret}`,
		'Path=/',
		'HttpOnly',
		'SameSite=Strict',
		`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`
	];
	if (options.secure) parts.push('Secure');
	return parts.join('; ');
}

/** The cookie that ends a session in the browser. Logout also deletes the row. */
export function clearedSessionCookieHeader(secure: boolean): string {
	return sessionCookieHeader('', { secure, maxAgeSeconds: 0 });
}

/** True when the session envelope (absolute end / idle cutoff) has run out. */
export function isSessionExpired(record: SessionRecord, now: number): boolean {
	if (now >= record.expiresAt) return true;
	if (now - record.lastSeenAt >= SESSION_IDLE_TTL_MS) return true;
	return false;
}

/** True when the Apex ACCESS token needs renewing before the next upstream call. */
export function needsAccessRefresh(record: SessionRecord, now: number): boolean {
	return now >= record.accessExpiresAt - ACCESS_REFRESH_SKEW_MS;
}

interface SessionRow {
	id: string;
	created_at: number;
	last_seen_at: number;
	expires_at: number;
	staff_email: string;
	staff_id: string | null;
	staff_name: string | null;
	access_token: string;
	token_type: string;
	access_expires_at: number;
	refresh_token: string;
}

function fromRow(row: SessionRow): SessionRecord {
	return {
		id: row.id,
		createdAt: Number(row.created_at),
		lastSeenAt: Number(row.last_seen_at),
		expiresAt: Number(row.expires_at),
		staffEmail: row.staff_email,
		staffId: row.staff_id,
		staffName: row.staff_name,
		accessToken: row.access_token,
		tokenType: row.token_type,
		accessExpiresAt: Number(row.access_expires_at),
		refreshToken: row.refresh_token
	};
}

/**
 * The production store: the existing D1 binding, table `bff_session` (migration
 * 0002). Reads use the Sessions API with `'first-primary'` where the binding
 * supports it, so a request immediately after login never reads a replica that has
 * not seen the row yet (plan §8 "primary-consistent reads").
 */
export function createD1SessionStore(db: BffDatabase | undefined): SessionStore {
	return {
		// The binding is the whole store. Reported rather than discovered on the
		// first query, so the surfaces that must fail CLOSED can do so before they
		// have done anything irreversible. `BffEnv.DB` stays declared, deliberately:
		// the 3c ingest surface builds five more D1 stores off the same binding and
		// widening the whole env shape is a separate change from this one.
		ready: () => Boolean(db),
		async create(record) {
			if (!db) throw new Error('no D1 binding: the admin session store is unavailable');
			await db
				.prepare(
					`INSERT INTO bff_session
						(id, created_at, last_seen_at, expires_at, staff_email, staff_id, staff_name,
						 access_token, token_type, access_expires_at, refresh_token)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.bind(
					record.id,
					record.createdAt,
					record.lastSeenAt,
					record.expiresAt,
					record.staffEmail,
					record.staffId,
					record.staffName,
					record.accessToken,
					record.tokenType,
					record.accessExpiresAt,
					record.refreshToken
				)
				.run();
		},
		async read(id) {
			if (!db) return null;
			const source = db.withSession ? db.withSession('first-primary') : db;
			const row = await source
				.prepare(`SELECT * FROM bff_session WHERE id = ?`)
				.bind(id)
				.first<SessionRow>();
			return row ? fromRow(row) : null;
		},
		async update(record) {
			if (!db) return;
			await db
				.prepare(
					`UPDATE bff_session
						 SET last_seen_at = ?, access_token = ?, token_type = ?,
						     access_expires_at = ?, refresh_token = ?
					   WHERE id = ?`
				)
				.bind(
					record.lastSeenAt,
					record.accessToken,
					record.tokenType,
					record.accessExpiresAt,
					record.refreshToken,
					record.id
				)
				.run();
		},
		async delete(id) {
			if (!db) return;
			await db.prepare(`DELETE FROM bff_session WHERE id = ?`).bind(id).run();
		},
		async purgeExpired(now) {
			if (!db) return;
			await db.prepare(`DELETE FROM bff_session WHERE expires_at <= ?`).bind(now).run();
		}
	};
}
