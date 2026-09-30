/**
 * DR-rest-3 — a plan whose step throws inside `apply` ends its fold frame.
 * The write funnel's `runsView.track()` frame stayed registered after the
 * throw and collected every later commit's facets for the life of the doc
 * (a leak with no other symptom), so this reads the index's frame count.
 */
import { describe, expect, it } from 'vitest';
import * as Y from '$lib/crdt/vendor/yjs/src/index.js';
import { bindRuns } from '$lib/crdt/text/runs.js';
import { createDocument, defaultSemantics } from '$lib/crdt/index.js';

const R = bindRuns(Y as never);

describe('DR-rest-3: apply ends its frame when a step throws', () => {
	it('no frame stays open after the throw', () => {
		const document = createDocument({
			value: { children: [{ id: 'p', type: 'paragraph', content: [{ text: 'hi' }] }] },
			semantics: defaultSemantics
		});
		const view = R.attach(document.doc as never);
		const plan = document.facade.prepare.insertText('p', 0, 'A');
		expect('writes' in plan).toBe(true);
		const broken = {
			...plan,
			writes: [
				{
					get op(): string {
						throw new Error('step failed');
					}
				}
			]
		};
		expect(() => document.facade.apply(broken as never)).toThrow('step failed');
		expect(view.debug.frames).toBe(0);
		expect(document.facade.insertText('p', 0, 'B').status).toBe('applied');
		expect(view.debug.frames).toBe(0);
		document.destroy();
	});
});
