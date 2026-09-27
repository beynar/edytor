/**
 * The keymap (R7, O36, §4.3 `session/keymap`): one registry of key bindings,
 * one canonical chord encoding and one precedence rule — the consumer's
 * bindings, then each extension's in list order, then the built-in rows
 * (`session/bindings`). Every binding of a chord runs in that order until one
 * claims it (`prevent`, caught once by the dispatcher's scope); a claim ends
 * the key and suppresses the platform default. Any other error surfaces.
 *
 * One keyboard occurrence is offered once: its keydown offers its chord, and
 * the `beforeinput` that follows it (or the keydown's structural fallback)
 * reaches the bindings only when no keydown offered that chord — an Android
 * `Unidentified` keydown, a virtual keyboard.
 */
import type { Edytor, EdytorOptions } from '$lib/edytor.svelte.js';
import type { InitializedPlugin } from '$lib/plugins.js';
import { prevent } from '$lib/utils.js';
import { builtInBindings } from './bindings.js';

export type HotKey = (payload: {
	/** The keydown; absent when only the key's input intent arrived (a `beforeinput`). */
	event?: KeyboardEvent;
	edytor: Edytor;
	prevent: (cb?: () => void) => void;
}) => void;

type Chars<S extends string> = S extends `${infer C}${infer R}` ? C | Chars<R> : never;
// prettier-ignore
type Key = Chars<'abcdefghijklmnopqrstuvwxyz'> | `arrow${'up' | 'down' | 'left' | 'right'}` | 'tab' | 'enter' | 'backspace' | 'delete' | 'space' | 'escape' | 'home' | 'end' | 'pageup' | 'pagedown';
// prettier-ignore
type Modifiers = 'mod' | 'alt' | 'ctrl' | 'shift' | 'mod+alt' | 'mod+ctrl' | 'mod+shift' | 'alt+ctrl' | 'alt+shift' | 'ctrl+shift';
export type HotKeyCombination = Key | `${Modifiers}+${Key}`;

const MODIFIERS = ['mod', 'alt', 'ctrl', 'shift'];

/** The canonical chord: lower case, modifiers in one order, then the key. */
const chord = (parts: string[]) => {
	const lower = parts.map((part) => part.toLowerCase());
	const key = lower.filter((part) => part && !MODIFIERS.includes(part));
	return [...MODIFIERS.filter((modifier) => lower.includes(modifier)), ...key].join('+');
};

/** AltGr (Windows Ctrl+Alt, `AltGraph`) and dead keys compose text: never a binding. */
const composesText = (event: KeyboardEvent) =>
	event.key === 'AltGraph' || event.key === 'Dead' || event.getModifierState?.('AltGraph') === true;

/**
 * Non-Latin layouts: a command chord whose produced key is non-ASCII retries
 * with the US-layout key of its physical `event.code` (Mod+Б is Mod+B). ASCII
 * keys keep the produced letter (Dvorak), modifier-less keys are text, and
 * Ctrl+Alt is AltGr.
 */
const layoutKey = (event: KeyboardEvent) => {
	if (event.key.length !== 1 || event.key.charCodeAt(0) < 128) return null;
	if (!(event.ctrlKey || event.metaKey) || (event.ctrlKey && event.altKey)) return null;
	return /^(Key[A-Z]|Digit\d)$/.test(event.code) ? event.code.at(-1)!.toLowerCase() : null;
};

export class Keymap {
	/** chord → bindings in precedence order. */
	private table = new Map<string, HotKey[]>();
	/** The chord the last keydown offered and nobody claimed, until the next `beforeinput`. */
	offered: string | null = null;

	get isMac() {
		return typeof window != 'undefined' && /Mac|iPod|iPhone|iPad/.test(window.navigator.platform);
	}

	constructor(
		private edytor: Edytor,
		consumer: EdytorOptions['hotKeys'] = {},
		plugins: InitializedPlugin[] = []
	) {
		for (const rows of [
			consumer,
			...plugins.map((plugin) => plugin.hotkeys ?? {}),
			builtInBindings
		])
			for (const [keys, binding] of Object.entries(rows ?? {})) {
				const at = chord(keys.split(/\+(?!$)/));
				this.table.set(at, [...(this.table.get(at) ?? []), binding as HotKey]);
			}
	}

	/**
	 * A keyboard event's chord: `mod` is Cmd on Apple and Ctrl elsewhere; on
	 * Apple bare Ctrl stays `ctrl` (the Emacs rows); a reverse tab is Shift+Tab.
	 */
	chordOf = (event: KeyboardEvent, key = event.key.toLowerCase()) => {
		const back = key === 'iso_left_tab' || key === 'backtab';
		const mac = this.isMac;
		return chord([
			event.metaKey || (event.ctrlKey && !mac) ? 'mod' : '',
			event.altKey ? 'alt' : '',
			event.ctrlKey && mac ? 'ctrl' : '',
			event.shiftKey || back ? 'shift' : '',
			back ? 'tab' : key === 'shift' ? '' : key
		]);
	};

	/** Offer a keydown to its bindings (the produced key first, then the layout key). */
	handle = (event: KeyboardEvent): boolean => {
		if (composesText(event)) return false;
		const fallback = layoutKey(event);
		const chords = [this.chordOf(event), ...(fallback ? [this.chordOf(event, fallback)] : [])];
		this.offered = chords[0]!;
		const claimed = chords.some((at) => this.run(at, event));
		if (claimed) this.offered = null;
		return claimed;
	};

	/** Run `chord`'s bindings in precedence order until one claims it. */
	run = (chord: string, event?: KeyboardEvent): boolean => {
		const bindings = this.table.get(chord);
		let claimed = false;
		if (bindings)
			this.edytor.dispatcher.scope(
				() => bindings.forEach((binding) => binding({ event, edytor: this.edytor, prevent })),
				() => {
					claimed = true;
					event?.preventDefault();
					event?.stopPropagation();
				}
			);
		return claimed;
	};
}
