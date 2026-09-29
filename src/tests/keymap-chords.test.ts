import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Edytor } from '$lib/edytor.svelte.js';
import { Keymap, type HotKey } from '$lib/session/keymap.js';
import { Dispatcher } from '$lib/session/commands.js';

/**
 * UW-26 (adversarial review 2026-09-29): a chord token that no keydown can
 * produce (`cmd`, `esc`, `return`…) is reported in development and never
 * runs; the documented tokens (`mod`, `alt`, `ctrl`, `shift`, and a key
 * `KeyboardEvent.key` names, any case, modifiers in any order) stay silent.
 */

afterEach(() => vi.restoreAllMocks());

const keymap = (bindings: Record<string, HotKey>) => {
	const edytor = {} as { dispatcher: Dispatcher };
	edytor.dispatcher = new Dispatcher(edytor as unknown as Edytor);
	return new Keymap(edytor as unknown as Edytor, bindings, []);
};

const keydown = (init: Partial<KeyboardEvent> & { key: string }) =>
	({
		code: '',
		ctrlKey: false,
		metaKey: false,
		altKey: false,
		shiftKey: false,
		preventDefault() {},
		stopPropagation() {},
		getModifierState: () => false,
		...init
	}) as unknown as KeyboardEvent;

describe('Keymap chord tokens', () => {
	it('a cmd+s binding warns and a Cmd/Ctrl+S keydown does not run it', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const calls: string[] = [];
		const map = keymap({ 'cmd+s': ({ prevent }) => prevent(() => calls.push('save')) });
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]![0])).toContain('"cmd+s"');
		expect(map.handle(keydown({ key: 's', metaKey: true }))).toBe(false);
		expect(map.handle(keydown({ key: 's', ctrlKey: true }))).toBe(false);
		expect(calls).toEqual([]);
	});

	it('every dead alias warns once per chord', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const dead = ['command+k', 'meta+k', 'option+k', 'esc', 'return', 'del', 'mod+up', 'down'];
		keymap(Object.fromEntries(dead.map((chord) => [chord, () => {}])));
		expect(warn).toHaveBeenCalledTimes(dead.length);
	});

	it('documented chords stay silent: any case, any modifier order, punctuation keys', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const calls: string[] = [];
		const map = keymap({
			'Shift+Alt+Mod+X': ({ prevent }) => prevent(() => calls.push('x')),
			'mod+/': () => {},
			'mod++': () => {},
			'alt+arrowup': () => {},
			escape: () => {},
			'mod+shift+enter': () => {},
			f2: () => {}
		});
		expect(warn).not.toHaveBeenCalled();
		expect(map.handle(keydown({ key: 'X', ctrlKey: true, altKey: true, shiftKey: true }))).toBe(
			true
		);
		expect(calls).toEqual(['x']);
	});
});
