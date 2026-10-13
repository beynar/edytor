/**
 * A press on the chrome keeps the focus where it is (the editor's caret, or
 * the menu's field): every press but one on a field, which takes its own.
 */
export const keepFocus = (event: MouseEvent) => {
	const target = event.target as HTMLElement | null;
	if (!target?.matches?.('input, textarea, select') && !target?.isContentEditable)
		event.preventDefault();
};
