import type { BffClient } from './types';

/** types.ts:486 must admit every page SEO name accepted by update-page-seo.ts:17-23. */
export function pageMetaClientType(client: BffClient, pageId: string): void {
	void client.updatePageSeo?.(pageId, { title: 'x', keywords: 'y' });
}
