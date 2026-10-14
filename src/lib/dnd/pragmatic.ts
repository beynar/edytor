// Atlassian's Pragmatic drag and drop, forked in `vendor/pragmatic` (its own
// ES2019 build, `UPSTREAM.md`): the element adapter, the custom native drag
// preview and the element auto-scroll, all on one core,
// so the auto-scroll's monitor sees the drags this adapter starts. The
// external adapter (files dragged from outside) is `external.ts`'s, loaded
// only by the media plugins that take an upload.
import {
	autoScrollForElements,
	autoScrollWindowForElements
} from './vendor/pragmatic/pragmatic-drag-and-drop-auto-scroll/entry-point/element.js';
import type { Scrollers } from './autoScroll.js';

export {
	draggable,
	dropTargetForElements
} from './vendor/pragmatic/pragmatic-drag-and-drop/entry-point/element/adapter.js';
export type { ElementDropTargetEventPayloadMap } from './vendor/pragmatic/pragmatic-drag-and-drop/entry-point/element/adapter.js';
export { setCustomNativeDragPreview } from './vendor/pragmatic/pragmatic-drag-and-drop/entry-point/element/set-custom-native-drag-preview.js';

/** The element adapter's auto-scroll, for the drags whose data `ours` says are this editor's. */
export const elementScrollers = (
	ours: (data: Record<string | symbol, unknown>) => boolean
): Scrollers => {
	const canScroll = ({ source }: { source: { data: Record<string | symbol, unknown> } }) =>
		ours(source.data);
	return {
		window: () => autoScrollWindowForElements({ canScroll }),
		element: (element) => autoScrollForElements({ element, canScroll })
	};
};
