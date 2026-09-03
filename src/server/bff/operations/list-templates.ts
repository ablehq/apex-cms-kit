import { bffError, noStoreJson } from '../boundary';
import { guardRequest } from '../guard';
import type { BffContext } from '../context';

/**
 * GET /api/admin/page-block-templates — the slug → id (+ backing entity type) map the
 * editor needs to add a section (plan §8, 3a). Adding a block requires the Apex
 * template id, which the committed field-def contract does not carry; this read
 * supplies it. Read-only, typed, one fixed Apex call — the same pattern as list-pages.
 * The browser gets a trimmed projection, never the raw upstream shape.
 */
interface RawTemplate {
	id?: unknown;
	slug?: unknown;
	name?: unknown;
	entity_type?: { id?: unknown } | null;
	entity_type_id?: unknown;
}

export async function handleListTemplates(request: Request, ctx: BffContext): Promise<Response> {
	const guard = await guardRequest(request, ctx, { mutation: false });
	if (!guard.ok) return guard.response;

	const apexResponse = await guard.apex.listPageBlockTemplates();
	if (!apexResponse.ok) return bffError(502, 'upstream error');

	const body = apexResponse.body;
	const rows: RawTemplate[] = Array.isArray(body)
		? (body as RawTemplate[])
		: body && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data)
			? (body as { data: RawTemplate[] }).data
			: [];

	const templates = rows
		.filter((row) => typeof row.slug === 'string' && typeof row.id === 'string')
		.map((row) => ({
			id: row.id as string,
			slug: row.slug as string,
			name: typeof row.name === 'string' ? row.name : (row.slug as string),
			entity_type_id:
				(row.entity_type && typeof row.entity_type.id === 'string' ? row.entity_type.id : null) ??
				(typeof row.entity_type_id === 'string' ? row.entity_type_id : null)
		}));

	return noStoreJson({ templates });
}
