/**
 * arch-v2 phase 2 P1.3 — the native branch's contract programs
 * (`programs.ts`, `adapter.ts`: copied verbatim from
 * `src/tests/native/contracts/` of `bey-native-foundation-prototype`) run
 * against arch-v2 through `arch-v2-adapter.ts`. Their literal expectations
 * are an independent cross-check; all 12 hold on arch-v2 as written —
 * including `transport.three-author-held-release`, the program the native
 * prototype itself violates.
 *
 * `split.range-one-undo` was a pinned divergence until fork patch YP20: the
 * native engine restores the deleted characters with their original
 * identities, and arch-v2 restored them as copies. A text delete is now its
 * writer's hold record, and the undo deletes the record: the characters
 * themselves show again, with their identities.
 *
 * `history.concurrent-double-delete` (A and B delete the same character
 * concurrently, each undoes) was a real defect until per-writer text deletes
 * (P11, then YP20's hold records): A's undo brought the character back
 * although B still deleted it, and B's undo brought a second copy (`abbc`).
 * It holds as written; its delivery-order variants are
 * `text-delete-marks.test.ts`.
 */
import { describe, it } from 'vitest';
import { archV2Adapter } from './arch-v2-adapter.js';
import { candidatePrograms } from './programs.js';

describe('native contract programs on arch-v2 (gem 7)', () => {
	for (const program of candidatePrograms)
		it(`${program.id}: ${program.family}`, () => program.run(archV2Adapter));
});
