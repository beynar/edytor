/** @jsxImportSource ./jsx */
import { describe, expect, it } from 'vitest';
import { Y } from '$lib/crdt/engine.js';
import { createOperationEdytor } from './test.utils.js';
import { Block, deriveContentParts } from '$lib/block/block.svelte.js';
import { deltaToJson, runsToDeltas } from '$lib/text/deltas.js';
import type { ProjectedBlock } from '$lib/crdt/index.js';
import type { JSONBlock } from '$lib/utils/json.js';
import type { Edytor } from '$lib/edytor.svelte.js';

/**
 * Incremental-mirror equivalence oracle — serialize a `ProjectedBlock` to
 * the exact JSON shape `Block.value` produces, so the wrapper tree can be
 * compared against the canonical projected tree after every commit (the
 * same contract `src/tests/crdt/doc/mirror.test.ts` proves for a dumb
 * mirror: DocChange patches reconstruct the fresh `project()` result).
 */
const projectedToValue = (node: ProjectedBlock): JSONBlock => {
	const children = node.children.map(projectedToValue);
	const content = deriveContentParts(node.content).flatMap((part) => {
		if (part.kind === 'text') {
			return deltaToJson(runsToDeltas(part.items)[0]);
		}
		return [{ id: part.item.id, type: part.item.type, data: part.item.data ?? {} }];
	});
	const value: JSONBlock = { type: node.type, id: node.id, children, content };
	value.data = node.data ?? {};
	if (!children.length) delete value.children;
	if (!content.length) delete value.content;
	return value;
};

const canonicalValue = (edytor: Edytor) => ({
	type: 'root',
	children: edytor.facade.project().children.map(projectedToValue)
});

/** Every registered non-pending wrapper is live, reachable, and indexed. */
const expectRegistryInvariants = (edytor: Edytor) => {
	let liveCount = 0;
	const walk = (block: Block, parent: Block) => {
		expect(block._live, `${block.id} must be live`).toBe(true);
		expect(block.parent).toBe(parent);
		expect(edytor.idToBlock.get(block.id)).toBe(block);
		liveCount++;
		block.children.forEach((child, index) => {
			expect(child.index, `${child.id} index`).toBe(index);
			walk(child, block);
		});
	};
	edytor.root!.children.forEach((child) => walk(child, edytor.root!));
	for (const [id, block] of edytor.idToBlock) {
		if (id === 'root' || edytor._pendingBlocks.has(id)) {
			continue;
		}
		expect(block._live, `${id} registered but dead`).toBe(true);
	}
	expect(edytor.idToBlock.size - edytor._pendingBlocks.size).toBe(liveCount + 1);
};

const expectConverged = (edytor: Edytor) => {
	expect(JSON.parse(JSON.stringify(edytor.value))).toEqual(
		JSON.parse(JSON.stringify(canonicalValue(edytor)))
	);
	expectRegistryInvariants(edytor);
};

