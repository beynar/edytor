import type { EdytorSelection } from '$lib/events/onSelectionChange.js';

type TextDelta = { insert: string; attributes: Record<string, boolean> };
export const hasMarkAtSelection = (selection: EdytorSelection, mark: string) => {
	const texts = selection.yTextsInRanges;
	const start = selection.yStartIndex;
	const end = selection.yEndIndex;

	let offset = 0;
	const deltasInRangeHasMark: boolean[] = [];
	texts.forEach((yText) => {
		return yText.toDelta().forEach(({ insert, attributes }: TextDelta) => {
			const isDeltaInRange = offset + insert.length > start && offset < end;
			offset += insert.length;
			if (isDeltaInRange) {
				deltasInRangeHasMark.push(attributes?.[mark]);
			}
		});
	});

	return deltasInRangeHasMark.every((hasMark) => hasMark);
};
