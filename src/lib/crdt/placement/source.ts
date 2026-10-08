/**
 * Ranks minted from where a block comes from: the rank of a block promoted
 * into a slot (`promotedRank`), and the source rank of a block placed beside
 * its source (`sourceRank`), the same on every replica that saw the gap.
 */
import { decodeRank, encodeRank, rankBetween, RANK_VMIN } from './rank.js';

/**
 * The rank separator of a promoted slot: the lowest segment a rank can hold
 * (`rankBetween` only copies it from a promoted bound), so `slot + PROMOTED + rank` sorts after
 * `slot` and before every rank the slot's list minted after it — also one
 * that extends `slot`, as an insert between two adjacent digits does.
 */
const PROMOTED = encodeRank([{ v: RANK_VMIN, t: 0 }]);

/**
 * The rank of a block promoted into the slot ranked `slot` (read-time
 * promotion, and a promote-delete's planned moves): a valid rank, so an
 * insert beside a promoted block ranks against it like any other.
 */
export const promotedRank = (slot: string, rank: string): string => slot + PROMOTED + rank;

/**
 * Which side of a gap `(X, Y)` a block ranked by its source comes from
 * ({@link sourceRank}), in the order every serial run puts them: the
 * pieces a split of `X` creates, then the blocks leaving `X` for the gap
 * right after it (its children, a list's last items), then the blocks
 * leaving `Y` for the gap right before it (a list's first items).
 */
export const SOURCE_SIDE = { pieces: 0, after: 1, before: 2 } as const;

/**
 * The rank of a block ranked by where it came from for the gap
 * `(left, right)` right beside its source, not by who moved it.
 * Two peers splitting or lifting out of the same block at once rank their
 * blocks in the same gap; ranks drawn at random there (and tied by client
 * id) sorted one peer's blocks before the other's whatever the text order.
 * Here the rank is a base every replica that saw the same gap computes
 * alike (the gap's midpoint, a fixed tie), then the `side` it comes from
 * ({@link SOURCE_SIDE}: blocks from different sources share the gap, and
 * their paths are not comparable), then the ranks down the
 * block's `path` in its source (the block it stands at), each closed by
 * the lowest segment (a shorter rank then sorts first, as a prefix does),
 * then its `part` there (the caller's order among what stands at one
 * block), its first segment tied by `clientId`: two peers' blocks at one
 * part never share a rank (a later insert between two equal ranks could
 * not land between them), and each peer's blocks there stay together. A
 * segment tied by `clock`, the client's own next clock, follows that first
 * one: one client never mints one rank twice in a gap, even when the block
 * it first minted it for was deleted there and a peer's undo brings it
 * back, and what one gesture minted (the lines of one paste)
 * sorts before what its later gestures mint there, never among it.
 * `null` on a degenerate gap (`left >= right`): the caller ranks it as any
 * insert.
 */
export const sourceRank = (
	left: string | undefined,
	right: string | undefined,
	side: number,
	path: readonly string[],
	part: readonly number[],
	clientId: number,
	clock: number
): string | null => {
	if (left !== undefined && right !== undefined && left >= right) return null;
	const closed = path.flatMap((r) => [...decodeRank(r), { v: RANK_VMIN, t: SOURCE_TIE }]);
	const [first, ...rest] = part;
	const parts = [
		{ v: first, t: clientId },
		{ v: 0, t: clock },
		...rest.map((v) => ({ v, t: SOURCE_TIE }))
	];
	const own = [{ v: side, t: SOURCE_TIE }, ...closed, ...parts];
	return rankBetween(left, right, SOURCE_TIE, () => 0.5) + encodeRank(own);
};
/** The tie of a source rank's own segments: the same on every replica. */
const SOURCE_TIE = 0;
