import type { BffContext } from './context';
import type { ContentContract } from './content-contract';

/**
 * The record operations are generic over a site's content model, so they cannot run
 * without one. A deployment that reaches them with no `ctx.contract` is misconfigured,
 * not merely empty — it throws here rather than answering as though the site had no
 * schemas, which would read as "this record has nothing pointing at it".
 */
export function requireContract(ctx: BffContext): ContentContract {
	if (!ctx.contract) throw new Error('no content contract on the request context');
	return ctx.contract;
}
