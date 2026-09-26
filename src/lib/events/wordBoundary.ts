/**
 * One semantic rule for word boundaries, shared by caret word jumps
 * (hotkeys/navigation.ts) and word deletion (beforeInputDeleteCommands.ts):
 * a word is a run of Unicode letters, numbers, or `_`; whitespace and
 * punctuation are boundaries. When no word run remains in the direction,
 * the boundary is the boundary run's far edge — a trailing `· ` is still
 * consumed to the text end, matching platform word-delete. Offsets are
 * UTF-16 — `getCharacters` iterates code points so a surrogate pair counts
 * as one character but keeps its two-unit width.
 *
 * The rule is deliberately text-local: callers decide the scope
 * (navigation traverses across texts/blocks, word deletion clamps to the
 * current Text).
 */
const getCharacters = (value: string) => {
	let index = 0;
	return Array.from(value).map((character) => {
		const start = index;
		index += character.length;
		return {
			character,
			start,
			end: index
		};
	});
};

const isWordCharacter = (character: string) => /[\p{L}\p{N}_]/u.test(character);

export const getPreviousWordStartOffset = (value: string, offset: number) => {
	const characters = getCharacters(value).filter((character) => character.end <= offset);
	let index = characters.length - 1;

	while (index >= 0 && !isWordCharacter(characters[index].character)) {
		index--;
	}
	if (index < 0) {
		// Only a boundary run precedes the caret — its far edge is still
		// a boundary (a leading punctuation/space run is consumable, not
		// a stand-still).
		return characters[0]?.start ?? offset;
	}

	while (index > 0 && isWordCharacter(characters[index - 1].character)) {
		index--;
	}

	return characters[index].start;
};

export const getNextWordEndOffset = (value: string, offset: number) => {
	const characters = getCharacters(value).filter((character) => character.start >= offset);
	let index = 0;

	while (index < characters.length && !isWordCharacter(characters[index].character)) {
		index++;
	}
	if (index >= characters.length) {
		return characters.at(-1)?.end ?? offset;
	}

	while (index + 1 < characters.length && isWordCharacter(characters[index + 1].character)) {
		index++;
	}

	return characters[index].end;
};
