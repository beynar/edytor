/**
 * Test oracle: the skeleton-snapshot diff that built a `DocChange` before
 * arch-v2 D9 (L63 / F-O7). Production no longer diffs snapshots — the doc's
 * index publishes a change report from its fold (`text/runs.ts`); this copy
 * is the reference that report is compared against on every commit.
 *
 * Pure: `version` is passed in instead of read from the facade counter.
 */
import type { BlockId, ProjectedBlock } from '../../lib/crdt/placement/model.js';
import type { ContentRun } from '../../lib/crdt/text/runs.js';
import type { DocChange } from '../../lib/crdt/edytor-doc.js';
import { cloneJsonSafe } from '../../lib/utils/json.js';

type JsonObj = Record<string, unknown>;

/** Per-commit skeleton snapshot — same shape as the facade's `DocSnap`. */
export type DocSnap = {
	nodes: Map<
		BlockId,
		{
			parent: BlockId | null;
			index: number;
			type: string;
			data: Record<string, unknown> | undefined;
			contentRef: readonly ContentRun[];
			contentKey?: string;
		}
	>;
	order: Map<BlockId | null, readonly BlockId[]>;
	nodeFor?: (id: BlockId) => ProjectedBlock;
};

const EMPTY_IDS = Object.freeze([]) as readonly BlockId[];

const safeKeyOf = (v: unknown): string => {
	try {
		return JSON.stringify(v ?? null);
	} catch {
		return JSON.stringify(cloneJsonSafe(v ?? null));
	}
};

const subtreeIds = (b: ProjectedBlock, out: Set<BlockId>): void => {
	out.add(b.id);
	for (const c of b.children) subtreeIds(c, out);
};

export const diffSnaps = (
	before: DocSnap,
	after: DocSnap,
	origin: unknown,
	local: boolean,
	version: number
): DocChange | null => {
	const added = new Map<BlockId, ProjectedBlock>();
	const removed = new Set<BlockId>();
	const moved = new Set<BlockId>();
	const meta = new Map<BlockId, { type: string; data?: JsonObj }>();
	const content = new Map<BlockId, readonly ContentRun[]>();
	const order = new Map<BlockId | null, readonly BlockId[]>();
	// Pass 1: added subtree ROOTS — descendants ride inside the root's spec.
	const covered = new Set<BlockId>();
	for (const id of after.nodes.keys()) {
		if (!before.nodes.has(id)) {
			const node = after.nodeFor!(id);
			added.set(id, node);
			subtreeIds(node, covered);
		}
	}
	// Pass 2: per-node diffs for pre-existing blocks.
	for (const [id, n] of after.nodes) {
		if (covered.has(id)) continue;
		const o = before.nodes.get(id)!;
		if (o.parent !== n.parent || o.index !== n.index) moved.add(id);
		if (o.type !== n.type || safeKeyOf(o.data) !== safeKeyOf(n.data)) {
			meta.set(id, {
				type: n.type,
				data:
					n.data === undefined || n.data === null ? undefined : (cloneJsonSafe(n.data) as JsonObj)
			});
		}
		if (o.contentRef !== n.contentRef) {
			const ko = (o.contentKey ??= safeKeyOf(o.contentRef));
			const kn = (n.contentKey ??= safeKeyOf(n.contentRef));
			if (ko !== kn) content.set(id, n.contentRef);
		}
	}
	// Pass 3: removed subtree ROOTS (an id whose BEFORE ancestor is also gone
	// is covered by that ancestor's removal).
	for (const [id, o] of before.nodes) {
		if (after.nodes.has(id)) continue;
		let coveredByRemoved = false;
		let p = o.parent;
		while (p !== null) {
			if (!after.nodes.has(p)) {
				coveredByRemoved = true;
				break;
			}
			p = before.nodes.get(p)?.parent ?? null;
		}
		if (!coveredByRemoved) removed.add(id);
	}
	// Pass 4: child-order changes. A parent's new list is authoritative.
	for (const [parent, ids] of after.order) {
		const prevIds = before.order.get(parent);
		if (!prevIds || prevIds.join('\u0000') !== ids.join('\u0000')) order.set(parent, ids);
	}
	for (const [parent] of before.order) {
		if (!after.order.has(parent)) order.set(parent, EMPTY_IDS);
	}
	if (
		added.size === 0 &&
		removed.size === 0 &&
		moved.size === 0 &&
		meta.size === 0 &&
		content.size === 0 &&
		order.size === 0
	) {
		return null;
	}
	return { origin, local, version, added, removed, moved, meta, content, order };
};
