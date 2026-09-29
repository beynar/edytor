/**
 * API low (rescore, `session/keymap.ts`) — chords that type-check but never
 * fire warn in development, naming the chord:
 * - a shifted character without `shift` (`mod+?`: the keydown is `mod+shift+?`;
 *   `+` and `*` are exempt, the numeric keypad types them unshifted);
 * - `shift` with the key's unshifted form (`shift+/`: the keydown's key is `?`);
 * - `alt` with a character and no `mod`/`ctrl` (`alt+b`: macOS Option types `∫`).
 * Chords that do fire stay silent.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Edytor } from '$lib/edytor.svelte.js';
import { Keymap, type HotKeyCombination } from '$lib/session/keymap.js';

afterEach(() => vi.restoreAllMocks());

const warnings = (chords: HotKeyCombination[]) => {
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
	new Keymap({} as Edytor, Object.fromEntries(chords.map((at) => [at, () => {}])), []);
	return warn.mock.calls.map(([message]) => String(message));
};

describe('chords that never fire warn in development', () => {
	for (const at of [
		'mod+?',
		'?',
		'ctrl+!',
		'shift+/',
		'mod+shift+1',
		'shift+[',
		'alt+b',
		'alt+shift+k',
		'alt+/'
	] as HotKeyCombination[])
		it(`warns for "${at}"`, () => {
			const found = warnings([at]).filter((message) => message.includes(`"${at}"`));
			expect(found).toHaveLength(1);
			expect(found[0]).toContain('never fires');
		});

	it('stays silent for chords that fire', () => {
		const firing: HotKeyCombination[] = [
			'mod+/',
			'mod+shift+?',
			'shift+?',
			'mod+shift+z',
			'mod+alt+1',
			'mod+alt+b',
			'ctrl+alt+b',
			'alt+arrowup',
			'shift+enter',
			'mod+[',
			'/',
			// The numeric keypad types these without Shift.
			'mod++',
			'mod+*'
		];
		const found = warnings(firing).filter((message) =>
			firing.some((at) => message.includes(`"${at}"`))
		);
		expect(found).toEqual([]);
	});
});
