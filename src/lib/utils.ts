let alphabet = 'useandom26T198340PX75pxJACKVERYMINDBUSHWOLFGQZbfghjklqvwyzrict';

export const id = (prefix: 't' | 'b' | 'i' | 'v' | 's') => {
	const e = 10;
	let t = '',
		r = crypto.getRandomValues(new Uint8Array(e));
	for (let n = 0; n < e; n++) t += alphabet[61 & r[n]];
	return `${prefix}_${t}`;
};

/**
 * A hook's veto as the dispatcher carries it: what `prevent(cb?)` recorded,
 * and the extension that recorded it. Hooks never see one thrown at them:
 * `prevent` records and returns. Throwing one from a hook (the
 * earlier form) still vetoes, for the transition.
 */
export class PreventionError extends Error {
	cb?: () => void;
	/** The extension whose hook prevented (set by the dispatcher). */
	by?: unknown;
	constructor(cb?: () => void) {
		super('Prevent');
		this.name = 'PreventionError';
		this.cb = cb;
	}
}

/** Whether `error` is a veto (a {@link PreventionError}). */
export const isPrevention = (error: unknown): error is PreventionError =>
	error instanceof PreventionError;

/** A hook's `prevent`: veto the gesture, and optionally run `cb` in its place. */
export type Prevent = (cb?: () => void) => void;

/**
 * Abort the enclosing prevention scope from the editor's own code (a
 * binding or hook of the core). Hooks receive a recording `prevent` instead
 * (`vetoable`).
 * @internal
 */
export const prevent = (cb?: () => void): void => {
	throw new PreventionError(cb);
};

/**
 * Call one hook with a recording `prevent`: the hook runs to its end, the
 * first `prevent` it calls decides (with its replacement), and that veto
 * then aborts the enclosing prevention scope, where the dispatcher catches
 * it (`session/commands.ts`). A hook that throws a `PreventionError`
 * itself vetoes the same way.
 * @internal
 */
export const vetoable = <R>(call: (prevent: Prevent) => R): R => {
	let veto: PreventionError | undefined;
	const out = call((cb) => void (veto ??= new PreventionError(cb)));
	if (veto) throw veto;
	return out;
};
