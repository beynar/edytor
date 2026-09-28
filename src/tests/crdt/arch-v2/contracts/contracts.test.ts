/**
 * arch-v2 phase 2 P1.3 — the native branch's contract programs
 * (`programs.ts`, `adapter.ts`: copied verbatim from
 * `src/tests/native/contracts/` of `bey-native-foundation-prototype`) run
 * against arch-v2 through `arch-v2-adapter.ts`. Their literal expectations
 * are an independent cross-check; 11 of 12 hold on arch-v2 as written —
 * including `transport.three-author-held-release`, the program the native
 * prototype itself violates.
 *
 * One program meets a different arch-v2 answer. It stays here unchanged,
 * runs as `it.fails` (it flips red the day arch-v2 meets it), next to a row
 * that states what arch-v2 does instead:
 *
 * - `split.range-one-undo` — PINNED DIVERGENCE. The native engine restores
 *   the deleted characters with their original identities. arch-v2 restores
 *   them as copies (the engine's undo integrates new items; R16 keeps them in
 *   the stream that displayed them) and bridges identity for anchors on the
 *   undoing replica (`followUndo`). The text, the blocks and the one undo
 *   step hold; only the unit identities differ.
 *
 * `history.concurrent-double-delete` (A and B delete the same character
 * concurrently, each undoes) was a real defect until per-writer text delete
 * marks (`text/deletes.ts`, fork patch P11): A's undo brought the character
 * back although B still deleted it, and B's undo brought a second copy
 * (`abbc`). It now holds as written; its delivery-order variants are
 * `text-delete-marks.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { archV2Adapter } from './arch-v2-adapter.js';
import { block, tree } from './adapter.js';
import { candidatePrograms } from './programs.js';

const DIVERGING = new Set(['split.range-one-undo']);

describe('native contract programs on arch-v2 (gem 7)', () => {
	for (const program of candidatePrograms) {
		const row = DIVERGING.has(program.id) ? it.fails : it;
		row(`${program.id}: ${program.family}`, () => program.run(archV2Adapter));
	}
});

const paragraph = (id: string, text: string) => ({
	id,
	type: 'paragraph',
	text,
	units: text.split('').map((value) => ({ value, marks: {} })),
	children: []
});

describe('arch-v2 answers where the programs diverge', () => {
	it('split.range-one-undo on arch-v2: same text, blocks and one undo step; restored units are copies', () => {
		const a = archV2Adapter.create('a', [{ id: 'P', text: 'abcd' }]);
		try {
			const original = block(a.observe(), 'P').units.map((u) => u.id);
			const split = a.split('P', 1, 'Q', 3);
			expect(tree(a.observe())).toEqual([paragraph('P', 'a'), paragraph('Q', 'd')]);
			expect(a.undo(split)).toBe(split);
			expect(tree(a.observe())).toEqual([paragraph('P', 'abcd')]);
			const restored = block(a.observe(), 'P').units.map((u) => u.id);
			// The kept characters keep their identity; the deleted ones come back as copies.
			expect([restored[0], restored[3]]).toEqual([original[0], original[3]]);
			expect(restored[1]).not.toBe(original[1]);
			expect(restored[2]).not.toBe(original[2]);
		} finally {
			a.destroy();
		}
	});
});
