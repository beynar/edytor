import type * as ElementAdapter from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import type * as CustomPreview from '@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview';

// Atlassian's typed directory entry point is not loadable by Node ESM after
// SvelteKit externalizes it for SSR. Its published CommonJS file is loadable
// there; reconnect that runtime to the public declaration at this boundary.
// @ts-expect-error The published CommonJS entry has no adjacent declaration.
import * as adapterRuntime from '@atlaskit/pragmatic-drag-and-drop/dist/cjs/entry-point/element/adapter.js';
// @ts-expect-error The published CommonJS entry has no adjacent declaration.
import * as previewRuntime from '@atlaskit/pragmatic-drag-and-drop/dist/cjs/entry-point/element/set-custom-native-drag-preview.js';

const adapter = adapterRuntime as typeof ElementAdapter;

export const { draggable, dropTargetForElements } = adapter;
export const { setCustomNativeDragPreview } = previewRuntime as typeof CustomPreview;
