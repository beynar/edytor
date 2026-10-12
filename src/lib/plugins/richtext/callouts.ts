/**
 * A callout's icon (`callout.icon` in the delete contract): its `data.icon`,
 * the view's default when it has none of its own, no icon when it is `''`.
 * The view's default is the first rich text plugin's; the icon picker is the
 * callout icons plugin's (`calloutIcons.svelte.ts`), when one is listed.
 */
import { escapeHtml } from '$lib/clipboard/serializeClipboardFragment.js';
import type { CalloutIconPicker } from './calloutIcons.svelte.js';

/** A new callout's icon unless `createRichTextPlugin({ callout: { icon } })` names another. */
export const DEFAULT_CALLOUT_ICON = '💡';

/** Each view's default callout icon (the first rich text plugin listed sets it). */
export const calloutIcons = new WeakMap<object, string>();

/** Each view's callout icon picker (the first callout icons plugin listed claims it). */
export const calloutPickers = new WeakMap<object, CalloutIconPicker>();

/** The icon a callout of `view` with `data` shows: its own (`''`: none), else the view's default. */
export const iconOf = (data: Record<string, unknown> | undefined, view?: object) =>
	typeof data?.icon === 'string'
		? data.icon
		: ((view && calloutIcons.get(view)) ?? DEFAULT_CALLOUT_ICON);

/**
 * A callout's HTML: a `div` naming its icon (`data-edytor-callout`), its
 * title, then its content. A generic tag: only its attribute claims it back
 * (`parse`), never a tag another kind may export.
 */
export const calloutHtml = (icon: string, content: string, children: string) =>
	`<div data-edytor-callout="${escapeHtml(icon)}"><p>${content}</p>${children}</div>`;