describe('incremental mirror reconcile', () => {
	it('patches content/meta/order/structure per DocChange — equal to fresh projection', () => {
		const { edytor } = createOperationEdytor(
			(
				<root>
					<paragraph>Hello</paragraph>
					<paragraph>World</paragraph>
					<ordered-list>
						<list-item>one</list-item>
						<list-item>
							two
							<list-item>two-a</list-item>
							<list-item>two-b</list-item>
						</list-item>
						<list-item>three</list-item>
					</ordered-list>
					<paragraph>Tail</paragraph>
				</root>
			) as any
		);
		const root = edytor.root!;
		expectConverged(edytor);

		// content-only commit
		root.children[0].firstText.insertText({ value: '!', start: 5, end: 5 });
		expectConverged(edytor);

		// meta commit
		root.children[0].setBlock({ value: { type: 'heading', data: { level: 2 } } });
		expectConverged(edytor);

		// structural: move last paragraph to the top
		root.children[3].moveBlock({ path: [0] });
		expectConverged(edytor);

		// structural: nest then unnest
		const nested = root.children[3].nestBlock();
		expectConverged(edytor);
		nested?.unNestBlock();
		expectConverged(edytor);

		// delete a nested parent, keeping its children (moved-out subtree)
		const list = root.children.find((b) => b.type === 'ordered-list')!;
		const parentItem = list.children[1];
		const kept = [...parentItem.children];
		parentItem.removeBlock({ keepChildren: true });
		expectConverged(edytor);
		for (const child of kept) {
			// claimed children keep their wrapper — no drop+remount
			expect(child._live).toBe(true);
			expect(edytor.idToBlock.get(child.id)).toBe(child);
		}

		// delete a subtree outright
		list.removeBlock();
		expectConverged(edytor);

		// split + merge churn
		const splitText = root.children[1].firstText;
		const split = root.children[1].splitBlock({ index: 2, text: splitText });
		expectConverged(edytor);
		split?.mergeBlockBackward();
		expectConverged(edytor);

		// add a fresh child block (pending-wrapper adoption path)
		root.children[0].addChildBlock({
			block: { type: 'paragraph', content: [{ text: 'fresh' }] },
			index: -1
		});
		expectConverged(edytor);
	});

	it('applies REMOTE commits incrementally (two editors, one doc)', () => {
		const doc = new Y.Doc();
		const first = createOperationEdytor(
			(
				<root>
					<paragraph>Hello</paragraph>
					<ordered-list>
						<list-item>a</list-item>
						<list-item>b</list-item>
					</ordered-list>
				</root>
			) as any,
			{ doc }
		);
		const second = createOperationEdytor(
			(
				<root>
					<paragraph>Hello</paragraph>
					<ordered-list>
						<list-item>a</list-item>
						<list-item>b</list-item>
					</ordered-list>
				</root>
			) as any,
			{ doc }
		);
		expectConverged(second.edytor);

		// remote content edit — lands on second as a non-local DocChange
		first.edytor.root!.children[0].firstText.insertText({ value: '?', start: 5, end: 5 });
		expectConverged(second.edytor);
		expectConverged(first.edytor);

		// remote structural edit — same incremental path on the peer
		first.edytor.root!.children[1].children[0].removeBlock();
		expectConverged(second.edytor);

		// remote keepChildren move-out
		const remoteList = first.edytor.root!.children[1];
		const remoteParent = remoteList.children[0];
		const remoteKept = [...remoteParent.children];
		remoteParent.addChildBlock({
			block: { type: 'list-item', content: [{ text: 'nested' }] },
			index: -1
		});
		first.edytor.root!.children[1].children[0].removeBlock({ keepChildren: true });
		expectConverged(second.edytor);
		expectConverged(first.edytor);
		void remoteKept;
	});
});

describe('lazy value export', () => {
	it('does not compute the export on commit when nothing consumes it', () => {
		const { edytor } = createOperationEdytor(
			(
				<root>
					<paragraph>Hello</paragraph>
				</root>
			) as any
		);
		(edytor as any)._valueCache = null;
		edytor.root!.children[0].firstText.insertText({ value: '!', start: 5, end: 5 });
		expect((edytor as any)._valueCache).toBeNull();
	});

	it('memoizes per facade.version and recomputes after a commit', () => {
		const { edytor } = createOperationEdytor(
			(
				<root>
					<paragraph>Hello</paragraph>
				</root>
			) as any
		);
		const v1 = edytor.value;
		expect(edytor.value).toBe(v1); // same object — no recompute
		edytor.root!.children[0].firstText.insertText({ value: '!', start: 5, end: 5 });
		const v2 = edytor.value;
		expect(v2).not.toBe(v1);
		// U2: the export is the plain run projection — the inserted '!' has
		// no attribution boundary, so it merges into the 'Hello' run.
		const content = v2.children[0].content ?? [];
		expect(content).toEqual([{ text: 'Hello!' }]);
	});
});
