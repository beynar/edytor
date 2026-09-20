/**
 * Compatibility surface used by the live model wrappers.
 *
 * The application used to hand out raw v13 `Y.Text` / `Y.Map` / `Y.Array`
 * handles from `Block`/`Text`/`InlineBlock`. With the v14 engine the wrappers
 * are bound to `EdytorDoc` instead, but a large amount of code (events,
 * selection, plugins, tests) still speaks the old `yText`/`yBlock`/`yContent`
 * vocabulary. These structural types describe the adapter objects the wrappers
 * expose under those names, so legacy call sites keep compiling and behaving
 * the same without any `yjs` import.
 */

export interface YTextLike {
	/** Length of this text segment (v13 `Y.Text.length`). */
	readonly length: number;
	/** Owning CRDT doc (or null for a detached/pending adapter). */
	readonly doc: unknown;
	/**
	 * v13 `yText._item` — used by selection/history to read the item id and to
	 * test `deleted`. The adapter synthesises `{id, deleted}` per segment.
	 */
	readonly _item: { id: { client: number; clock: number } | null; deleted: boolean } | null;
	insert(offset: number, text: string, marks?: Record<string, unknown> | null): void;
	delete(offset: number, length: number): void;
	format(offset: number, length: number, attributes: Record<string, unknown>): void;
	applyDelta(delta: unknown[]): void;
	toJSON(): string;
	toString(): string;
	getAttribute(name: string): unknown;
	setAttribute(name: string, value: unknown): void;
	observe(cb: (event: unknown, transaction: unknown) => void): void;
	unobserve(cb: (event: unknown, transaction: unknown) => void): void;
	/** True when any observer is registered (replaces v13 `_eH` introspection). */
	hasObservers(): boolean;
}

export interface YBlockLike {
	get(key: string): unknown;
	set(key: string, value: unknown): void;
	/** v13 `yBlock._item` — `{deleted}` drives `block.isInTree`. */
	readonly _item: { id: { client: number; clock: number } | null; deleted: boolean } | null;
	readonly doc: unknown;
}

export interface YArrayLike<T = unknown> {
	readonly length: number;
	get(index: number): T;
	insert(index: number, items: T[]): void;
	push(items: T[]): void;
	delete(index: number, length?: number): void;
	toArray(): T[];
	map<U>(fn: (item: T, index: number) => U): U[];
	observe(cb: (event: unknown, transaction: unknown) => void): void;
	unobserve(cb: (event: unknown, transaction: unknown) => void): void;
}

/**
 * Marker interface the wrappers put on their adapters so `yContent.insert` and
 * friends can distinguish detached specs from live handles.
 */
export interface CompatHandle {
	readonly __compatKind: 'text' | 'inline' | 'block';
}

/** Historical alias — several call sites type block handles as `YBlock`. */
export type YBlock = YBlockLike;
