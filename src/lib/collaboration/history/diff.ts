/**
 * The block-level diff of a stored version against the current document,
 * which the version history panel highlights over its preview.
 *
 * Blocks are matched by id (a restore keeps ids wherever the document
 * still holds them, so the same block keeps its id across versions):
 *
 * - `removed`: the version holds it, the current document does not
 *   (removed since; a restore brings it back);
 * - `added`: the current document holds it, the version does not (added
 *   since; a restore deletes it);
 * - `changed`: both hold it with another type, data or content (a restore
 *   rewrites it). A move, or a change of its children alone, is no change
 *   of the block.
 */
import type { JSONBlock, JSONDoc } from '../../utils/json.js';

/** How a block of a version differs from the current document. */
export type VersionChange = 'added' | 'removed' | 'changed';

/** What {@link versionDiff} answers. */
export type VersionDiff = {
	/**
	 * The version, with each block added since inserted where the current
	 * document has it: after its nearest earlier sibling the preview holds
	 * under the same parent, else first under that parent. What a preview
	 * renders.
	 */
	preview: JSONDoc;
	/** Each differing block's change, by block id. */
	changes: Map<string, VersionChange>;
	/** Blocks added since the version. */
	added: number;
	/** Blocks removed since the version. */
	removed: number;
	/** Blocks changed since the version. */
	changed: number;
};

/** `value` with sorted keys, absent and empty objects alike under `empty` keys. */
const canonical = (value: unknown): string =>
	JSON.stringify(value, (_key, inner: unknown) => {
		if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) return inner;
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(inner).sort()) {
			const field = (inner as Record<string, unknown>)[key];
			// `data: {}` and `marks: {}` read as absent ones.
			if ((key === 'data' || key === 'marks') && isEmptyObject(field)) continue;
			sorted[key] = field;
		}
		return sorted;
	});

const isEmptyObject = (value: unknown) =>
	value !== null &&
	typeof value === 'object' &&
	!Array.isArray(value) &&
	Object.keys(value).length === 0;

/** A block's own facts: its type, data and content (no id, no children). */
const ownOf = (block: JSONBlock) =>
	canonical({ type: block.type, data: block.data ?? {}, content: block.content ?? [] });

/** A copy of JSON `value` (a Svelte `$state` proxy too, which `structuredClone` refuses). */
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** A block without its children, its other fields copied. */
const bare = (block: JSONBlock): JSONBlock => {
	const { children: _children, ...rest } = block;
	return copy(rest);
};

/**
 * The block-level diff of `version` against `current`: which blocks were
 * added, removed or changed since the version, and the preview showing
 * them all. Neither input is modified.
 */
export const versionDiff = (version: JSONDoc, current: JSONDoc): VersionDiff => {
	const preview = copy(version);
	const changes = new Map<string, VersionChange>();

	// The version's blocks, by id, as they stand in the preview.
	const placed = new Map<string, { block: JSONBlock; list: JSONBlock[] }>();
	const own = new Map<string, string>();
	const index = (list: JSONBlock[]) => {
		for (const block of list) {
			if (block.id !== undefined) {
				placed.set(block.id, { block, list });
				own.set(block.id, ownOf(block));
			}
			index(block.children ?? []);
		}
	};
	index(preview.children);

	const seen = new Set<string>();
	/** `list` of the current document under `parent` (`null`: the root), in reading order. */
	const walk = (list: JSONBlock[], parent: string | null) => {
		for (let at = 0; at < list.length; at++) {
			const block = list[at]!;
			if (block.id === undefined) {
				walk(block.children ?? [], parent);
				continue;
			}
			seen.add(block.id);
			const kept = own.get(block.id);
			if (kept !== undefined) {
				if (kept !== ownOf(block)) changes.set(block.id, 'changed');
			} else {
				changes.set(block.id, 'added');
				const host = parent === null ? null : placed.get(parent)!.block;
				const target = host === null ? preview.children : (host.children ??= []);
				// After the nearest earlier sibling the preview holds in the same list.
				let slot = 0;
				for (let before = at - 1; before >= 0; before--) {
					const sibling = list[before]!.id;
					const where = sibling === undefined ? undefined : placed.get(sibling);
					if (where?.list === target) {
						slot = target.indexOf(where.block) + 1;
						break;
					}
				}
				const added = bare(block);
				target.splice(slot, 0, added);
				placed.set(block.id, { block: added, list: target });
			}
			walk(block.children ?? [], block.id);
		}
	};
	walk(current.children, null);

	for (const id of own.keys()) if (!seen.has(id)) changes.set(id, 'removed');

	let [added, removed, changed] = [0, 0, 0];
	for (const change of changes.values()) {
		if (change === 'added') added++;
		else if (change === 'removed') removed++;
		else changed++;
	}
	return { preview, changes, added, removed, changed };
};
