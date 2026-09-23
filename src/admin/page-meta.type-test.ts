import type { BffClient } from './types';
import type { AdminPageDraft } from './types';
import { setPageField, setPageMeta } from './page-draft.js';

/** types.ts:486 must admit every page SEO name accepted by update-page-seo.ts:17-23. */
export function pageMetaClientType(client: BffClient, pageId: string): void {
	void client.updatePageSeo?.(pageId, { title: 'x', keywords: 'y' });
}

/** The draft setters accept only their respective page and SEO field names. */
export function pageDraftFieldNameType(draft: AdminPageDraft): void {
	// @ts-expect-error An unknown page field must be rejected at the call site.
	setPageField(draft, 'nope', 5);
	// @ts-expect-error An unknown meta name must be rejected at the call site.
	setPageMeta(draft, 'titel', 5);
}
