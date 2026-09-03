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
 * The response is `{ page, version }`: the browser edits a local draft of `page`,
 * and holds `version` as the baseline the stale guard compares against on Save. The
 * upstream `{ data: … }` envelope is unwrapped so the browser sees exactly the page.
 */
export const pageIdSchema = z
	.string()
	.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu);

/** Exported so the draft preview unwraps Apex's envelope the same way this route does. */
export function unwrapPage(body: unknown): Record<string, unknown> | null {
	if (body && typeof body === 'object') {
		const maybe = body as { data?: unknown };
		if (maybe.data && typeof maybe.data === 'object') return maybe.data as Record<string, unknown>;
		if ('id' in (body as object)) return body as Record<string, unknown>;
	}
	return null;
}

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

	const page = unwrapPage(apexResponse.body);
	if (!page) return bffError(502, 'unexpected upstream shape');

	const version = await computePageVersion(page);
	return noStoreJson({ page, version });
}
