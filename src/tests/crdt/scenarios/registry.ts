/**
 * Requirement-scenario registry for plan §8 (U02).
 *
 * Two kinds of entries:
 *
 * - {@link Scenario} — ACTIVE: a runnable function executed by
 *   `scenarios.test.ts` through the replica harness and the `CrdtOps`
 *   adapter. Assertions are the plan's required outcomes; they must hold on
 *   the adapter under test.
 * - {@link PendingScenario} — PENDING: data-only registry rows for §8 cases
 *   that require the not-yet-built model (move semantics, split/merge
 *   ownership, maintained rich-text view, providers, …). They are listed as
 *   `it.todo` by `src/tests/crdt-pending/pending.test.ts`, which is EXCLUDED
 *   from `pnpm test:crdt` (own vitest config + `pnpm test:crdt:pending`), so a
 *   pending entry can never silently run a weakened check. Owning units are
 *   annotated per entry.
 *
 * A §8 requirement may appear in BOTH lists: an active scenario can cover the
 * RawNodeOps-expressible subset while the full contract stays pending on its
 * owning unit.
 */
import type { PeerSet } from '../harness/peer-set.js';
import type { CrdtOps } from '../harness/ops/crdt-ops.js';

export type Scenario = {
	/** Unique scenario id, e.g. 'SY01a'. */
	id: string;
	/** §8 requirement id this contributes to, e.g. 'SY01'. */
	requirement: string;
	title: string;
	/** Free-running scenario body; helpers come from the harness. */
	run: () => void;
};

export type PendingScenario = {
	/** §8 requirement id, e.g. 'MV02'. */
	id: string;
	title: string;
	/** Owning unit, e.g. 'U03'. */
	owner: string;
	/** What is missing / what the owning unit must implement for this to run. */
	reason: string;
};

/** Every requirement id in plan §8 — the completeness oracle. */
export const SECTION8_IDS = [
	'MV01',
	'MV02',
	'MV03',
	'MV04',
	'MV05',
	'MV06',
	'MV07',
	'MV08',
	'MV09',
	'MV10',
	'TX01',
	'TX02',
	'TX03',
	'TX04',
	'TX05',
	'TX06',
	'TX07',
	'TX08',
	'TX09',
	'ST01',
	'ST02',
	'ST03',
	'AN01',
	'AN02',
	'AN03',
	'AN04',
	'AN05',
	'AN06',
	'AN07',
	'HI01',
	'HI02',
	'SE01',
	'SE02',
	'SE03',
	'IN01',
	'SY01',
	'SY02',
	'SY03',
	'CO01',
	'CO02',
	'CO03',
	'PK01'
] as const;

/** Shared context handed to scenario helpers (scenarios mostly self-run). */
export type ScenarioCtx = {
	set: PeerSet;
	ops: CrdtOps;
};
