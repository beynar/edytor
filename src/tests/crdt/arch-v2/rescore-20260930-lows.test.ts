/**
 * Rescore 2026-09-30 — CRDT lows without a verdict.
 *
 * - Late void role (UW-21 residual, `text/runs.ts`): adopting a void role
 *   after a view subscribed re-parents the void's children at once, and the
 *   subscriber receives that as a `DocChange` right away (no later write
 *   needed), so every rendered view of the document follows.
 *
 * Expected values come from the rescore rows, never from running the code.
 */
// @ts-nocheck -- tests drive the facade through untyped fixtures.
import { describe, expect, it } from 'vitest';
import { createDocument } from '../../../lib/crdt/index.js';
import { tree } from './p1-harness.js';

describe('adopting a void role late reports the change (rescore low, UW-21)', () => {
	it('one DocChange at adoption: K leaves P for P’s slot', () => {
		const document = createDocument({
			value: {
				children: [
					{
						id: 'P',
						type: 'divider',
						content: [{ text: 'p' }],
						children: [{ id: 'K', type: 'paragraph', content: [{ text: 'k' }] }]
					},
					{ id: 'Z', type: 'paragraph', content: [{ text: 'z' }] }
				]
			}
		});
		const ed = document.facade;
		const changes = [];
		ed.onChange((c) => changes.push(c));
		expect(tree(ed)).toBe('P:"p"[K:"k"] Z:"z"');
		document.adoptSemantics({ roles: { divider: { void: true } } });
		expect(changes).toHaveLength(1);
		const [change] = changes;
		expect(change.local).toBe(false);
		expect([...change.moved].sort()).toEqual(['K', 'Z']);
		expect(change.order.get(null)).toEqual(['P', 'K', 'Z']);
		expect(change.order.get('P')).toEqual([]);
		expect([change.added.size, change.removed.size, change.content.size]).toEqual([0, 0, 0]);
		// Adopting the same role again changes nothing: no report.
		document.adoptSemantics({ roles: { divider: { void: true } } });
		expect(changes).toHaveLength(1);
		document.destroy();
	});
});
