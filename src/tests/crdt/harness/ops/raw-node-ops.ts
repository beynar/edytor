/**
 * `RawNodeOps` — the first {@link CrdtOps} implementation, mapping the
 * operation contract directly onto vendored `Y.Node` primitives.
 *
 * Schema (the v14 analogue of the current v13 `{children, content}` map keys):
 *
 * - `doc.get('content')` — root node; its sequence holds top-level blocks.
 * - block: `Y.Node('block')` with attrs `id`, `type`, `data?`, plus two
 *   node-valued attrs: `content` → `Y.Node('content')` (sequence of text and
 *   inline-atom children) and `children` → `Y.Node('children')` (sequence of
 *   child blocks).
 * - inline atom: `Y.Node('inline')` inside the content sequence with attrs
 *   `id`, `type`, `data?`. One atom occupies one content position.
 *
 * IMPORTANT SEMANTICS — this adapter reproduces *today's* behavior: every
 * structural change (move / nest / unnest / split / merge) serializes the
 * block to a spec, deletes the original, and inserts a rebuilt copy. Logical
 * `id`s survive; engine identities (`_item.id`) do NOT
 * (`preservesIdentityOnMove === preservesIdentityOnSplitMerge === false`).
 * Concurrent structural ops can therefore produce convergent-but-wrong states
 * (e.g. two surviving copies of one logical block after concurrent moves) —
 * exactly the failure modes the pending MV/TX scenarios exist to pin down.
 * The harness records those outcomes as evidence; it does not weaken them.
 */
// @ts-nocheck -- vendored upstream source is plain JS; checked structurally, not via types.
import * as Y from '../../../../lib/crdt/vendor/yjs/src/index.js';
import type { Peer } from '../peer-set.js';
import type {
	BlockId,
	BlockSpec,
	ContentItem,
	CrdtOps,
	Destination,
	InlineSpec,
	ProjectedBlock,
	ProjectedDoc
} from './crdt-ops.js';

const ROOT_KEY = 'content';
const CONTENT_ATTR = 'content';
const CHILDREN_ATTR = 'children';
const BLOCK_NODE = 'block';
const INLINE_NODE = 'inline';

type YNode = InstanceType<typeof Y.Node>;

/** Resolve the container node that holds a destination's child list. */
const childrenContainer = (peer: Peer, parent: BlockId | null): YNode | null => {
	if (parent === null) return peer.doc.get(ROOT_KEY);
	const block = findBlock(peer, parent);
	return block ? (block.getAttr(CHILDREN_ATTR) as YNode) : null;
};

const contentContainer = (block: YNode): YNode => block.getAttr(CONTENT_ATTR) as YNode;

/** Depth-first search for a block node by logical id. */
const findBlock = (peer: Peer, id: BlockId): YNode | null => {
	const root = peer.doc.get(ROOT_KEY);
	const stack: YNode[] = [];
	root.forEach((child: unknown) => {
		if (child instanceof Y.Node) stack.push(child);
	});
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (node.getAttr?.('id') === id) return node;
		const children = node.getAttr?.(CHILDREN_ATTR) as YNode | undefined;
		children?.forEach((child: unknown) => {
			if (child instanceof Y.Node) stack.push(child);
		});
	}
	return null;
};

/** Index of `node` inside its containing sequence (sequence parents only). */
const indexInParent = (node: YNode): number => {
	const parent = node.parent as YNode | null;
	if (!parent) return -1;
	const arr = parent.toArray();
	return arr.findIndex((c: unknown) => c === node);
};

/** Build an integrable block subtree from a spec (detached). Exported for seeding. */
export const buildBlock = (spec: BlockSpec): YNode => {
	const block = new Y.Node(BLOCK_NODE);
	block.setAttr('id', spec.id);
	block.setAttr('type', spec.type);
	if (spec.data !== undefined) block.setAttr('data', spec.data);
	const content = new Y.Node('content');
	const children = new Y.Node('children');
	block.setAttr(CONTENT_ATTR, content);
	block.setAttr(CHILDREN_ATTR, children);
	// Pre-integration writes persist and materialize when the subtree
	// integrates into the doc. `length` is a read — it warns on detached
	// nodes — so offsets are tracked locally (text counts per char).
	let clen = 0;
	for (const item of spec.content ?? []) {
		if (item.kind === 'text') {
			content.insert(clen, item.text, item.marks);
			clen += item.text.length;
		} else {
			content.insert(clen, [buildInline(item)]);
			clen += 1;
		}
	}
	let chlen = 0;
	for (const child of spec.children ?? []) {
		children.insert(chlen, [buildBlock(child)]);
		chlen++;
	}
	return block;
};

