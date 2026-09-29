/** A menu row's action: the keyboard's row (`isSelected`) scrolls into view. */
export const keepInView = (node: HTMLElement, isSelected: boolean) => {
	const reveal = (value: boolean) => value && node.scrollIntoView?.({ block: 'nearest' });
	reveal(isSelected);
	return { update: reveal };
};
