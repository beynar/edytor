/**
 * A view's property writes (`block.data`, `atom.data`, `edytor.data`): the
 * data proxy (`crdt/props.ts`) over the view's one write path.
 *
 * The writes of one synchronous task are one dispatch: they queue per
 * target and leave on the next microtask, or before any other operation
 * this view dispatches, as the `patchData` operation of each target (more
 * than one target: one user command, so one undo step, in one
 * transaction). Hooks see that operation; a veto drops the burst. Until
 * then the proxy reads its target's data with the queued patches applied
 * (`dataPreview`), so a write reads back at once. A view that refuses
 * writes (readonly, a read-only document) refuses an assignment at once:
 * nothing is queued, the dispatcher records `refused`, nothing throws.
 */
import type { DataPatch } from '../crdt/data.js';
import type { DataTarget } from '../crdt/doc/types.js';
import { propsProxy } from '../crdt/props.js';
import type { Edytor } from '../edytor.svelte.js';

type Pending = { target: DataTarget; patches: DataPatch[] };
type Preview = { version: number; count: number; data: Record<string, unknown> | null };

const keyOf = (target: DataTarget) => JSON.stringify(target);

export class DataWrites {
	#pending = new Map<string, Pending>();
	#scheduled = false;
	constructor(private readonly edytor: Edytor) {}

	/** The live proxy over `target`'s data; `read` is its reactive, committed source. */
	proxy<T extends object>(target: DataTarget, read: () => Record<string, unknown>): T {
		let preview: Preview | undefined;
		const pending = () => this.#pending.get(keyOf(target));
		const current = () => {
			const base = read();
			const queued = pending();
			if (!queued) return base;
			const { version } = this.edytor.facade;
			const count = queued.patches.length;
			if (preview?.version !== version || preview.count !== count) {
				const seen = this.edytor.facade.dataPreview(target, queued.patches);
				preview = { version, count, data: seen?.data ?? null };
			}
			return preview.data ?? base;
		};
		return propsProxy<T>(
			current,
			(patches) => this.write(target, patches),
			(path) => {
				const queued = pending();
				return queued
					? (this.edytor.facade.dataPreview(target, queued.patches)?.ids(path) ?? [])
					: this.edytor.facade.dataItemIds(target, path);
			}
		);
	}

	/** Queue `patches` on `target` for this task's dispatch (refused at once when the view refuses writes). */
	write(target: DataTarget, patches: DataPatch[]) {
		const { edytor } = this;
		if (!edytor.dispatcher.permits()) return void edytor.patchData(target, patches);
		const key = keyOf(target);
		const queued = this.#pending.get(key);
		if (queued) queued.patches.push(...patches);
		else this.#pending.set(key, { target, patches: [...patches] });
		if (this.#scheduled) return;
		this.#scheduled = true;
		queueMicrotask(() => {
			this.#scheduled = false;
			if (!edytor.destroyed) this.flush();
		});
	}

	/** Dispatch the queued writes now: before any other operation of this view, and at the end of the task. */
	flush() {
		if (this.#pending.size === 0) return;
		const all = [...this.#pending.values()];
		this.#pending.clear();
		const { edytor } = this;
		if (all.length === 1) return void edytor.patchData(all[0]!.target, all[0]!.patches);
		edytor.dispatcher.run('patchData', () =>
			edytor.transact(() => all.forEach(({ target, patches }) => edytor.patchData(target, patches)))
		);
	}
}