const buildInline = (atom: { id: string; type: string; data?: Record<string, unknown> }): YNode => {
	const node = new Y.Node(INLINE_NODE);
	node.setAttr('id', atom.id);
	node.setAttr('type', atom.type);
	if (atom.data !== undefined) node.setAttr('data', atom.data);
	return node;
};

/** Serialize a live block node back into a {@link BlockSpec}. */
const specOf = (block: YNode): BlockSpec => {
	const spec: BlockSpec = {
		id: block.getAttr('id'),
		type: block.getAttr('type')
	};
	const data = block.getAttr('data');
	if (data !== undefined) spec.data = structuredClone(data);
	spec.content = contentSpecOf(contentContainer(block));
	const childrenNode = block.getAttr(CHILDREN_ATTR) as YNode;
	const children: BlockSpec[] = [];
	childrenNode.forEach((child: unknown) => {
		if (child instanceof Y.Node) children.push(specOf(child));
	});
	if (children.length > 0) spec.children = children;
	return spec;
};

/** Serialize one content node's sequence into {@link ContentItem} runs. */
const contentSpecOf = (content: YNode): ContentItem[] => {
	const items: ContentItem[] = [];
	for (const op of content.delta.toJSON().children ?? []) {
		if (op.type !== 'insert') continue;
		if (typeof op.insert === 'string') {
			items.push({ kind: 'text', text: op.insert, marks: op.format });
		} else if (Array.isArray(op.insert)) {
			for (const entry of op.insert) {
				// Child nodes serialize as nested delta objects.
				const attrs: Record<string, { value?: unknown }> = entry?.attrs ?? {};
				items.push({
					kind: 'inline',
					id: attrs.id?.value as string,
					type: attrs.type?.value as string,
					data: attrs.data?.value as Record<string, unknown> | undefined
				});
			}
		}
	}
	return items;
};

/**
 * Slice the formatted content items of `content` from `offset` to the end.
 * Text runs straddling the offset are cut; inline atoms count as 1 position.
 * Operates on the delta view so mark fidelity is preserved in the copy.
 */
const contentTail = (content: YNode, offset: number): ContentItem[] => {
	const items: ContentItem[] = [];
	let pos = 0;
	for (const op of content.delta.toJSON().children ?? []) {
		if (op.type !== 'insert') continue;
		if (typeof op.insert === 'string') {
			const start = pos;
			pos += op.insert.length;
			if (pos <= offset) continue;
			items.push({
				kind: 'text',
				text: op.insert.slice(Math.max(0, offset - start)),
				marks: op.format
			});
		} else if (Array.isArray(op.insert)) {
			for (const entry of op.insert) {
				pos += 1;
				if (pos <= offset) continue;
				const attrs: Record<string, { value?: unknown }> = entry?.attrs ?? {};
				items.push({
					kind: 'inline',
					id: attrs.id?.value as string,
					type: attrs.type?.value as string,
					data: attrs.data?.value as Record<string, unknown> | undefined
				});
			}
		}
	}
	return items;
};

/** Marks-equivalence helper for projection diffs. */
const cleanMarks = (marks: Record<string, unknown> | undefined) =>
	marks && Object.keys(marks).length > 0 ? marks : undefined;

