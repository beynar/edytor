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
import { DEV } from 'esm-env';
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

type Chars<S extends string, Acc = never> = S extends `${infer C}${infer R}`
	? Chars<R, Acc | C>
	: Acc;
/** The one-character keys a chord names: `KeyboardEvent.key`, lower case. */
const CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789`~!@#$%^&*()-_=+[]{}\\|;:\'",.<>/?';
// prettier-ignore
const NAMED = ['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'tab', 'enter', 'backspace', 'delete', 'space', 'escape', 'home', 'end', 'pageup', 'pagedown', 'insert', 'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'f9', 'f10', 'f11', 'f12'] as const;
type Key = Chars<typeof CHARS> | (typeof NAMED)[number];
type Modifier = 'mod' | 'alt' | 'ctrl' | 'shift';
/** One to three distinct modifiers, in any order. */
type Modifiers = {
	[A in Modifier]:
		| A
		| {
				[B in Exclude<Modifier, A>]: `${A}+${B}` | `${A}+${B}+${Exclude<Modifier, A | B>}`;
		  }[Exclude<Modifier, A>];
}[Modifier];
/** A chord: a key, after up to three modifiers in any order (matched case-insensitively). */
export type HotKeyCombination = Key | `${Modifiers}+${Key}`;

const MODIFIERS = ['mod', 'alt', 'ctrl', 'shift'];
/** Every token a keydown's chord can carry (`chordOf`). */
const TOKENS = new Set<string>([...MODIFIERS, ...CHARS, ...NAMED]);

/** The canonical chord: lower case, modifiers in one order, then the key. */
const chord = (parts: string[]) => {
	const lower = parts.map((part) => part.toLowerCase());
	const key = lower.filter((part) => part && !MODIFIERS.includes(part));
	return [...MODIFIERS.filter((modifier) => lower.includes(modifier)), ...key].join('+');
};

/** US-layout keys and what Shift makes of them: a keydown reports the character typed. */
const [BASE, SHIFT] = ["`1234567890-=[]\\;',./", '~!@#$%^&*()_+{}|:"<>?'];
const SHIFTED = new Map([...BASE].map((base, index) => [base, SHIFT[index]!]));
/** Characters only Shift types (the numeric keypad types `+` and `*` unshifted). */
const TYPED_WITH_SHIFT = new Set([...SHIFTED.values()].filter((key) => !'+*'.includes(key)));

/**
 * Why a well-formed chord still never fires (a development hint), or null:
 * a character Shift types needs `shift` (`mod+shift+?`), Shift turns a key
 * into another character (`shift+/` arrives as `?`), and on macOS Option
 * with a character types text (`alt+b` is `∫`) unless `mod` or `ctrl` holds.
 */
const silent = (parts: string[]) => {
	const lower = parts.map((part) => part.toLowerCase());
	const key = lower.find((part) => !MODIFIERS.includes(part)) ?? '';
	const has = (modifier: string) => lower.includes(modifier);
	if (!has('shift') && TYPED_WITH_SHIFT.has(key))
		return `"${key}" is typed with Shift: bind "${chord([...lower, 'shift'])}"`;
	const shifted = SHIFTED.get(key);
	if (has('shift') && shifted)
		return `Shift turns "${key}" into "${shifted}": bind "${chord([...lower.filter((part) => part !== key), shifted])}"`;
	if (has('alt') && !has('mod') && !has('ctrl') && key.length === 1)
		return `on macOS, Option+${key} types a character; add mod`;
	return null;
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
				const parts = keys.split(/\+(?!$)/);
				const dead = parts.find((part) => !TOKENS.has(part.toLowerCase()));
				if (DEV && dead !== undefined)
					console.warn(
						`[edytor] hotkey "${keys}" never fires: "${dead}" is neither a modifier ` +
							'(mod, alt, ctrl, shift) nor a key name.'
					);
				const hint = DEV && dead === undefined && silent(parts);
				if (hint) console.warn(`[edytor] hotkey "${keys}" never fires: ${hint}.`);
				const at = chord(parts);
				this.table.set(at, [...(this.table.get(at) ?? []), binding as HotKey]);
			}
	}

	/**
	 * A keyboard event's chord: `mod` is Cmd on Apple and Ctrl elsewhere; on
	 * Apple bare Ctrl stays `ctrl` (the Emacs rows); a reverse tab is Shift+Tab;
	 * the space bar is `space`.
	 */
	chordOf = (event: KeyboardEvent, key = event.key === ' ' ? 'space' : event.key.toLowerCase()) => {
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
