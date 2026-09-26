import { describe, expect, it } from 'vitest';

import type { Edytor } from '$lib/edytor.svelte.js';
import { HotKeys, type HotKey } from '$lib/hotkeys.js';

/**
 * Pure `HotKeys.isHotkey`/`combination()` coverage — platform modifier
 * normalization and the non-Latin layout `event.code` fallback. No editor
 * instance is needed: handlers only exercise the prevent() contract.
 */

type KeydownInit = {
	key: string;
	code?: string;
	ctrlKey?: boolean;
	metaKey?: boolean;
	altKey?: boolean;
	shiftKey?: boolean;
	altGraph?: boolean;
};

const createKeydown = (init: KeydownInit): KeyboardEvent => {
	const event = {
		key: init.key,
		code: init.code ?? '',
		ctrlKey: init.ctrlKey ?? false,
		metaKey: init.metaKey ?? false,
		altKey: init.altKey ?? false,
		shiftKey: init.shiftKey ?? false,
		defaultPrevented: false,
		preventDefault() {
			this.defaultPrevented = true;
		},
		stopPropagation() {},
		getModifierState: (modifier: string) =>
			modifier === 'AltGraph' ? (init.altGraph ?? false) : false
	};
	return event as unknown as KeyboardEvent;
};

const initHotKeys = (bindings: Record<string, HotKey>, { isMac = false } = {}) => {
	const hotKeys = new HotKeys({} as Edytor, bindings, []);
	if (isMac) {
		Object.defineProperty(hotKeys, 'isMac', { configurable: true, get: () => true });
	}
	hotKeys.init();
	return hotKeys;
};

const handled = (calls: string[], name: string): HotKey => {
	return ({ prevent }) => prevent(() => calls.push(name));
};

const observed = (calls: string[], name: string): HotKey => {
	return () => {
		calls.push(name);
	};
};

describe('HotKeys platform modifier normalization', () => {
	it('matches mod bindings from metaKey and ctrlKey on non-Apple platforms', () => {
		const calls: string[] = [];
		const hotKeys = initHotKeys({ 'mod+b': handled(calls, 'bold') });

		expect(hotKeys.isHotkey(createKeydown({ key: 'b', code: 'KeyB', metaKey: true }))).toBe(true);
		expect(hotKeys.isHotkey(createKeydown({ key: 'b', code: 'KeyB', ctrlKey: true }))).toBe(true);
		expect(calls).toEqual(['bold', 'bold']);
	});

	it('keeps bare Ctrl distinct from Cmd on Apple platforms', () => {
		const calls: string[] = [];
		const hotKeys = initHotKeys(
			{
				'mod+b': handled(calls, 'mod+b'),
				'ctrl+b': handled(calls, 'ctrl+b')
			},
			{ isMac: true }
		);

		expect(hotKeys.isHotkey(createKeydown({ key: 'b', code: 'KeyB', metaKey: true }))).toBe(true);
		expect(calls).toEqual(['mod+b']);

		calls.length = 0;
		expect(hotKeys.isHotkey(createKeydown({ key: 'b', code: 'KeyB', ctrlKey: true }))).toBe(true);
		expect(calls).toEqual(['ctrl+b']);
	});

	it('emits mod+ctrl when Cmd and Ctrl are both held on Apple platforms', () => {
		const calls: string[] = [];
		const hotKeys = initHotKeys({ 'mod+ctrl+x': handled(calls, 'mod+ctrl+x') }, { isMac: true });

		expect(
			hotKeys.isHotkey(createKeydown({ key: 'x', code: 'KeyX', metaKey: true, ctrlKey: true }))
		).toBe(true);
		expect(calls).toEqual(['mod+ctrl+x']);
	});

	it('keeps metaKey folded into mod on non-Apple platforms', () => {
		const calls: string[] = [];
		const hotKeys = initHotKeys({ 'mod+x': handled(calls, 'mod+x') });

		expect(
			hotKeys.isHotkey(createKeydown({ key: 'x', code: 'KeyX', metaKey: true, ctrlKey: true }))
		).toBe(true);
		expect(calls).toEqual(['mod+x']);
	});
});

