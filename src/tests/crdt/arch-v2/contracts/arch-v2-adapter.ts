/**
 * arch-v2 phase 2 P1.3 — the native branch's engine-agnostic contract peer
 * (`adapter.ts`, copied verbatim from `src/tests/native/contracts/`)
 * implemented on arch-v2's document facade.
 *
 * Mapping (each a documented arch-v2 surface, never an engine shortcut for
 * the edit itself):
 * - a peer is an `EdytorDocument` (`createDocument({value})` for the seeded
 *   peer, `loadDocument(bytes)` for a peer created from another's state);
 *   every edit is one `document.facade` op, one transaction, one undo step
 *   (`history.captureTimeout: 0`);
 * - `split(block, from, newId, to)` — the selected-range Enter: `deleteText`
 *   then `splitBlock`, in one `transact` (one undo step);
 * - `join(left, right)` — `mergeBlocks(right, left)` (the right block's
 *   content and children join the left one);
 * - `move(block, parent, before)` — `moveBlock` to `before`'s slot (the end
 *   when `before` is null);
 * - `anchor`/`resolve` — `anchorAt`/`resolveAnchor` (the anchor contract);
 * - `replaceObserved(ref, ids, text)` — the composition commit's semantic
 *   slice: delete exactly the observed unit identities wherever they are
 *   now, insert `text` where `ref` resolves, in one transaction;
 * - `undo(edit)` — arch-v2 history is a per-actor stack
 *   (`document.history`), not selective: the adapter undoes `edit` only when
 *   it is that peer's newest undoable edit, and throws otherwise (a pinned
 *   divergence, never reached by the programs as written);
 * - `encode`/`apply` — engine updates through the providers' inbound
 *   admission (`crdt.sync.applyRemote`); a refused or unapplied update
 *   throws, as the native adapter throws on a non-integrated operation.
 *
 * Unit identity: the replicated engine item that backs a displayed
 * character (`anchorAt(..., 'right').a.i`). An undo of a deletion integrates
 * COPIES of the deleted items (same text, same stream — R16); the link from
 * an original to its copy (`redone`) is local to the undoing replica, and
 * arch-v2's anchors bridge it there (`followUndo`). So a restored character
 * has a new identity on every replica — the one pinned divergence of
 * `split.range-one-undo` (see `contracts.test.ts`).
 */
// @ts-nocheck -- tests drive the vendored engine and the facade through untyped fixtures.
import { Y } from '../../../../lib/crdt/engine.js';
import { createDocument, loadDocument } from '../../../../lib/crdt/index.js';
import { REMOTE, crdt } from '../replica-harness.js';
import type { ContractAdapter, ContractPeer, Observation, Reference, Seed } from './adapter.js';

const json = (s: Seed) => ({
	id: s.id,
	type: s.type ?? 'paragraph',
	content: s.text ? [{ text: s.text }] : [],
	...(s.children?.length ? { children: s.children.map(json) } : {})
});

class ArchV2Peer implements ContractPeer {
	private document = null as ReturnType<typeof createDocument> | null;
	/** This peer's edits, oldest first, that are still on its undo stack. */
	private stack: string[] = [];
	private seq = 0;

	constructor(
		private readonly actor: string,
		seed?: Seed[]
	) {
		if (seed)
			this.adopt(
				createDocument({
					value: { children: seed.map(json) },
					actor: { id: actor },
					history: { captureTimeout: 0 }
				})
			);
	}

	private adopt(document) {
		this.document = document;
		// A fixed, distinct writer per actor name (deterministic runs).
		let h = 7;
		for (const ch of this.actor) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
		document.doc.clientID = 1000 + (h % 1_000_000);
	}

	private get ed() {
		if (!this.document) throw new Error('Contract peer has not received its seed document');
		return this.document.facade;
	}

	private edit(fn: () => { status: string } | unknown): string {
		const r = fn() as { status?: string };
		if (r && typeof r === 'object' && 'status' in r && r.status !== 'applied') {
			throw new Error(`Contract edit ${r.status}${'reason' in r ? ` (${r.reason})` : ''}`);
		}
		const id = `${this.actor}#${++this.seq}`;
		this.stack.push(id);
		return id;
	}

