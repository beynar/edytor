/**
 * Awareness protocol — port of `@y/protocols@1.0.6-rc.1` `src/awareness.js`
 * (MIT © Kevin Jahns — see `src/lib/crdt/vendor/yjs/LICENSE`).
 *
 * The upstream module imports `@y/y` for JSDoc types only — but that import
 * still EXECUTES the npm engine, instantiating a second Yjs copy whose
 * `instanceof` checks disagree with vendored docs. Here the engine surface is
 * `import type` only (structural `AwarenessDoc`), so this file has no engine
 * runtime dependency at all.
 *
 * Wire format is unchanged (clientID + clock + JSON state tuples), so v14
 * awareness updates are byte-compatible with v13 on the wire. The provider
 * layer still tags every room message with the protocol-version envelope —
 * wire compatibility is not peer compatibility (presence payload versioning
 * is U09's concern).
 */
import * as encoding from 'lib0-v14/encoding';
import * as decoding from 'lib0-v14/decoding';
import * as time from 'lib0-v14/time';
import * as math from 'lib0-v14/math';
import { ObservableV2 } from 'lib0-v14/observable';
import * as f from 'lib0-v14/function';

export const outdatedTimeout = 30000;

export type MetaClientState = {
	clock: number;
	/** unix timestamp */
	lastUpdated: number;
};

/**
 * Structural minimum an Awareness host must satisfy. `Y.Doc` (vendored v14)
 * satisfies this; the structural type keeps Awareness free of any engine
 * runtime import.
 */
export interface AwarenessDoc {
	clientID: number;
	on(name: 'destroy', f: (doc: unknown) => void): void;
}

export type AwarenessStates = Map<number, Record<string, unknown>>;

export type AwarenessUpdate = {
	added: number[];
	updated: number[];
	removed: number[];
};

type AwarenessEvents = {
	destroy: (awareness: Awareness) => void;
	update: (updates: AwarenessUpdate, origin: unknown) => void;
	change: (changes: AwarenessUpdate, origin: unknown) => void;
};

/**
 * Simple shared state protocol for non-persistent data (cursor, username,
 * status…). Semantics are verbatim upstream: clock-ordered LWW per client,
 * remote `null` states mark peers offline, local state is re-published when
 * outdated, and remote states expire after {@link outdatedTimeout}.
 */
export class Awareness extends ObservableV2<AwarenessEvents> {
	doc: AwarenessDoc;
	clientID: number;
	/** Maps from client id to client state */
	states: AwarenessStates;
	meta: Map<number, MetaClientState>;
	private _checkInterval: ReturnType<typeof setInterval>;
	/**
	 * Idempotence guard — `destroy()` is reachable twice through the
	 * OWNED-doc + OWNED-awareness composition: `EdytorDocument.destroy()`
	 * runs `awareness.destroy()` and the subsequent `doc.destroy()` re-fires
	 * this instance's `doc.on('destroy')` hook. Without the guard the second
	 * call re-emits 'destroy' + 'change'/'update' (a duplicate
	 * `removed: [clientID]` broadcast) and re-runs `setLocalState(null)`.
	 */
	private _destroyed = false;

	constructor(doc: AwarenessDoc) {
		super();
		this.doc = doc;
		this.clientID = doc.clientID;
		this.states = new Map();
		this.meta = new Map();
		this._checkInterval = setInterval(
			() => {
				const now = time.getUnixTime();
				const localMeta = this.meta.get(this.clientID);
				if (
					this.getLocalState() !== null &&
					localMeta !== undefined &&
					outdatedTimeout / 2 <= now - localMeta.lastUpdated
				) {
					// renew local clock
					this.setLocalState(this.getLocalState());
				}
				const remove: number[] = [];
				this.meta.forEach((meta, clientid) => {
					if (
						clientid !== this.clientID &&
						outdatedTimeout <= now - meta.lastUpdated &&
						this.states.has(clientid)
					) {
						remove.push(clientid);
					}
				});
				if (remove.length > 0) {
					removeAwarenessStates(this, remove, 'timeout');
				}
			},
			math.floor(outdatedTimeout / 10)
		);
		// Node returns a `Timeout` (has `unref`), browsers a number — a stale-
		// state sweep must never be the thing keeping a node/SSR process alive
		// (a server-rendered component can't run its client teardown path).
		(this._checkInterval as { unref?: () => void }).unref?.();
		doc.on('destroy', () => {
			this.destroy();
		});
		this.setLocalState({});
	}

	override destroy(): void {
		if (this._destroyed) {
			return;
		}
		this._destroyed = true;
		this.emit('destroy', [this]);
		this.setLocalState(null);
		super.destroy();
		clearInterval(this._checkInterval);
	}

	getLocalState(): Record<string, unknown> | null {
		return this.states.get(this.clientID) || null;
	}

	setLocalState(state: Record<string, unknown> | null): void {
		const clientID = this.clientID;
		const currLocalMeta = this.meta.get(clientID);
		const clock = currLocalMeta === undefined ? 0 : currLocalMeta.clock + 1;
		const prevState = this.states.get(clientID);
		if (state === null) {
			this.states.delete(clientID);
		} else {
			this.states.set(clientID, state);
		}
		this.meta.set(clientID, {
			clock,
			lastUpdated: time.getUnixTime()
		});
		const added: number[] = [];
		const updated: number[] = [];
		const filteredUpdated: number[] = [];
		const removed: number[] = [];
		if (state === null) {
			removed.push(clientID);
		} else if (prevState == null) {
			if (state != null) {
				added.push(clientID);
			}
		} else {
			updated.push(clientID);
			if (!f.equalityDeep(prevState, state)) {
				filteredUpdated.push(clientID);
			}
		}
		if (added.length > 0 || filteredUpdated.length > 0 || removed.length > 0) {
			this.emit('change', [{ added, updated: filteredUpdated, removed }, 'local']);
		}
		this.emit('update', [{ added, updated, removed }, 'local']);
	}

