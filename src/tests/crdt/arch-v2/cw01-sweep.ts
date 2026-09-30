/**
 * The CW-01 order sweeps' fixtures and runner, shared by the sweep files
 * (`cw01-order-sweep.test.ts`, `dr-crdt-order.test.ts`): peers make
 * structural gestures on neighbouring blocks at once, on many client-id
 * assignments, and every outcome is held to the text order (`sweep`).
 */
// @ts-nocheck -- tests drive the facade through untyped fixtures.
import { expect } from 'vitest';
import { allText, clientPairs, converge, LIVE } from './p1-harness.js';

export const semantics = {
	roles: {
		code: { island: true, lines: true },
		divider: { void: true }
	},
	rendersContent: {
		code: false,
		divider: false,
		'unordered-list': false
	},
	defaultChild: { code: 'codeLine', 'unordered-list': 'list-item' }
};

export const typed = (ed) => {
	const show = (b) =>
		`${b.id}:${b.type}${b.children?.length ? `[${b.children.map(show).join(',')}]` : ''}`;
	return ed
		.toJSON()
		.children.map(show)
		.join(' ')
		.replace(/\bb_[A-Za-z0-9_-]+/g, 'NEW');
};

export const item = (id: string, children = []) => ({ id, type: 'list-item', text: id, children });
export const para = (id: string, children = []) => ({ id, text: id, children });
export const list = (id: string, ...items) => ({
	id,
	type: 'unordered-list',
	text: '',
	children: items
});

/**
 * The gestures a peer makes on one block, as the view composes them:
 * Shift+Tab, Backspace at its start (a first item lifts out, any other
 * block merges into the one above), Turn into a heading, and Turn into a
 * divider or a code block after the item's text (`placing` with `after`:
 * the item stays, the new block goes out after it, the list split there).
 * `enter` and `paste` split the block after its first character: Enter,
 * and a paste of three empty lines (`insertFlow`), which keeps the text.
 * `tag` keeps the ids a peer mints apart.
 */
export const gestures = {
	outdent: (ed, id: string) => ed.unNestBlock(id),
	backspace: (ed, id: string) => ed.mergeBackward(id),
	heading: (ed, id: string) =>
		ed.apply(ed.compose(ed.prepare.liftOut(id, 'heading'), ed.prepare.setBlockType(id, 'heading'))),
	divider: (ed, id: string, tag: string) =>
		ed.liftOut(id, 'divider', {
			keep: true,
			after: [
				{ id: `D${tag}`, type: 'divider' },
				{ id: `N${tag}`, type: 'paragraph' }
			]
		}),
	code: (ed, id: string, tag: string) =>
		ed.liftOut(id, 'code', {
			keep: true,
			after: [{ id: `K${tag}`, type: 'code', children: [{ id: `L${tag}`, type: 'codeLine' }] }]
		}),
	enter: (ed, id: string, tag: string) => ed.splitBlock(id, 1, `E${tag}`),
	paste: (ed, id: string, tag: string) =>
		ed.insertFlow(
			{ block: id, offset: 1 },
			{ lines: ['a', 'b', 'c'].map((l) => ({ id: `V${tag}${l}`, content: [] })) }
		)
} as const;
export type Gesture = keyof typeof gestures;
/** The structural gestures: every one but the splits. */
export const ALL: Gesture[] = ['outdent', 'backspace', 'heading', 'divider', 'code'];
export const LIFTS: Gesture[] = ['heading', 'divider', 'code'];

export type Move = [Gesture, string];
/** Which kind of wrong outcome a residual predicate is asked about. */
export type Wrong = 'text' | 'inserted';
/** `true` when the wrong outcome is a pinned residual for these moves and the winning peer. */
export type Residual = (wrong: Wrong, moves: Move[], winner: number) => boolean;
export const none: Residual = () => false;

/** Every inserted block (`D0`, `N1`, `K0`…) right after the text of the item its peer inserted it after. */
const insertedInPlace = (ed, moves: Move[]) => {
	let text: string | null = null;
	for (const id of ed.order()) {
		const tag = /^[DNK](\d)$/.exec(id)?.[1];
		if (tag !== undefined) {
			// A Backspace merging the next item into it leaves its text inside the block.
			if (!text?.includes(moves[Number(tag)][1])) return false;
		} else if (ed.blockText(id)) text = ed.blockText(id);
	}
	return true;
};

