import { createApexAdminClient } from './apex-admin-client';
import type { ApexAdminClient } from './apex-admin-client';
import { createApexAuthClient } from './apex-auth';
import type { ApexAuthClient } from './apex-auth';
import { parseAllowedOrigins } from './boundary';
import { createD1SessionStore } from './session';
import type { SessionStore } from './session';
import type { ContentStore } from '../content/read';
import type { ContentContract } from './content-contract';
import type { SiteProjection } from '../content/publish';
import type { BffDatabase } from './d1';

/**
 * The Pages Functions bindings the BFF reads at request time. Declared here and
 * reused by `App.Platform.env` (see `src/app.d.ts`) so there is one source of truth
 * for the shape. Secrets are read off `platform.env`, never bundled.
 *
 * Gone with Cloudflare Access (2026-07-31): `PRIVATE_ACCESS_JWT_ISSUER`,
 * `PRIVATE_ACCESS_JWT_AUDIENCE`, `PRIVATE_ACCESS_JWKS_URL`, the editor allowlist
 * `PRIVATE_BFF_EDITOR_EMAILS`, and the shared machine token
 * `PRIVATE_APEX_ADMIN_BFF_TOKEN`. The admin authenticates a person against Apex and
 * calls Apex as that person; there is no machine principal in the admin path at all.
 *
 * PHASE 3c (ingest) named its machine credential in `ingest-context.ts`
 * (`IngestEnv` extends this shape with `PRIVATE_APEX_INGEST_*`): the ingest
 * surface constructs the same Apex client with its own staff API key. The
 * HUMAN admin path still carries no machine principal at all.
 */
export interface BffEnv {
	DB: BffDatabase;
	/** Published site content (plan §2.3): one KV value, written by Publish. */
	CONTENT?: ContentStore;
	/** The Apex account this deployment publishes; the ingest surface's name is honoured too. */
	PRIVATE_APEX_ACCOUNT_ID?: string;
	PRIVATE_APEX_INGEST_ACCOUNT_ID?: string;
	/** Fixed Apex origin. `PRIVATE_…_BASE_URL` wins so a deploy can point at a different Apex. */
	PRIVATE_APEX_ADMIN_BFF_BASE_URL?: string;
	PUBLIC_APEX_API_BASE_URL?: string;
	/**
	 * The Apex OAuth CLIENT credential (not a user credential): it authorizes this
	 * application to ask Apex for a staff token on behalf of someone who supplied a
	 * correct email + password. The same pair the CMS build already uses.
	 */
	PRIVATE_APEX_APPLICATION_ID?: string;
	PRIVATE_APEX_APPLICATION_SECRET?: string;
	PRIVATE_BFF_ALLOWED_ORIGINS?: string;
	PUBLIC_ASSETS_PREFIX?: string;
}

/**
 * Everything an operation needs, resolved once per request. The handlers take this
 * as an argument rather than reaching for globals, which is exactly what lets the
 * suites build a context with an in-memory session store, a stub Apex client and a
 * test clock, and exercise the real handler code — in workerd for the harness.
 *
 * There is deliberately NO ready-made Apex client on the context. A client can only
 * be built from a token, and the only token available is the signed-in editor's,
 * which `guardRequest` hands back after it has resolved their session. That makes
 * "every Apex call is attributable to a person" a property of the types rather than
 * a rule someone has to remember.
 */
export interface BffContext {
	allowedOrigins: string[];
	/** Server-side session storage. D1 in production (`createD1SessionStore`). */
	sessions: SessionStore;
	/** Apex staff login / refresh / revoke / identity. */
	auth: ApexAuthClient;
	/** Build an Apex client for one editor's token. Called by the guard, not by ops. */
	createApexClient: (token: string) => ApexAdminClient;
	db?: BffDatabase;
	/**
	 * The published-content store. On the context (unlike the Apex client) because
	 * publishing writes with the deployment's own binding; the Apex READS a publish
	 * makes still go through the editor's client.
	 */
	content?: ContentStore;
	/**
	 * The site's content model, for the generic record operations (§ content-contract).
	 * Optional: a site with only bespoke screens never sets it, and the record
	 * operations refuse rather than guess when it is absent.
	 */
	contract?: ContentContract;
	/** The site's public asset prefix, for composing media URLs the admin shows. */
	assetsPrefix?: string;
	/** The site's projection of raw Apex collections into what its loaders read (plan §2.3). */
	project?: SiteProjection;
	/** The fixed Apex account the operations target, recorded on audit rows. */
	accountId?: string;
	/** Injectable clock (ms epoch) for deterministic tests. */
	now?: number;
	/**
	 * The field names only a dedicated human-review route may write (§ authorization).
	 *
	 * REQUIRED, and deliberately not optional: an unset or defaulted `[]` would make
	 * `containsReviewOnlyField` always return `false` — a write guard that silently
	 * passes, including on machine ingest surfaces with no human at the keyboard. A
	 * site with no such fields states that by passing `[]` explicitly.
	 */
	reviewOnlyFields: readonly string[];
}

/**
 * Build the request context for a real Worker run. The harness does NOT
 * use this — it constructs a `BffContext` directly with injected dependencies.
 *
 * `site.reviewOnlyFields` is required rather than defaulted: see `BffContext`. A
 * site with no review-only fields passes `[]` and says so at its call site.
 */
export function buildContext(
	event: { platform?: { env?: BffEnv } },
	site: { reviewOnlyFields: readonly string[] }
): BffContext {
	const env = event.platform?.env;
	if (!env) throw new Error('platform bindings unavailable');

	const baseUrl = env.PRIVATE_APEX_ADMIN_BFF_BASE_URL || env.PUBLIC_APEX_API_BASE_URL || '';

	return {
		allowedOrigins: parseAllowedOrigins(env.PRIVATE_BFF_ALLOWED_ORIGINS),
		sessions: createD1SessionStore(env.DB),
		auth: createApexAuthClient({
			baseUrl,
			applicationId: env.PRIVATE_APEX_APPLICATION_ID || '',
			applicationSecret: env.PRIVATE_APEX_APPLICATION_SECRET || ''
		}),
		createApexClient: (token: string) => createApexAdminClient({ baseUrl, token }),
		content: env.CONTENT,
		assetsPrefix: env.PUBLIC_ASSETS_PREFIX,
		accountId: env.PRIVATE_APEX_ACCOUNT_ID || env.PRIVATE_APEX_INGEST_ACCOUNT_ID || undefined,
		db: env.DB,
		reviewOnlyFields: site.reviewOnlyFields
	};
}
