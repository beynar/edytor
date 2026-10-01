import type * as ElementAdapter from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import type * as CustomPreview from '@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview';
import type * as ListItem from '@atlaskit/pragmatic-drag-and-drop-hitbox/list-item';
import type * as AutoScroll from '@atlaskit/pragmatic-drag-and-drop-auto-scroll/element';

// Atlassian's typed directory entry points are not loadable by Node ESM after
// SvelteKit externalizes them for SSR. Their published CommonJS files are
// loadable there; reconnect that runtime to the public declarations here.
// @ts-expect-error The published CommonJS entry has no adjacent declaration.
import * as adapterRuntime from '@atlaskit/pragmatic-drag-and-drop/dist/cjs/entry-point/element/adapter.js';
// @ts-expect-error The published CommonJS entry has no adjacent declaration.
import * as previewRuntime from '@atlaskit/pragmatic-drag-and-drop/dist/cjs/entry-point/element/set-custom-native-drag-preview.js';
// @ts-expect-error The published CommonJS entry has no adjacent declaration.
import * as listItemRuntime from '@atlaskit/pragmatic-drag-and-drop-hitbox/dist/cjs/list-item.js';
// @ts-expect-error The published CommonJS module has no adjacent declaration.
import * as autoScrollRuntime from '@atlaskit/pragmatic-drag-and-drop-auto-scroll/dist/cjs/over-element/make-api.js';

const adapter = adapterRuntime as typeof ElementAdapter;

export const { draggable, dropTargetForElements } = adapter;
export const { setCustomNativeDragPreview } = previewRuntime as typeof CustomPreview;
/** The list-item hitbox (reorder-before / reorder-after / combine, each available, not-available or blocked). */
export const { attachInstruction, extractInstruction } = listItemRuntime as typeof ListItem;
export type { Availability, Instruction } from '@atlaskit/pragmatic-drag-and-drop-hitbox/list-item';
type AutoScrollApi = {
	autoScroll: typeof AutoScroll.autoScrollForElements;
	autoScrollWindow: typeof AutoScroll.autoScrollWindowForElements;
};
let autoScrollApiOf: AutoScrollApi | undefined;
/**
 * Atlassian's auto-scroll for element drags (registered scroll containers, and
 * the window), bound to this module's adapter. The package's own element entry
 * binds it to the core required by its bare path, which a browser bundle
 * resolves to the core's ES build: a second adapter whose monitor never sees
 * the drags this adapter starts, so nothing would scroll. Created on first use:
 * creating it registers a monitor whose frame loop runs on every element drag.
 */
export const autoScrollApi = (): AutoScrollApi =>
	(autoScrollApiOf ??= (
		autoScrollRuntime.makeApi as (args: {
			monitor: typeof adapter.monitorForElements;
		}) => AutoScrollApi
	)({ monitor: adapter.monitorForElements }));
