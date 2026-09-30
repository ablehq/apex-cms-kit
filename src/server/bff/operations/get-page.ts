import { unwrapArchetypeRecord } from '../archetype-record';
import { z } from 'zod';
import { bffError, noStoreJson } from '../boundary';
import { guardRequest } from '../guard';
import { computePageVersion } from '../page-version';
import type { BffContext } from '../context';

/**
 * GET /api/admin/pages/[pageId] — read one fully-hydrated page for the editor, plus
 * its composite version token (plan §8, 3a). A read (no CSRF), still held to the
 * full boundary + Access-JWT + editor allowlist. The `pageId` is validated as a
 * UUID before it is ever interpolated into an Apex URL.
 *
 * The response is `{ page, version, childRows }`: the browser edits a local draft of
 * `page`, and holds `version` as the baseline the stale guard compares against on
 * Save. The upstream `{ data: … }` envelope is unwrapped so the browser sees exactly
 * the page.
 *
 * ── `childRows`, AND WHY IT IS A SIBLING RATHER THAN PART OF THE PAGE ────────
 * An `array_ref` field stores IDS of free-standing entities, so the page Apex
 * returns carries `['a','b']` and not the rows. The editor draws ROWS. Without this
 * every existing row rendered "(empty)" and opened to blank inputs — four live
 * "why choose" points looked like four empty ones, which invites an editor to
 * "repair" content that was never broken. Found in the Phase 3 review, 2026-09-22.
 *
 * It rides BESIDE the page, not inside it, for two concrete reasons: `computePageVersion`
 * hashes the page, so folding rows in would change the stale-guard token for a read
 * that changed nothing; and `block-serialize.js` would then have to strip the key on
 * every write, which is exactly the class of bug the read-back `entities` key already
 * caused once.
 *
 * Sites with no `array_ref` field supply no resolver and get `{}` — no extra request.
 */
export const pageIdSchema = z
	.string()
	.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu);

export async function handleGetPage(
	request: Request,
	ctx: BffContext,
	params: { pageId: string }
): Promise<Response> {
	const guard = await guardRequest(request, ctx, { mutation: false });
	if (!guard.ok) return guard.response;

	const idResult = pageIdSchema.safeParse(params.pageId);
	if (!idResult.success) return bffError(400, 'invalid page id');

	const apexResponse = await guard.apex.getPage(idResult.data);
	if (!apexResponse.ok) return bffError(502, 'upstream error');

	const page = unwrapArchetypeRecord(apexResponse.body);
	if (!page) return bffError(502, 'unexpected upstream shape');

	const version = await computePageVersion(page);

	// FAILS CLOSED, for the same reason `get-record` does: an `array_ref` list that
	// silently looks empty is a LEGAL state, so a failed child read that rendered as
	// one would be indistinguishable from "there is nothing here".
	const resolver = ctx.resolvePageChildRows;
	if (!resolver) return noStoreJson({ page, version, childRows: {} });
	const childRows = await resolver(guard.apex, page);
	if (!childRows) return bffError(502, 'could not read list rows');
	return noStoreJson({ page, version, childRows });
}
