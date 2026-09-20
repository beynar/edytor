/**
 * Pending §8 scenario lane — EXCLUDED from `pnpm test:crdt` (this directory is
 * outside the crdt include glob and runs under its own config). Each pending
 * registry row becomes an `it.todo`, so the entries are listed, named, and
 * owned without ever executing weakened assertions in a green gate.
 *
 * Run deliberately with: pnpm test:crdt:pending
 */
import { describe, it } from 'vitest';
import { pendingScenarios } from '../crdt/scenarios/pending.js';

describe('§8 pending scenarios (not runnable yet)', () => {
	for (const p of pendingScenarios) {
		it.todo(`[${p.id}] ${p.title} — owner ${p.owner} (${p.reason})`);
	}
});
