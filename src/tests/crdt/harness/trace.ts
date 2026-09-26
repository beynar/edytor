/**
 * Deterministic event record for headless schedules (U3).
 *
 * Every scheduler-visible decision on a `PeerSet` appends one
 * {@link TraceEvent}: enqueues, deliveries (including drops/duplicates/
 * batches), partition/heal edges, persists, reloads (with the new
 * incarnation's rand generation), sync exchanges, and local transaction
 * boundaries with their authored-update byte counts — so an op that
 * produced no update is visible as such rather than counted as a mutation.
 *
 * Byte counts alone cannot pin what was executed: two same-length payloads
 * or two different delivery orders of the same queue serialize identically
 * under `n`/`n2`. Events that move update bytes therefore also carry
 * `h` — the FNV-1a content hash ({@link updateHash}) of every update
 * involved, comma-joined in *applied order* — and `d`, the decision detail
 * that parametrized the event (`deliver` → `r<0|1>t<n>b<0|1>` reverse/
 * times/batch, `reload` → snapshot|log, `sync` → inc|full). Identical
 * traces now require identical payloads AND identical delivery choices.
 *
 * `t` comes from `PeerSet.clock` — `() => 0` by default, or `vclock.now`
 * when the virtual clock is installed. `seq` is a strict per-set counter:
 * the trace's ordering is itself a determinism assertion (two runs with
 * identical scheduler choices must produce identical sequences).
 *
 * The digest is FNV-1a over a canonical serialization — stable across
 * processes and machines, no crypto dependency. A matching digest proves
 * the same semantic trace; a deliberate defect must change it.
 */
export type TraceEvent = {
	seq: number;
	t: number;
	kind:
		| 'transact'
		| 'command'
		| 'enqueue'
		| 'deliver'
		| 'drop'
		| 'partition'
		| 'heal'
		| 'persist'
		| 'reload'
		| 'sync';
	/** actor / edge endpoints, depending on kind. */
	a?: string;
	b?: string;
	/**
	 * Op identity for `command` records (e.g. the inputType) — in-memory
	 * only: {@link serializeEvent} does not emit it, so coverage accounting
	 * must read the raw events, not the serialized trace.
	 */
	i?: string;
	/** event-specific numeric payload (bytes, applied count, generation, …). */
	n?: number;
	n2?: number;
	/**
	 * Ordered content evidence: {@link updateHash} of every update this event
	 * authored, enqueued, applied, exchanged or dropped, comma-joined in
	 * execution order. `deliver` lists each application (a `times: 3`
	 * repeat contributes three entries); `transact` lists its authored
	 * updates in order.
	 */
	h?: string;
	/**
	 * Decision detail, per kind:
	 * - `deliver`: `r<0|1>t<n>b<0|1>` — reversed order, apply count, merged.
	 * - `reload`: the reconstruction mode (`snapshot` | `log`).
	 * - `sync`: the exchange mode (`inc` incremental | `full`).
	 * - `command`: the scheduled action — `<peer> <inputType> <selection>`,
	 *   the intent behind the `enqueue`/`deliver` records that follow.
	 */
	d?: string;
};

const serializeEvent = (e: TraceEvent): string => {
	const f = [e.seq, e.t, e.kind, e.a ?? '', e.b ?? '', e.n ?? '', e.n2 ?? '', e.h ?? '', e.d ?? ''];
	// Trim trailing empty slots so events without payload stay terse.
	let end = f.length;
	while (end > 3 && f[end - 1] === '') end--;
	return f.slice(0, end).join('|');
};

/** Canonical full-trace serialization (checkpoint/diff surface). */
export const serializeTrace = (trace: readonly TraceEvent[]): string =>
	trace.map(serializeEvent).join('\n');

const fnv1a = (s: string): string => {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, '0');
};

/** FNV-1a 32-bit over the canonical trace — the failure fingerprint. */
export const traceDigest = (trace: readonly TraceEvent[]): string => fnv1a(serializeTrace(trace));

/**
 * FNV-1a 32-bit over raw update bytes — the per-update content identity
 * recorded in {@link TraceEvent.h}. Same-length different content yields
 * a different hash, so payload equality is part of the trace evidence.
 */
export const updateHash = (u: Uint8Array): string => {
	let h = 0x811c9dc5;
	for (let i = 0; i < u.length; i++) {
		h ^= u[i];
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, '0');
};
