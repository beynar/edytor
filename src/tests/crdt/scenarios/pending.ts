/**
 * Pending §8 scenario registry (U02).
 *
 * DATA ONLY — entries have no `run` function, so they cannot be weakened into
 * a passing check. `src/tests/crdt-pending/pending.test.ts` (excluded from the
 * `pnpm test:crdt` gate; run explicitly via `pnpm test:crdt:pending`) renders
 * each row as an `it.todo` with its owning unit. When the owning unit lands
 * the required machinery, the entry is replaced by an active Scenario with the
 * plan's full required assertions — never edited down to fit a prototype.
 */
import type { PendingScenario } from './registry.js';

export const pendingScenarios: PendingScenario[] = [
	// ── U03 — move representation & conflict spec ────────────────────────
	// MV01–MV10 are ACTIVE via `active-model.ts` on the placement model
	// (ModelOps adapter) since U03 — see scenarios.test.ts.

	// ── U04 — text ownership through split/merge ─────────────────────────
	// TX01–TX09 and ST01–ST03 are ACTIVE via `active-text.ts` on the
	// placement+ownership model since U04 — see scenarios.test.ts. The
	// island/void *plugin-level* contract (void blocks refusing edits,
	// island isolation) is an operation-layer concern and remains covered
	// by the assembled-model work; the model-level cases are active.

	// ── U05 — rich text (run view, marks, atoms, decorations) ────────────
	// AN01–AN07 are ACTIVE via `active-richtext.ts` on the maintained run
	// view since U05 — see scenarios.test.ts plus the golden-semantics unit
	// tests in src/tests/crdt/runs/golden.test.ts.

	// ── U09 — selection, history, input ──────────────────────────────────
	{
		id: 'HI01',
		owner: 'U09',
		title: 'local move/split/merge undo after remote text/placement edits',
		reason:
			'engine-level structural inverses proved in U03/U04; full scenario needs integrated model + history scope'
	},
	{
		id: 'HI02',
		owner: 'U09',
		title: 'redo after deletion; grouped move; typing/mark/paste grouping',
		reason: 'needs integrated history semantics'
	},
	{
		id: 'SE01',
		owner: 'U09',
		title: 'forward/backward range spanning moved/split/merged content',
		reason: 'needs selection model on backing anchors'
	},
	{
		id: 'SE02',
		owner: 'U09',
		title: 'unicode graphemes, surrogate pairs, embeds, deleted anchors',
		reason: 'needs selection/offset contract'
	},
	{
		id: 'SE03',
		owner: 'U09',
		title: 'remote presence before/after reconnection and format mismatch',
		reason: 'needs awareness/presence layer (U07+U09)'
	},
	{
		id: 'IN01',
		owner: 'U09',
		title: 'native input/IME during remote move, split, or formatting',
		reason: 'needs browser-input integration'
	},

	// ── U07 — providers / persistence / migration ────────────────────────
	{
		id: 'SY02',
		owner: 'U07',
		title: 'cold IndexedDB reload, compaction, BroadcastChannel, cleanup',
		reason: 'needs ported persistence provider (snapshot/log reload subset is covered by SY01g/h)'
	},
	// ── U06 — assembled document model ──────────────────────────────────
	// SY03 is ACTIVE via `active-doc.ts` (SY03b–e) since U06: concurrent
	// bootstrap, reserved-key dedupe, idempotent init, and ops over the
	// unified surface all run in the green lane.
	{
		id: 'CO01',
		owner: 'U07',
		title: 'legacy fixtures, unsupported schemas/wire ops, offline old client',
		reason: 'needs migration/rejection machinery'
	},
	{
		id: 'CO02',
		owner: 'U07',
		title: 'repeat/concurrent migration from two tabs/clients',
		reason: 'needs migration machinery'
	},
	{
		id: 'CO03',
		owner: 'U07',
		title: 'interrupt migration around snapshot write/activation; resume/rollback',
		reason: 'needs migration machinery'
	},

	// ── U12 — package ────────────────────────────────────────────────────
	{
		id: 'PK01',
		owner: 'U12',
		title: 'packed fresh consumer with editor, providers and declarations',
		reason: 'needs the packed package boundary (U01 proved vendored-engine import only)'
	}
];
