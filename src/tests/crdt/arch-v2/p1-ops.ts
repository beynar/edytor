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
	'inline'
];
export const WORDS = ['x', 'yy', 'zzz', 'Q', 'ab', 'W'];

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
			return { action, args: [blk, pick(kinds)] };
		case 'inline':
			return { action, args: [blk, off, `${r.name}i${counter.n++}`] };
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
		case 'inline':
			return ed.insertInline(a[0], a[1], { id: a[2], type: 'mention' });
	}
};
