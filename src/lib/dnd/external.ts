// Pragmatic drag and drop's external adapter (vendored with the element
// adapter, on its core, `vendor/pragmatic/UPSTREAM.md`): drags that start
// outside the window (files from the desktop). Only the media plugins that
// take an upload import it (`plugins/fileDrop.ts`), so a view without them
// ships none of it.
import {
	autoScrollForExternal,
	autoScrollWindowForExternal
} from './vendor/pragmatic/pragmatic-drag-and-drop-auto-scroll/entry-point/external.js';
import type { Scrollers } from './autoScroll.js';

export { dropTargetForExternal } from './vendor/pragmatic/pragmatic-drag-and-drop/adapter/drop-target-for-external.js';
export { containsFiles } from './vendor/pragmatic/pragmatic-drag-and-drop/public-utils/external/contains-files.js';
export { getFiles } from './vendor/pragmatic/pragmatic-drag-and-drop/public-utils/external/get-files.js';

/** The external adapter's auto-scroll, while `ours()` (the drag is over this editor). */
export const externalScrollers = (ours: () => boolean): Scrollers => {
	const canScroll = () => ours();
	return {
		window: () => autoScrollWindowForExternal({ canScroll }),
		element: (element) => autoScrollForExternal({ element, canScroll })
	};
};