/**
 * Run the peers' `moves` concurrently (each on the seed state) on every
 * assignment; answer the failures as `assignment → text :: tree` lines.
 */
export const sweep = (
	seed,
	want: string,
	moves: Move[],
	assignments: number[][],
	residual: Residual = none
): string[] => {
	const bad: string[] = [];
	const outcomes = converge(
		seed,
		moves.length,
		(reps) =>
			moves.forEach(([g, id], k) =>
				expect(gestures[g](reps[k].ed, id, String(k)).status, `${g} ${id}`).toBe('applied')
			),
		{ semantics, assignments }
	);
	outcomes.forEach((o, k) => {
		const ids = assignments[k];
		const winner = ids.indexOf(Math.max(...ids));
		const line = `${ids.map((i) => i - LIVE).join(',')} ${allText(o.ed)} :: ${typed(o.ed)}`;
		const wrong = (w: Wrong) => !residual(w, moves, winner);
		if (o.problems.length > 0) bad.push(`${line} problems ${o.problems.join('; ')}`);
		else if (o.results.size !== 1) bad.push(`${line} diverged`);
		else if (/-list\[[^\]]*:paragraph/.test(typed(o.ed))) bad.push(`${line} paragraph in a list`);
		else if (allText(o.ed) !== want && wrong('text')) bad.push(line);
		else if (!insertedInPlace(o.ed, moves) && wrong('inserted')) bad.push(`${line} inserted`);
		for (const r of o.reps) r.destroy();
	});
	return bad;
};

/** Whether `g` applies to `id` alone on `seed` (a gesture a key would not make is skipped). */
const applying = new Map<string, boolean>();
export const applies = (seed, g: Gesture, id: string) => {
	const key = `${JSON.stringify(seed)} ${g} ${id}`;
	if (!applying.has(key))
		for (const o of converge(
			seed,
			1,
			([a]) => applying.set(key, gestures[g](a.ed, id, 'probe').status === 'applied'),
			{ semantics, assignments: [[LIVE + 1]] }
		))
			for (const r of o.reps) r.destroy();
	return applying.get(key)!;
};

/**
 * Every gesture pair `ga ‖ gb` on items `x`, `y` of `seed` at most `reach`
 * apart in document order (the same item too), on `n` client-id pairs;
 * `on` leaves out the gestures a row does not make on a block.
 */
export const matrix = (
	seed,
	items: string[],
	want: string,
	[ga, gb]: [Gesture, Gesture],
	{
		n,
		reach = 1,
		residual = none,
		on = () => true
	}: { n: number; reach?: number; residual?: Residual; on?: (g: Gesture, id: string) => boolean }
) => {
	const bad: string[] = [];
	for (const [i, x] of items.entries())
		for (let d = -reach; d <= reach; d++) {
			const y = items[i + d];
			if (y === undefined || !on(ga, x) || !on(gb, y)) continue;
			if (!applies(seed, ga, x) || !applies(seed, gb, y)) continue;
			const moves: Move[] = [
				[ga, x],
				[gb, y]
			];
			for (const line of sweep(seed, want, moves, clientPairs(n), residual))
				bad.push(`${ga} ${x} ‖ ${gb} ${y}: ${line}`);
		}
	return bad.slice(0, 6).join('\n');
};

/**
 * R2 (pinned): a block inserted after an item (Turn into a divider or a
 * code block after its text) whose item a peer's split of a LATER item
 * takes into that split's new list, when that peer's client id wins the
 * item: the inserted block shows right before the new list, above the
 * item it followed. The text keeps its order.
 */
export const insertedAbove: Residual = (wrong, moves, winner) =>
	wrong === 'inserted' &&
	moves.some(
		([g, x], k) =>
			(g === 'divider' || g === 'code') &&
			k !== winner &&
			moves[winner][0] !== 'backspace' &&
			moves[winner][1] > x
	);
