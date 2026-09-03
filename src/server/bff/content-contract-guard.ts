import { bffError } from './boundary';
import type { BffContext } from './context';
import type { ContentContract } from './content-contract';

/**
 * The record operations are generic over a site's content model, so they cannot run
 * without one. A deployment that reaches them with no `ctx.contract` is
 * misconfigured — but it is answered AFTER the guard, as a JSON 500, so an
 * unauthenticated or cross-origin request still gets the boundary's refusal rather
 * than a framework error page that says more than it should.
 */
export function contractOf(ctx: BffContext): ContentContract | null {
	return ctx.contract ?? null;
}

export function noContractResponse(): Response {
	return bffError(500, 'content contract not configured');
}