	setLocalStateField(field: string, value: unknown): void {
		const state = this.getLocalState();
		if (state !== null) {
			this.setLocalState({
				...state,
				[field]: value
			});
		}
	}

	getStates(): AwarenessStates {
		return this.states;
	}
}

/**
 * Mark (remote) clients as inactive and remove them from the list of active
 * peers. This change is propagated to remote clients.
 */
export const removeAwarenessStates = (
	awareness: Awareness,
	clients: number[],
	origin: unknown
): void => {
	const removed: number[] = [];
	for (let i = 0; i < clients.length; i++) {
		const clientID = clients[i];
		if (awareness.states.has(clientID)) {
			awareness.states.delete(clientID);
			if (clientID === awareness.clientID) {
				const curMeta = awareness.meta.get(clientID) as MetaClientState;
				awareness.meta.set(clientID, {
					clock: curMeta.clock + 1,
					lastUpdated: time.getUnixTime()
				});
			}
			removed.push(clientID);
		}
	}
	if (removed.length > 0) {
		awareness.emit('change', [{ added: [], updated: [], removed }, origin]);
		awareness.emit('update', [{ added: [], updated: [], removed }, origin]);
	}
};

export const encodeAwarenessUpdate = (
	awareness: Awareness,
	clients: number[],
	states: AwarenessStates = awareness.states
): Uint8Array => {
	const len = clients.length;
	const encoder = encoding.createEncoder();
	encoding.writeVarUint(encoder, len);
	for (let i = 0; i < len; i++) {
		const clientID = clients[i];
		const state = states.get(clientID) || null;
		const clock = (awareness.meta.get(clientID) as MetaClientState).clock;
		encoding.writeVarUint(encoder, clientID);
		encoding.writeVarUint(encoder, clock);
		encoding.writeVarString(encoder, JSON.stringify(state));
	}
	return encoding.toUint8Array(encoder);
};

/**
 * Modify the content of an awareness update before re-encoding it to an
 * awareness update — e.g. a central server preventing identity hijacking.
 */
export const modifyAwarenessUpdate = (
	update: Uint8Array,
	modify: (state: Record<string, unknown> | null) => Record<string, unknown> | null
): Uint8Array => {
	const decoder = decoding.createDecoder(update);
	const encoder = encoding.createEncoder();
	const len = decoding.readVarUint(decoder);
	encoding.writeVarUint(encoder, len);
	for (let i = 0; i < len; i++) {
		const clientID = decoding.readVarUint(decoder);
		const clock = decoding.readVarUint(decoder);
		const state = JSON.parse(decoding.readVarString(decoder));
		const modifiedState = modify(state);
		encoding.writeVarUint(encoder, clientID);
		encoding.writeVarUint(encoder, clock);
		encoding.writeVarString(encoder, JSON.stringify(modifiedState));
	}
	return encoding.toUint8Array(encoder);
};

/**
 * Apply an encoded awareness update. `origin` is forwarded on the emitted
 * change/update events.
 */
export const applyAwarenessUpdate = (
	awareness: Awareness,
	update: Uint8Array,
	origin: unknown
): void => {
	const decoder = decoding.createDecoder(update);
	const timestamp = time.getUnixTime();
	const added: number[] = [];
	const updated: number[] = [];
	const filteredUpdated: number[] = [];
	const removed: number[] = [];
	const len = decoding.readVarUint(decoder);
	for (let i = 0; i < len; i++) {
		const clientID = decoding.readVarUint(decoder);
		let clock = decoding.readVarUint(decoder);
		const state = JSON.parse(decoding.readVarString(decoder));
		const clientMeta = awareness.meta.get(clientID);
		const prevState = awareness.states.get(clientID);
		const currClock = clientMeta === undefined ? 0 : clientMeta.clock;
		if (
			currClock < clock ||
			(currClock === clock && state === null && awareness.states.has(clientID))
		) {
			if (state === null) {
				// never let a remote client remove this local state
				if (clientID === awareness.clientID && awareness.getLocalState() != null) {
					// remote client removed the local state. Do not remove state. Broadcast a message
					// indicating that this client still exists by increasing the clock
					clock++;
				} else {
					awareness.states.delete(clientID);
				}
			} else {
				awareness.states.set(clientID, state);
			}
			awareness.meta.set(clientID, {
				clock,
				lastUpdated: timestamp
			});
			if (clientMeta === undefined && state !== null) {
				added.push(clientID);
			} else if (clientMeta !== undefined && state === null) {
				removed.push(clientID);
			} else if (state !== null) {
				if (!f.equalityDeep(state, prevState)) {
					filteredUpdated.push(clientID);
				}
				updated.push(clientID);
			}
		}
	}
	if (added.length > 0 || filteredUpdated.length > 0 || removed.length > 0) {
		awareness.emit('change', [{ added, updated: filteredUpdated, removed }, origin]);
	}
	if (added.length > 0 || updated.length > 0 || removed.length > 0) {
		awareness.emit('update', [{ added, updated, removed }, origin]);
	}
};
