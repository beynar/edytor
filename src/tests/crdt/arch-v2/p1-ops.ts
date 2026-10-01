/**
 * arch-v2 phase 2 P1 — the random edit vocabulary shared by the ported
 * fuzz campaign (`p1-fuzz.test.ts`) and the room simulation
 * (`p1-room.test.ts`): a concrete, replayable action generated from a
 * replica's current state, and its execution through the facade and the
 * document history.
 */
// @ts-nocheck -- tests drive the facade through untyped fixtures.
import { mulberry32 } from '../harness/rng.js';
import type { Replica } from './p1-harness.js';

export const ACTIONS = [
	'insert',
	'insert',
	'insert',
	'deleteText',
	'replaceText',
	'deleteRange',
	'format',
	'split',
	'split',
	'mergeBackward',
	'mergeForward',
	'move',
	'nest',
	'unnest',
	'deleteBlocks',
	'deleteKeep',
	'create',
	'paste',
	'undo',
	'undo',
	'redo',
	'retype',
	'inline',
	'data',
	'docData',
	'array',
	'array'
];
/** Data patches: keys, nested keys under a key another patch sets whole, deletes, a whole replace. */
const PATHS = [['a'], ['a', 'b'], ['a', 'c'], ['n'], []];
const VALUES = [1, 'x', [1, 2], { b: 2 }, {}, null, undefined];
export const WORDS = ['x', 'yy', 'zzz', 'Q', 'ab', 'W'];
/** Array items: primitives, objects, a nested array. */
const ITEMS = ['x', 1, null, { t: 'a' }, { t: 'b', l: [1] }, [2, 3]];

export const rngOf = (seed: number) => {
	const f = mulberry32(seed);
	return (bound: number) => Math.floor(f() * bound);
};

/** A concrete action for replica `r` from its current state (args are replayable). */
export const genAction = (
	r: Replica,
	next: (n: number) => number,
	counter: { n: number },
	actions: readonly string[] = ACTIONS,
	kinds: readonly string[] = ['paragraph', 'heading', 'quote', 'callout', 'divider']
) => {
	const ed = r.ed;
	const order: string[] = [...ed.order()];
	if (!order.length)
		return {
			action: 'create',
			args: [{ parent: null, index: 0 }, `${r.name}c${counter.n++}`, 'fresh']
		};
	const pick = <T>(xs: readonly T[]) => xs[next(xs.length)];
	const blk = pick(order);
	const len = ed.displayLength(blk);
	const off = next(len + 1);
	const span = () => {
		const s = next(len);
		return [s, 1 + next(len - s)];
	};
	const action = pick(actions);
	switch (action) {
		case 'insert':
			return { action, args: [blk, off, pick(WORDS)] };
		case 'deleteText':
		case 'replaceText':
			return len === 0 ? null : { action, args: [blk, ...span(), pick(WORDS)] };
		case 'deleteRange': {
			const i = order.indexOf(blk);
			const b2 = order[i + next(order.length - i)];
			return {
				action,
				args: [blk, off, b2, next(ed.displayLength(b2) + 1), `${r.name}n${counter.n++}`]
			};
		}
		case 'format':
			return len === 0
				? null
				: {
						action,
						args: [blk, ...span(), pick(['bold', 'color']), pick([true, 'red', 'blue', null])]
					};
		case 'split':
			return { action, args: [blk, off, `${r.name}n${counter.n++}`] };
		case 'mergeBackward':
		case 'mergeForward':
		case 'unnest':
			return { action, args: [blk] };
		case 'move': {
			const parent = next(3) === 0 ? null : pick(order);
			const n = parent === null ? ed.childrenIds(null).length : ed.childrenIds(parent).length;
			return { action, args: [blk, parent, next(n + 1)] };
		}
		case 'nest':
			return { action, args: [blk, pick(order)] };
		case 'deleteBlocks':
			return { action, args: [[...new Set([blk, ...(next(2) ? [pick(order)] : [])])]] };
		case 'deleteKeep':
			return { action, args: [blk] };
		case 'create': {
			const parent = next(2) === 0 ? null : pick(order);
			const n = parent === null ? ed.childrenIds(null).length : ed.childrenIds(parent).length;
			return {
				action,
				args: [{ parent, index: next(n + 1) }, `${r.name}c${counter.n++}`, pick(WORDS)]
			};
		}
		case 'paste':
			return { action, args: [blk, off, `${r.name}p${counter.n++}`, pick(WORDS), pick(WORDS)] };
		case 'undo':
		case 'redo':
			return { action, args: [] };
		case 'retype':
		case 'turnInto':
			return { action, args: [blk, pick(kinds)] };
		case 'inline':
			return { action, args: [blk, off, `${r.name}i${counter.n++}`] };
		case 'data':
		case 'docData': {
			const path = pick(PATHS);
			const value = pick(VALUES);
			const patch = {
				path,
				...(value !== undefined && { value: path.length ? value : { a: value } })
			};
			return { action, args: [action === 'data' ? blk : null, patch] };
		}
		case 'array': {
			// Fine-grained array ops on `l` (or `l.<i>.l`): splices, moves, writes inside items.
			const doc = next(4) === 0;
			const data = (doc ? ed.docData() : ed.blockDataOf(blk)) ?? {};
			const nested = Array.isArray(data.l) && data.l.length && next(3) === 0;
			const i = nested ? next(data.l.length) : 0;
			const path = nested ? ['l', `${i}`, 'l'] : ['l'];
			const list = nested ? data.l[i]?.l : data.l;
			// A new array of two: their ranks derive from it (one run, as a seeded array's).
			if (!Array.isArray(list))
				return { action, args: [doc ? null : blk, { path, value: [pick(ITEMS), pick(ITEMS)] }] };
			const n = list.length;
			// An odd item is named by its id (`~…`), as the proxy's item objects name it.
			const ids = ed.dataItemIds(doc ? null : blk, path);
			const item = (k: number) => (k % 2 ? (ids[k] ?? `${k}`) : `${k}`);
			const at = next(n + 1);
			const order = list.map((_, k) => k).sort(() => next(3) - 1);
			const patch = [
				{ path, splice: [at, n > 3 ? next(2) : 0, ...(next(4) ? [pick(ITEMS)] : [])] },
				{ path, order },
				n ? { path: [...path, `${next(n)}`], value: pick(ITEMS) } : { path, value: [] },
				n ? { path: [...path, item(next(n)), 't'], value: pick(WORDS) } : { path, value: [1] },
				n > 3 ? { path: [...path, `${next(n)}`] } : { path, splice: [n, 0, pick(ITEMS)] },
				{ path, value: [...list.slice(next(2)), pick(ITEMS)] },
				// Inserts that keep landing in one gap (the front, index 1): never out of room.
				[0, 1, 2].map(() => ({ path, splice: [Math.min(at, 1), 0, pick(ITEMS)] }))
			][next(7)];
			return { action, args: [doc ? null : blk, patch] };
		}
	}
	return null;
};