describe('HotKeys non-Latin layout fallback', () => {
	it('matches a mod binding through event.code when the layout reports a Cyrillic key', () => {
		const calls: string[] = [];
		const hotKeys = initHotKeys({ 'mod+b': handled(calls, 'bold') });

		expect(hotKeys.isHotkey(createKeydown({ key: 'в', code: 'KeyB', metaKey: true }))).toBe(true);
		expect(hotKeys.isHotkey(createKeydown({ key: 'в', code: 'KeyB', ctrlKey: true }))).toBe(true);
		expect(calls).toEqual(['bold', 'bold']);
	});

	it('applies the fallback across other held modifiers', () => {
		const calls: string[] = [];
		const hotKeys = initHotKeys({ 'mod+shift+o': handled(calls, 'mod+shift+o') });

		expect(
			hotKeys.isHotkey(createKeydown({ key: 'Щ', code: 'KeyO', ctrlKey: true, shiftKey: true }))
		).toBe(true);
		expect(calls).toEqual(['mod+shift+o']);
	});

	it('does not fall back for modifier-less non-ASCII keypresses', () => {
		const calls: string[] = [];
		const hotKeys = initHotKeys({ 'mod+b': handled(calls, 'bold'), b: handled(calls, 'b') });

		expect(hotKeys.isHotkey(createKeydown({ key: 'б', code: 'KeyB' }))).toBe(false);
		expect(calls).toEqual([]);
	});

	it('does not fall back when AltGr is reported through getModifierState', () => {
		const calls: string[] = [];
		const hotKeys = initHotKeys({ 'mod+alt+q': handled(calls, 'mod+alt+q') });

		expect(
			hotKeys.isHotkey(
				createKeydown({ key: '@', code: 'KeyQ', ctrlKey: true, altKey: true, altGraph: true })
			)
		).toBe(false);
		expect(calls).toEqual([]);
	});

	it('does not fall back for ctrl+alt keydowns (Windows AltGr)', () => {
		const calls: string[] = [];
		const hotKeys = initHotKeys({ 'mod+alt+q': handled(calls, 'mod+alt+q') });

		expect(
			hotKeys.isHotkey(createKeydown({ key: '@', code: 'KeyQ', ctrlKey: true, altKey: true }))
		).toBe(false);
		expect(calls).toEqual([]);
	});

	it('prefers a direct non-ASCII binding over the code fallback', () => {
		const calls: string[] = [];
		const hotKeys = initHotKeys({
			'mod+в': handled(calls, 'mod+в'),
			'mod+b': handled(calls, 'mod+b')
		});

		expect(hotKeys.isHotkey(createKeydown({ key: 'в', code: 'KeyB', metaKey: true }))).toBe(true);
		expect(calls).toEqual(['mod+в']);
	});

	it('still tries the fallback when a direct binding ran without preventing', () => {
		const calls: string[] = [];
		const hotKeys = initHotKeys({
			'mod+в': observed(calls, 'mod+в'),
			'mod+b': handled(calls, 'mod+b')
		});

		expect(hotKeys.isHotkey(createKeydown({ key: 'в', code: 'KeyB', metaKey: true }))).toBe(true);
		expect(calls).toEqual(['mod+в', 'mod+b']);
	});

	it('does not reinterpret ASCII keys through event.code (Dvorak safety)', () => {
		const calls: string[] = [];
		const hotKeys = initHotKeys({
			'mod+b': handled(calls, 'mod+b'),
			'mod+n': handled(calls, 'mod+n')
		});

		// On a Dvorak layout the physical KeyN position produces `b`.
		expect(hotKeys.isHotkey(createKeydown({ key: 'b', code: 'KeyN', metaKey: true }))).toBe(true);
		expect(calls).toEqual(['mod+b']);
	});

	it('does not resolve unknown event.code values', () => {
		const calls: string[] = [];
		const hotKeys = initHotKeys({ 'mod+j': handled(calls, 'mod+j') });

		expect(hotKeys.isHotkey(createKeydown({ key: 'ж', code: 'Semicolon', metaKey: true }))).toBe(
			false
		);
		expect(calls).toEqual([]);
	});
});
