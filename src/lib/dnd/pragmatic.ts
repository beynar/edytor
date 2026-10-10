// Atlassian's Pragmatic drag and drop, forked in `vendor/pragmatic` (its own
// ES2019 build, `UPSTREAM.md`): the element adapter, the custom native drag
// preview, the list-item hitbox and the element auto-scroll, all on one core,
// so the auto-scroll's monitor sees the drags this adapter starts.
export {
	draggable,
	dropTargetForElements
} from './vendor/pragmatic/pragmatic-drag-and-drop/entry-point/element/adapter.js';
export type { ElementDropTargetEventPayloadMap } from './vendor/pragmatic/pragmatic-drag-and-drop/entry-point/element/adapter.js';
export { setCustomNativeDragPreview } from './vendor/pragmatic/pragmatic-drag-and-drop/entry-point/element/set-custom-native-drag-preview.js';
/** The list-item hitbox (reorder-before / reorder-after / combine, each available, not-available or blocked). */
export {
	attachInstruction,
	extractInstruction,
	type Availability,
	type Instruction
} from './vendor/pragmatic/pragmatic-drag-and-drop-hitbox/list-item.js';
export {
	autoScrollForElements as autoScroll,
	autoScrollWindowForElements as autoScrollWindow
} from './vendor/pragmatic/pragmatic-drag-and-drop-auto-scroll/entry-point/element.js';