const text = (t: string) => [{ kind: 'text', text: t }];

/** Run one concrete action through the facade / history. Returns false when it threw. */
export const apply = (r: Replica, action: string, a: unknown[]) => {
	const ed = r.ed;
	switch (action) {
		case 'insert':
			return ed.insertText(a[0], a[1], a[2]);
		case 'deleteText':
			return ed.deleteText(a[0], a[1], a[2]);
		case 'replaceText':
			return ed.transact(() => {
				ed.deleteText(a[0], a[1], a[2]);
				return ed.insertText(a[0], a[1], a[3]);
			});
		case 'deleteRange':
			return ed.deleteRange({ block: a[0], offset: a[1] }, { block: a[2], offset: a[3] });
		case 'format':
			return ed.setMark(a[0], a[1], a[2], a[3], a[4]);
		case 'split':
			return ed.splitBlock(a[0], a[1], a[2]);
		case 'mergeBackward':
			return ed.mergeBackward(a[0]);
		case 'mergeForward':
			return ed.mergeForward(a[0]);
		case 'unnest':
			return ed.unNestBlock(a[0]);
		case 'move':
			return ed.moveBlock(a[0], { parent: a[1], index: a[2] });
		case 'nest':
			return ed.nestBlock(a[0], a[1]);
		case 'deleteBlocks':
			return ed.deleteBlocks(a[0]);
		case 'deleteKeep':
			return ed.deleteBlock(a[0], { keepChildren: true });
		case 'create':
			return ed.insertBlock(a[0], { id: a[1], type: 'paragraph', content: text(a[2]) });
		case 'paste':
			return ed.insertFlow(
				{ block: a[0], offset: a[1] },
				{
					lines: [
						{ id: `${a[2]}a`, content: text(a[3]) },
						{ id: `${a[2]}b`, content: text(a[4]) }
					]
				}
			);
		case 'undo':
			return r.undo();
		case 'redo':
			return r.redo();
		case 'retype':
			return ed.setBlockType(a[0], a[1]);
		case 'turnInto':
			// The view's Turn into (`convertToKind`): the kind lands where it fits, one plan.
			return ed.apply(
				ed.compose(ed.prepare.liftOut(a[0], a[1]), ed.prepare.setBlock(a[0], { type: a[1] }))
			);
		case 'inline':
			return ed.insertInline(a[0], a[1], { id: a[2], type: 'mention' });
		case 'data':
		case 'docData':
		case 'array':
			return ed.patchData(a[0], [a[1]].flat());
	}
};
