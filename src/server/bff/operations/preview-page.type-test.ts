/**
 * Compile-only GLC call-site probe. preview-page.ts:141 and :255 must keep the
 * fourth argument's contextual `messages` parameters and the adapter's matching
 * options type, or this site's unchanged loader would stop compiling on repin.
 */
import { glcPagePreviewAdapter, loadPagePreview } from './preview-page';
import type { PartitionRenderableBlocks } from './preview-page';
import type { BffContext } from '../context';

export function typecheckGlcPreviewCall(
	request: Request,
	ctx: BffContext,
	pageId: string,
	partitionRenderableBlocks: PartitionRenderableBlocks
) {
	return {
		load: loadPagePreview(
			request,
			ctx,
			{ pageId },
			{
				partitionRenderableBlocks,
				messages: (collections, blocks) => {
					const videos: unknown[] = collections.youtube_videos;
					return [videos, blocks.map((block) => block)];
				}
			}
		),
		adapter: glcPagePreviewAdapter({
			partitionRenderableBlocks,
			messages: (collections, blocks) => {
				const videos: unknown[] = collections.youtube_videos;
				return [videos, blocks.map((block) => block)];
			}
		})
	};
}
