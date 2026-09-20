import type { Edytor } from '$lib/edytor.svelte.js';
import type { Text } from '$lib/text/text.svelte.js';

export const setSuppressedInputRepairSelectionTarget = (
	edytor: Edytor,
	text: Text,
	offset: number
) => {
	if (!edytor.shouldSuppressNextInputFallback && !edytor.shouldRepairSuppressedInputFallback) {
		return;
	}

	edytor.suppressedInputRepairSelectionTarget = {
		text,
		offset
	};
};
