import type { Edytor } from '$lib/edytor.svelte.js';
import { isValidEdytorClipboardFragment } from './fragmentData.js';
import { insertBlockFragment } from './insertBlockFragment.js';
import { insertContentFragment } from './insertContentFragment.js';
import type { EdytorClipboardFragment } from './types.js';

export const insertEdytorClipboardFragment = async (
	edytor: Edytor,
	fragment: EdytorClipboardFragment
) => {
	if (!isValidEdytorClipboardFragment(fragment)) {
		return;
	}

	if (fragment.kind === 'content') {
		await insertContentFragment(edytor, fragment);
		return;
	}

	await insertBlockFragment(edytor, fragment);
};
