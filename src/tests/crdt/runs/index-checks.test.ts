/**
 * The test lanes run with the index's self-checks on (`indexChecks`, set by
 * `src/tests/setup/index-checks.ts`): every fold compares the facts the index
 * maintains incrementally (P1, P3) with their rebuild.
 */
import { describe, expect, it } from 'vitest';
import { indexChecks } from '$lib/crdt/text/runs.js';

describe('index self-checks', () => {
	it('are on in this lane', () => expect(indexChecks.on).toBe(true));
});
