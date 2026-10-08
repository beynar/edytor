/**
 * What the session asks of the rest of the view. The session is DOM-free
 * and never value-imports the surface (`surface/`, `events/`,
 * `components/`, the DOM selection) or the composition root
 * (`edytor/context-imports` in eslint.config.js, `scripts/deps.mjs`): it
 * declares here the calls it makes, and the composition root (`Edytor`)
 * implements them over the projector, the observer, the DOM selection and
 * the input commands (`edytor.ports`).
 */
import type { Text } from '$lib/text/text.svelte.js';
import type { Attempt } from './attempt.js';

/** The surface as the session sees it: the projector, the observer, the DOM selection. */
export interface SurfacePort {
	/**
	 * Park the DOM caret where a composition over a block or atom selection
	 * writes, before the IME does (the projector's `park`, its one write
	 * under a live composition).
	 */
	park(text: Text, offset: number): void;
	/** Run the observer's compare pass now, after a composition ends (`surface.flush`). */
	flush(): void;
	/** The host holds a DOM caret a gesture may have placed, not the browser's parked one (`projector.placed`). */
	placed(): boolean;
	/** An atom took a press: the caret the browser parks for it is its own, not a target (`projector.parked`). */
	parked(): void;
	/** Clear the host's DOM selection (an atom selection shows none). */
	clear(): void;
	/** The mounted text and display offset a DOM point stands in, or `null`. */
	pointAt(node: Node, offset: number): { text: Text; offset: number } | null;
}

/** The input commands a key binding runs (`events/beforeInputCommands.ts`). */
export interface InputPort {
	/** An editing intent at the current selection, as one user command (`runIntent`). */
	runIntent(inputType: string): void;
	/** A soft break; the caret after it, or before it (Emacs open-line). */
	insertLineBreak(snapshot: Attempt, caret?: 'after' | 'before'): void;
}

/** The ports the composition root hands the session (`edytor.ports`). */
export type SessionPorts = {
	readonly surface: SurfacePort;
	readonly input: InputPort;
};
