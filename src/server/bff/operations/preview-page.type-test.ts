/**
 * Compile-only GLC call-site probe. preview-page.ts:141 and :255 must keep the
 * fourth argument's contextual `messages` parameters and the adapter's matching
 * options type, or this site's unchanged loader would stop compiling on repin.
 */
import { glcPagePreviewAdapter, loadPagePreview } from './preview-page';
import type { GlcPreviewOptions, PartitionRenderableBlocks } from './preview-page';
import type { BffContext } from '../context';

export function typecheckGlcPreviewCall(
	request: Request,
	ctx: BffContext,
	pageId: string,
	partitionRenderableBlocks: PartitionRenderableBlocks
) {
	const options: GlcPreviewOptions = {
		partitionRenderableBlocks,
		siteTitle: 'GLC',
		messages: (collections, blocks) => {
			const videos = collections.youtube_videos as never;
			return [videos, blocks];
		}
	};
	return {
		load: loadPagePreview(request, ctx, { pageId }, options),
		adapter: glcPagePreviewAdapter(options)
	};
}