	observe(): Observation {
		const ed = this.ed;
		const blocks: Observation['blocks'] = {};
		for (const id of ed.order()) {
			const units: Observation['blocks'][string]['units'] = [];
			let at = 0;
			for (const part of ed.blockJSON(id).content ?? []) {
				if (part.text === undefined)
					throw new Error('The contract observation has no inline-atom unit');
				const marks: Record<string, string | boolean> = {};
				for (const [k, v] of Object.entries(part.marks ?? {})) {
					if (typeof v !== 'string' && typeof v !== 'boolean')
						throw new Error(`The contract observation cannot represent mark ${k}`);
					marks[k] = v;
				}
				for (const value of part.text) {
					const i = ed.anchorAt(id, at++, 'right')?.a?.i;
					if (!i) throw new Error(`No identity for ${id}@${at - 1}`);
					units.push({ id: `${i.c}:${i.k}`, value, marks: { ...marks } });
				}
			}
			blocks[id] = {
				id,
				type: ed.blockTypeOf(id),
				parent: ed.parentOf(id),
				children: [...ed.childrenIds(id)],
				text: ed.blockText(id),
				units
			};
		}
		return { roots: [...ed.childrenIds(null)], blocks };
	}

	insert(block: string, at: number, text: string) {
		return this.edit(() => this.ed.insertText(block, at, text));
	}

	delete(block: string, from: number, to: number) {
		return this.edit(() => this.ed.deleteText(block, from, to - from));
	}

	split(block: string, from: number, newId: string, to?: number) {
		return this.edit(() =>
			to === undefined
				? this.ed.splitBlock(block, from, newId)
				: this.ed.transact(() => {
						const d = this.ed.deleteText(block, from, to - from);
						if (d.status !== 'applied') return d;
						return this.ed.splitBlock(block, from, newId);
					})
		);
	}

	join(left: string, right: string) {
		return this.edit(() => this.ed.mergeBlocks(right, left));
	}

	move(block: string, parent: string | null, before: string | null) {
		const siblings = this.ed.childrenIds(parent).filter((id: string) => id !== block);
		const index = before === null ? siblings.length : siblings.indexOf(before);
		if (index < 0) throw new Error(`Contract move: ${before} is not a child of ${parent}`);
		return this.edit(() => this.ed.moveBlock(block, { parent, index }));
	}

	mark(block: string, from: number, to: number, k: string, value: string | boolean | null) {
		return this.edit(() => this.ed.formatRange(block, from, to - from, { [k]: value }));
	}

	anchor(block: string, offset: number, affinity: 'left' | 'right'): Reference {
		return this.ed.anchorAt(block, offset, affinity);
	}

	resolve(reference: Reference) {
		return this.ed.resolveAnchor(reference);
	}

	replaceObserved(reference: Reference, ids: string[], text: string) {
		const wanted = new Set(ids);
		return this.edit(() =>
			this.ed.transact(() => {
				// Delete the observed units wherever they are displayed now (last first).
				const found: [string, number][] = [];
				const observation = this.observe();
				for (const b of Object.values(observation.blocks)) {
					b.units.forEach((u, i) => wanted.has(u.id) && found.push([b.id, i]));
				}
				for (const [b, i] of found.reverse()) this.ed.deleteText(b, i, 1);
				const at = this.ed.resolveAnchor(reference);
				if (!at) throw new Error('Contract replaceObserved: the reference does not resolve');
				return this.ed.insertText(at.blockId, at.offset, text);
			})
		);
	}

	undo(edit?: string): string | null {
		if (edit !== undefined && this.stack.at(-1) !== edit) {
			throw new Error('arch-v2 history is a stack: only the newest edit can be undone');
		}
		const item = this.document!.history.undo();
		if (item === null) return null;
		return this.stack.pop() ?? null;
	}

	encode(): Uint8Array {
		return Y.encodeStateAsUpdate(this.document!.doc);
	}

	apply(bytes: Uint8Array): void {
		if (!this.document) {
			this.adopt(
				loadDocument(bytes, { actor: { id: this.actor }, history: { captureTimeout: 0 } })
			);
			return;
		}
		const { applied, problem } = crdt.sync.applyRemote(this.document.doc, bytes, REMOTE);
		if (problem !== null || !applied) {
			throw new Error(`Contract delivery refused: ${JSON.stringify(problem)}`);
		}
		const store = this.document.doc.store;
		if (store.pendingStructs !== null || store.pendingDs !== null) {
			// Deliveries in these programs are whole states: nothing may stay pending.
			throw new Error('Contract delivery left pending structs');
		}
	}

	destroy(): void {
		this.document?.destroy();
	}
}

export const archV2Adapter: ContractAdapter = {
	create(actor: string, seed?: Seed[]): ContractPeer {
		return new ArchV2Peer(actor, seed);
	}
};
