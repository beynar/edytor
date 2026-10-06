/**
 * Concurrent creations of one block id (H13, `id.same.concurrent` in
 * `docs/editor-delete-contract.md`, plan §2.1 "Identity").
 *
 * Caller ids are public API, so two writers may create block `N` at once.
 * The registry is a map: its last-writer-wins keeps the larger client's
 * node, and the engine keeps the other node's subtree (fork patch P14,
 * `Doc.keepReplaced` = {@link keepRegistryLosers}): deleted as a value of
 * the key, but its text, claims and placement stay live, never collected.
 *
 * The index shows each such LOSING INCARNATION written by a live writer
 * (a client id at or above the seed band, 2^26) through an implicit merge
 * claim: it is a block of its own under a derived id ({@link incarnationId},
 * `N` + U+0000 + its item's id, never a caller id: ingress drops control
 * characters), claimed by `N` before `N`'s own claims, in the order the
 * registry keeps the values (the largest client first). Its liveness is
 * `N`'s: deleted when either carries a delete mark. A seed's losing
 * incarnation (a writer below the band) shows nothing: seeds keep one
 * version per id (F-T17).
 *
 * Worker-safe: no Svelte, no browser globals.
 */
import type { EngineNode } from './engine-api.js';
import { REGISTRY_KEY, isNodeLike } from './schema.js';

/** Live writers draw uint53 ids; seeds write below this band (`seedUpdate`). */
export const LIVE_WRITERS = 2 ** 26;
/** The separator of a derived incarnation id (a character ingress never keeps). */
const MARK = '\u0000';

/** The engine item of a registry value, as P14 reads it. */
type RegistryItem = {
	id: { client: number; clock: number };
	deleted: boolean;
	parent: unknown;
	parentSub: string | null;
	left: RegistryItem | null;
	right: RegistryItem | null;
	content: { type?: unknown };
};

/** `Doc.keepReplaced` for edytor documents (fork P14): registry values keep their subtree. */
export const keepRegistryLosers = (item: unknown): boolean => {
	const parent = (item as RegistryItem).parent as {
		_item: unknown;
		doc: { share: Map<string, unknown> } | null;
	} | null;
	return parent?._item === null && parent.doc?.share.get(REGISTRY_KEY) === parent;
};

/** The derived id of a losing incarnation: its key and its item's id. */
export const incarnationId = (id: string, item: { id: { client: number; clock: number } }) =>
	`${id}${MARK}${item.id.client}.${item.id.clock}`;

/** Whether `id` is a derived incarnation id. */
export const isIncarnationId = (id: string): boolean => id.includes(MARK);

/** The registry key a derived incarnation id belongs to (`id` itself for any other id). */
export const baseIdOf = (id: string): string => {
	const at = id.indexOf(MARK);
	return at < 0 ? id : id.slice(0, at);
};

/** One shown losing incarnation of a registry key. */
export type Incarnation = { id: string; node: EngineNode };

/**
 * The losing incarnations of `id` the index shows, the largest client first
 * (the registry's own order, right to left): kept by P14, written by a live
 * writer. None while the key has no live value (a purge removed it).
 */
export const incarnationsOf = (
	registry: EngineNode,
	id: string,
	isKept: (item: unknown) => boolean
): Incarnation[] => {
	const map = (registry as unknown as { _map: Map<string, RegistryItem> })._map;
	const current = map.get(id);
	if (current === undefined || current.deleted) return [];
	const out: Incarnation[] = [];
	for (let it = current.left; it !== null && it.parentSub === id; it = it.left) {
		if (it.id.client < LIVE_WRITERS || !isKept(it)) continue;
		const node = it.content.type;
		if (isNodeLike(node)) out.push({ id: incarnationId(id, it), node });
	}
	return out;
};

/** The node of derived incarnation id `vid`, or `null` when the registry shows no such incarnation. */
export const incarnationNode = (
	registry: EngineNode,
	vid: string,
	isKept: (item: unknown) => boolean
): EngineNode | null => {
	const base = baseIdOf(vid);
	if (base === vid) return null;
	return incarnationsOf(registry, base, isKept).find((x) => x.id === vid)?.node ?? null;
};

/** The registry item a node is the value of (`null` for a node outside the registry). */
export const registryItemOf = (node: EngineNode, registry: EngineNode): RegistryItem | null => {
	const item = node._item as unknown as RegistryItem | null;
	return item !== null && item.parent === registry ? item : null;
};
