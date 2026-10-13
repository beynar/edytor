/**
 * A page part's popover (the cover menu, the icon picker, a property's
 * options): it takes the focus when it opens, and Escape or a press outside
 * it closes it.
 */
import type { Attachment } from 'svelte/attachments';

export const popover =
	(close: () => void): Attachment<HTMLElement> =>
	(node) => {
		const first = node.querySelector<HTMLElement>('input, button, [tabindex]:not([tabindex="-1"])');
		first?.focus();
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') return;
			event.preventDefault();
			event.stopPropagation();
			close();
		};
		const onPress = (event: PointerEvent) => {
			// A press on a toggle (`aria-expanded`) is the toggle's own.
			const target = event.target as Element | null;
			if (target && !node.contains(target) && !target.closest?.('[aria-expanded]')) close();
		};
		node.addEventListener('keydown', onKey);
		const view = node.ownerDocument.defaultView;
		view?.addEventListener('pointerdown', onPress, true);
		return () => {
			node.removeEventListener('keydown', onKey);
			view?.removeEventListener('pointerdown', onPress, true);
		};
	};

/** Read a picked file through `upload`; `null` when it fails. */
export const uploadFile = async (
	upload: (file: File, report: { progress(fraction: number): void }) => Promise<string>,
	file: File
): Promise<string | null> => {
	try {
		return await upload(file, { progress: () => {} });
	} catch (error) {
		console.error('[edytor/starter] upload failed', error);
		return null;
	}
};

/** An `http(s):` or `data:image/` URL a user typed, else `null`. */
export const imageUrl = (text: string): string | null => {
	const value = text.trim();
	if (/^data:image\//i.test(value)) return value;
	try {
		const url = new URL(value);
		return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
	} catch {
		return null;
	}
};