export const createRawNodeOps = (): CrdtOps => {
	const ops: CrdtOps = {
		name: 'raw-node',
		preservesIdentityOnMove: false,
		preservesIdentityOnSplitMerge: false,

		insertBlock(peer, dest, spec) {
			return peer.transact(() => {
				const container = childrenContainer(peer, dest.parent);
				if (!container) throw new Error(`insertBlock: unknown parent ${dest.parent}`);
				const at = Math.max(0, Math.min(dest.index, container.length));
				container.insert(at, [buildBlock(spec)]);
				return true;
			});
		},

		deleteBlock(peer, id) {
			const block = findBlock(peer, id);
			if (!block) return false;
			peer.transact(() => {
				const parent = block.parent as YNode;
				parent.delete(indexInParent(block), 1);
			});
			return true;
		},

		moveBlock(peer, id, dest) {
			const block = findBlock(peer, id);
			const container = childrenContainer(peer, dest.parent);
			if (!block || !container) return false;
			// Reject moves into the block's own subtree without mutating.
			// Walking `.parent` covers every ancestor (children containers sit
			// one hop below their owning block; the root container ends at null).
			for (let p: YNode | null = container; p; p = p.parent as YNode | null) {
				if (p === block) return false;
			}
			return peer.transact(() => {
				const spec = specOf(block);
				(block.parent as YNode).delete(indexInParent(block), 1);
				// Final-index semantics: `dest.index` counts the destination's
				// children AFTER the moved block was removed from it.
				const at = Math.min(Math.max(dest.index, 0), container.length);
				container.insert(at, [buildBlock(spec)]);
				return true;
			});
		},

		moveBlocks(peer, ids, dest) {
			// Copy adapter: no placement layer — a group move is one transaction
			// of sequential copy-moves (engine identities still churn; that is
			// the documented evidence this adapter exists to produce).
			return peer.transact(() => {
				let ok = true;
				for (const id of ids) {
					ok = ops.moveBlock(peer, id, dest) && ok;
					dest = { parent: dest.parent, index: dest.index + 1 };
				}
				return ok;
			});
		},

		nestBlock(peer, id, newParentId) {
			const parent = findBlock(peer, newParentId);
			if (!parent) return false;
			const children = parent.getAttr(CHILDREN_ATTR) as YNode;
			return ops.moveBlock(peer, id, { parent: newParentId, index: children.length });
		},

		unNestBlock(peer, id) {
			const pos = ops.positionOf(peer, id);
			if (!pos || pos.parent === null) return false;
			const parentPos = ops.positionOf(peer, pos.parent);
			if (!parentPos) return false;
			return ops.moveBlock(peer, id, {
				parent: parentPos.parent,
				index: parentPos.index + 1
			});
		},

		splitBlock(peer, id, offset, newId) {
			const block = findBlock(peer, id);
			if (!block) return false;
			return peer.transact(() => {
				const content = contentContainer(block);
				const at = Math.max(0, Math.min(offset, content.length));
				// Slice the tail off the *formatted* content so marks and inline
				// atoms carry over; text runs straddling the offset are split.
				const tailItems = contentTail(content, at);
				content.delete(at, content.length - at);
				// Children follow the split (current editor contract).
				const children = block.getAttr(CHILDREN_ATTR) as YNode;
				const childSpecs: BlockSpec[] = [];
				children.forEach((c: unknown) => {
					if (c instanceof Y.Node) childSpecs.push(specOf(c));
				});
				while (children.length > 0) children.delete(0, 1);
				const sibling = buildBlock({
					id: newId,
					type: block.getAttr('type'),
					data: block.getAttr('data'),
					content: tailItems,
					children: childSpecs
				});
				// Insert next to THIS block instance inside its actual
				// container — never re-resolve the destination by logical id:
				// under duplicate placement (concurrent copy-moves) the logical
				// parent id can resolve to a different physical copy whose
				// length does not match `pos.index` → 'Exceeded content range'.
				const container = block.parent as YNode;
				container.insert(indexInParent(block) + 1, [sibling]);
				return true;
			});
		},

		mergeBlocks(peer, fromId, intoId) {
			if (fromId === intoId) return false;
			const from = findBlock(peer, fromId);
			const into = findBlock(peer, intoId);
			if (!from || !into) return false;
			return peer.transact(() => {
				const intoContent = contentContainer(into);
				const fromItems = contentSpecOf(contentContainer(from));
				for (const item of fromItems) {
					if (item.kind === 'text') {
						intoContent.insert(intoContent.length, item.text, item.marks);
					} else {
						intoContent.insert(intoContent.length, [buildInline(item)]);
					}
				}
				const intoChildren = into.getAttr(CHILDREN_ATTR) as YNode;
				const fromChildren = from.getAttr(CHILDREN_ATTR) as YNode;
				const specs: BlockSpec[] = [];
				fromChildren.forEach((c: unknown) => {
					if (c instanceof Y.Node) specs.push(specOf(c));
				});
				for (const spec of specs) {
					intoChildren.insert(intoChildren.length, [buildBlock(spec)]);
				}
				const parent = from.parent as YNode;
				parent.delete(indexInParent(from), 1);
				return true;
			});
		},

		insertText(peer, id, offset, text, marks) {
			const block = findBlock(peer, id);
			if (!block) return false;
			peer.transact(() => {
				const content = contentContainer(block);
				content.insert(Math.max(0, Math.min(offset, content.length)), text, marks);
			});
			return true;
		},

		deleteText(peer, id, offset, length) {
			const block = findBlock(peer, id);
			if (!block) return false;
			peer.transact(() => {
				const content = contentContainer(block);
				const at = Math.max(0, Math.min(offset, content.length));
				if (at < content.length) content.delete(at, Math.min(length, content.length - at));
			});
			return true;
		},

		setMark(peer, id, offset, length, name, value) {
			const block = findBlock(peer, id);
			if (!block) return false;
			return peer.transact(() => {
				const content = contentContainer(block);
				// Clamp like deleteText: retain past the end throws
				// 'Exceeded content range' in applyDelta — an out-of-range
				// target is a no-op (false), never an exception.
				const at = Math.max(0, Math.min(offset, content.length));
				const len = Math.min(length, content.length - at);
				if (len <= 0) return false;
				content.format(at, len, { [name]: value });
				return true;
			});
		},

		unsetMark(peer, id, offset, length, name) {
			const block = findBlock(peer, id);
			if (!block) return false;
			return peer.transact(() => {
				const content = contentContainer(block);
				const at = Math.max(0, Math.min(offset, content.length));
				const len = Math.min(length, content.length - at);
				if (len <= 0) return false;
				content.format(at, len, { [name]: null });
				return true;
			});
		},

		insertInline(peer, id, offset, atom: InlineSpec) {
			const block = findBlock(peer, id);
			if (!block) return false;
			peer.transact(() => {
				const content = contentContainer(block);
				content.insert(Math.max(0, Math.min(offset, content.length)), [buildInline(atom)]);
			});
			return true;
		},

		removeInline(peer, id, inlineId) {
			const block = findBlock(peer, id);
			if (!block) return false;
			return peer.transact(() => {
				const content = contentContainer(block);
				const items = content.toArray();
				for (let i = 0; i < items.length; i++) {
					const entry = items[i];
					if (entry instanceof Y.Node && entry.getAttr('id') === inlineId) {
						content.delete(i, 1);
						return true;
					}
				}
				return false;
			});
		},

		project(peer) {
			const projectChildren = (container: YNode): ProjectedBlock[] => {
				const out: ProjectedBlock[] = [];
				container.forEach((child: unknown) => {
					if (!(child instanceof Y.Node)) return;
					const data = child.getAttr('data');
					// Defensive reads: under lossy reload schedules a node can
					// surface whose attrs no longer resolve (tombstoned subtree
					// state). Project it best-effort and mark it — the structural
					// checker reports `malformed-node` instead of the projector
					// crashing and masking the real outcome.
					const contentNode = child.getAttr(CONTENT_ATTR);
					const childrenNode = child.getAttr(CHILDREN_ATTR);
					const malformed = !(contentNode instanceof Y.Node) || !(childrenNode instanceof Y.Node);
					const content = (contentNode instanceof Y.Node ? contentSpecOf(contentNode) : []).map(
						(item) => (item.kind === 'text' ? { ...item, marks: cleanMarks(item.marks) } : item)
					);
					const projected: ProjectedBlock = {
						id: child.getAttr('id'),
						type: child.getAttr('type'),
						data: data === undefined ? undefined : structuredClone(data),
						content,
						children: childrenNode instanceof Y.Node ? projectChildren(childrenNode) : []
					};
					if (malformed) projected.malformed = true;
					out.push(projected);
				});
				return out;
			};
			return { children: projectChildren(peer.doc.get(ROOT_KEY)) };
		},

		resolveBlock(peer, id) {
			return findBlock(peer, id);
		},

		crdtId(peer, id) {
			const block = findBlock(peer, id);
			const item = block?._item;
			if (!block || !item || item.deleted) return null;
			return `${item.id.client}:${item.id.clock}`;
		},

		blockText(peer, id) {
			const block = findBlock(peer, id);
			if (!block) return null;
			return contentContainer(block)
				.toArray()
				.map((entry: unknown) => (entry instanceof Y.Node ? '' : entry))
				.join('');
		},

		listBlockIds(peer) {
			const ids: BlockId[] = [];
			const walk = (container: YNode) => {
				container.forEach((child: unknown) => {
					if (!(child instanceof Y.Node)) return;
					ids.push(child.getAttr('id'));
					walk(child.getAttr(CHILDREN_ATTR) as YNode);
				});
			};
			walk(peer.doc.get(ROOT_KEY));
			return ids;
		},

		positionOf(peer, id) {
			const block = findBlock(peer, id);
			if (!block) return null;
			const container = block.parent as YNode | null;
			if (!container) return null;
			const index = indexInParent(block);
			// Root container has no _item / parentSub; a children container's
			// parent is its block node.
			const parentBlock = container.parent as YNode | null;
			if (!parentBlock || container._item == null) return { parent: null, index };
			return { parent: parentBlock.getAttr('id') as BlockId, index };
		}
	};
	return ops;
};
