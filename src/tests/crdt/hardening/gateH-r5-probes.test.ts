/**
 * GATE H adversarial probes — R5 (commit-bound notifications).
 *
 * The `subscribeBlock` probes (throwing subscribers, the undo+repair
 * notification shape, reentrancy, mid-transaction subscription) went with
 * the per-block subscriber API at C1 (D-15): the change report
 * (`onChange`) is the one commit-bound publication, pinned by D9's F-O7.
 * Kept here: the `DocChange` surface around undo.
 */
// @ts-nocheck -- exercises private internals on purpose.
import { describe, expect, test } from 'vitest';
import * as Y from '../../../lib/crdt/vendor/yjs/src/index.js';
import { bindEdytorDoc } from '../../../lib/crdt/edytor-doc.js';

const E = bindEdytorDoc(Y);
let cid = 600_000;

describe('gateH-R5 — DocChange surface during undo+repair', () => {
	test('onChange ordering around the repair transaction', () => {
		const doc = new Y.Doc();
		doc.clientID = cid++;
		const ed = E.create(doc);
		ed.init({
			content: [{ id: 'b', type: 'paragraph', content: [{ kind: 'text', text: 'hello world' }] }]
		});
		ed.block('b').split(6, 'tail');
		const um = ed.createUndoManager({ captureTimeout: 0 });
		const changes: {
			origin: string;
			local: boolean;
			added: string[];
			content: [string, string][];
		}[] = [];
		ed.onChange((c: any) =>
			changes.push({
				origin: String(c.origin),
				local: c.local,
				added: [...c.added.keys()],
				content: [...c.content.entries()].map(([k, v]: any) => [
					k,
					v.map((r: any) => (r.kind === 'text' ? r.text : '#')).join('')
				])
			})
		);
		ed.block('tail').deleteText(0, 5);
		changes.length = 0;
		um.undo();
		for (const [i, c] of changes.entries()) {
			console.log(
				`[r5-docchange] #${i} origin=${c.origin.slice(0, 40)} local=${c.local} added=${JSON.stringify(c.added)} content=${JSON.stringify(c.content)}`
			);
		}
		// Final state is correct either way — what matters is whether any
		// DocChange carried the unrepaired ownership or mislabeled origin.
		expect(ed.blockText('tail')).toBe('world');
	});
});
