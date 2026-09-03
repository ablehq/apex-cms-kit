import { bffError, noStoreJson } from '../boundary';
import { guardRequest } from '../guard';
import { unwrapArchetypeCollection } from '../archetype-record';
import { PAGE_SIZE, summarizeRecord } from './record-shape';
import type { AdminRecord } from './record-shape';
import type { ApexAdminClient } from '../apex-admin-client';
import type { ContentContract } from '../content-contract';
import { requireContract } from '../content-contract-guard';
import type { BffContext } from '../context';

/**
 * GET /api/admin/records/[schema] — one content-library collection.
 *
 * A read, so no CSRF, but the full boundary + session + Apex-token guard.
 *
 * None of Godrej's four content-library types has a status of any kind: no draft,
 * no publish, no archive. Everything in these collections is part of the next
 * deploy the moment it is saved, and the list screen says so where the status tabs
 * would be rather than implying a draft state that does not exist.
 *
 * ── WHY REFERENCE TARGETS RIDE ALONG ───────────────────────────────────────────
 * Apex does not inline a referenced record's display name — a reference arrives as
 * an id with `relatable_data: []` — so names are resolved by JOINING against the
 * target collection, which is what the public site already does. The list therefore
 * returns the target collections its own rows point at (`partner` → `focus_area`
 * today), so the Focus Areas column shows titles and the picker has its choices,
 * from one request rather than two that could disagree.
 */
export async function handleListRecords(
	request: Request,
	ctx: BffContext,
	params: { schema: string }
): Promise<Response> {
	const contract = requireContract(ctx);
	const guard = await guardRequest(request, ctx, { mutation: false });
	if (!guard.ok) return guard.response;

	if (!contract.isContentLibrarySlug(params.schema)) return bffError(404, 'unknown collection');
	const schema = contract.schema(params.schema);
	if (!schema) return bffError(404, 'unknown collection');

	const listed = await guard.apex.listContentLibrary(params.schema, {
		per_page: PAGE_SIZE,
		page: 1,
		'q[sorts][]': 'created_at desc'
	});
	if (!listed.ok) return bffError(502, 'upstream error');

	const records = unwrapArchetypeCollection(listed.body)
		.map((record) => summarizeRecord(contract, params.schema, record))
		.filter((record) => record.id.length > 0);

	const targets = await loadReferenceTargets(contract, guard.apex, params.schema);
	if (!targets.ok) return bffError(502, 'upstream error');

	return noStoreJson({ schema: params.schema, records, referenceTargets: targets.targets });
}

/**
 * Every collection this schema's references point at, keyed by target slug.
 *
 * Fails CLOSED: a target collection that will not read means the column and the
 * picker would silently show ids instead of names, which looks like data loss.
 */
export async function loadReferenceTargets(
	contract: ContentContract,
	apex: ApexAdminClient,
	slug: string
): Promise<{ ok: true; targets: Record<string, AdminRecord[]> } | { ok: false }> {
	const targets: Record<string, AdminRecord[]> = {};
	const wanted = new Set(contract.referenceItems(slug).map((item) => item.target_schema));
	for (const targetSlug of wanted) {
		// A post archetype is not readable on this surface, and none of the four P1
		// schemas references one — but a future schema could, and silently listing
		// nothing would be worse than skipping it visibly.
		if (!contract.isContentLibrarySlug(targetSlug)) continue;
		const listed = await apex.listContentLibrary(targetSlug, { per_page: PAGE_SIZE, page: 1 });
		if (!listed.ok) return { ok: false };
		targets[targetSlug] = unwrapArchetypeCollection(listed.body)
			.map((record) => summarizeRecord(contract, targetSlug, record))
			.filter((record) => record.id.length > 0);
	}
	return { ok: true, targets };
}
