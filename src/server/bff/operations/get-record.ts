import { bffError, noStoreJson } from '../boundary';
import { guardRequest } from '../guard';
import { archetypeIdSchema, readUpdatedAt, unwrapArchetypeRecord } from '../archetype-record';
import { summarizeRecord } from './record-shape';
import { loadReferenceTargets } from './list-records';
import { contractOf, noContractResponse } from '../content-contract-guard';
import type { BffContext } from '../context';

/**
 * GET /api/admin/records/[schema]/[recordId]         → `{ record, version, referenceTargets }`
 * GET /api/admin/records/[schema]/[recordId]/version → `{ version }`
 *
 * Both reads: no CSRF, full boundary + session guard.
 *
 * The two are separate operations on purpose, and the difference is cost. The load
 * carries the reference target collections the pickers need; the VERSION read is
 * called once immediately before every save by `saveEntity()`, so it does the
 * cheapest thing that answers "did this move?" and nothing else.
 *
 * The version token is the record's own `updated_at`. A content-library record is a
 * single record with no children — no blocks, no document, no status — so unlike a
 * page there is nothing to compose a hash out of, and unlike a post there is no
 * second or third record that could move underneath this one.
 */
export const recordIdSchema = archetypeIdSchema;

export async function handleGetRecord(
	request: Request,
	ctx: BffContext,
	params: { schema: string; recordId: string }
): Promise<Response> {
	const guard = await guardRequest(request, ctx, { mutation: false });
	if (!guard.ok) return guard.response;
	const contract = contractOf(ctx);
	if (!contract) return noContractResponse();

	if (!contract.isContentLibrarySlug(params.schema)) return bffError(404, 'unknown collection');
	const idResult = recordIdSchema.safeParse(params.recordId);
	if (!idResult.success) return bffError(400, 'invalid record id');

	const apexResponse = await guard.apex.getContentLibraryRecord(params.schema, idResult.data);
	// A deleted record reads 404 upstream, and forwarding it is what lets the screen
	// say "this no longer exists" instead of "something failed".
	if (apexResponse.status === 404) return bffError(404, 'not found');
	if (!apexResponse.ok) return bffError(502, 'upstream error');

	const record = unwrapArchetypeRecord(apexResponse.body);
	if (!record) return bffError(502, 'unexpected upstream shape');

	const targets = await loadReferenceTargets(contract, guard.apex, params.schema);
	if (!targets.ok) return bffError(502, 'upstream error');

	return noStoreJson({
		record: summarizeRecord(contract, params.schema, record),
		version: readUpdatedAt(record),
		referenceTargets: targets.targets
	});
}

export async function handleReadRecordVersion(
	request: Request,
	ctx: BffContext,
	params: { schema: string; recordId: string }
): Promise<Response> {
	const guard = await guardRequest(request, ctx, { mutation: false });
	if (!guard.ok) return guard.response;
	const contract = contractOf(ctx);
	if (!contract) return noContractResponse();

	if (!contract.isContentLibrarySlug(params.schema)) return bffError(404, 'unknown collection');
	const idResult = recordIdSchema.safeParse(params.recordId);
	if (!idResult.success) return bffError(400, 'invalid record id');

	const apexResponse = await guard.apex.getContentLibraryRecord(params.schema, idResult.data);
	if (apexResponse.status === 404) return bffError(404, 'not found');
	if (!apexResponse.ok) return bffError(502, 'upstream error');

	const record = unwrapArchetypeRecord(apexResponse.body);
	if (!record) return bffError(502, 'unexpected upstream shape');

	return noStoreJson({ version: readUpdatedAt(record) });
}
