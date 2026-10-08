/**
 * The block drag's page margins (the delete contract's `dnd.reach`): where
 * a pointer outside the editor's content column still drops, and what
 * answers there (`marginAt`, `dropReach` in the block handles' geometry).
 *
 * - inside the content column: no margin (the blocks' own targets answer);
 * - left of it, the handle column (the drag's handle width): the reorder of
 *   the row at the pointer's height, whatever the reach;
 * - past the handle column on the left, and past the content's right edge:
 *   the first `BESIDE_MARGIN` px are the beside bands' place, the rest of the
 *   reach a reorder; beyond the reach, nothing;
 * - `--edytor-drop-reach` (px) sets the reach, else `DROP_REACH`; a reach
 *   under `BESIDE_MARGIN` cuts the beside place to it.
 *
 * Expected values come from the contract row, never from a run.
 */
import { describe, expect, it } from 'vitest';
import {
	BESIDE_MARGIN,
	DROP_REACH,
	dropReach,
	marginAt
} from '$lib/plugins/blockHandles/geometry.js';

/** Content from 100 to 700, a 46px handle column, the default reach. */
const editor = { start: 100, end: 700, handles: 46, reach: DROP_REACH };

describe('dnd.reach: the zones of a block drag outside the content column', () => {
	it('the defaults: a reach of 240px, the beside bands its first 120px', () => {
		expect(DROP_REACH).toBe(240);
		expect(BESIDE_MARGIN).toBe(120);
	});

	it('inside the content column (its edges included): no margin', () => {
		for (const x of [100, 101, 400, 699, 700]) expect(marginAt(x, editor)).toBeNull();
	});

	it('the handle column left of the content: a reorder, at any reach', () => {
		for (const x of [99, 80, 60, 54])
			expect(marginAt(x, editor)).toEqual({ side: 'left', zone: 'handles' });
		expect(marginAt(60, { ...editor, reach: 0 })).toEqual({ side: 'left', zone: 'handles' });
	});

	it('past the handle column: the beside place, then the reorder, then nothing', () => {
		// The handle column ends at 54; the beside place reaches 120px past it.
		expect(marginAt(53.5, editor)).toEqual({ side: 'left', zone: 'beside' });
		expect(marginAt(54 - 120, editor)).toEqual({ side: 'left', zone: 'beside' });
		expect(marginAt(54 - 121, editor)).toEqual({ side: 'left', zone: 'reorder' });
		expect(marginAt(54 - 240, editor)).toEqual({ side: 'left', zone: 'reorder' });
		expect(marginAt(54 - 241, editor)).toBeNull();
	});

	it('right of the content: the beside place, then the reorder, then nothing', () => {
		expect(marginAt(700.5, editor)).toEqual({ side: 'right', zone: 'beside' });
		expect(marginAt(700 + 120, editor)).toEqual({ side: 'right', zone: 'beside' });
		expect(marginAt(700 + 121, editor)).toEqual({ side: 'right', zone: 'reorder' });
		expect(marginAt(700 + 240, editor)).toEqual({ side: 'right', zone: 'reorder' });
		expect(marginAt(700 + 241, editor)).toBeNull();
	});

	it('a reach under the beside place cuts it; a reach of 0 leaves the handle column alone', () => {
		const short = { ...editor, reach: 60 };
		expect(marginAt(760, short)).toEqual({ side: 'right', zone: 'beside' });
		expect(marginAt(761, short)).toBeNull();
		expect(marginAt(54 - 60, short)).toEqual({ side: 'left', zone: 'beside' });
		expect(marginAt(54 - 61, short)).toBeNull();
		const none = { ...editor, reach: 0 };
		expect(marginAt(701, none)).toBeNull();
		expect(marginAt(53, none)).toBeNull();
	});

	it('a wider reach widens only the reorder', () => {
		const wide = { ...editor, reach: 400 };
		expect(marginAt(700 + 120, wide)).toEqual({ side: 'right', zone: 'beside' });
		expect(marginAt(700 + 400, wide)).toEqual({ side: 'right', zone: 'reorder' });
		expect(marginAt(700 + 401, wide)).toBeNull();
	});
});

describe('dnd.reach: --edytor-drop-reach', () => {
	const style = (value: string) =>
		({ getPropertyValue: (name: string) => (name === '--edytor-drop-reach' ? value : '') }) as
			| CSSStyleDeclaration
			| undefined;

	it('reads a px value', () => {
		expect(dropReach(style('320px'))).toBe(320);
		expect(dropReach(style(' 0px '))).toBe(0);
	});

	it('anything else is the default', () => {
		for (const value of ['', '12em', 'auto', '-10px']) expect(dropReach(style(value))).toBe(240);
		expect(dropReach(undefined)).toBe(240);
	});
});
