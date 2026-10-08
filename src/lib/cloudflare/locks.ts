/**
 * Per-block locks (`room.locks` in `docs/editor-delete-contract.md`):
 * a `validate` hook (accept-then-compensate) that keeps a locked block
 * its owner's. Worker-safe: no timers, no browser globals.
 *
 * A block is locked when its data names a user under `key` (default
 * `lockedBy`); with `subtree`, a lock also holds every block displayed
 * under it, the nearest locked ancestor deciding. A frame from another user
 * that touches a locked block — its text, data, type, place, children
 * shown, deletion — or that locks a block for someone else, or that moves
 * a block into or out of a locked subtree, is denied: the room writes the
 * frame's inverse (`room.validate.inverse`) and every replica converges on
 * the document without it. The owner (or a user `bypass` admits) edits it,
 * and unlocks it by removing the key.
 */
import type { FrameValidation, ValidatedBlock } from './DocumentRoom.js';

/** What {@link lockedBlocks} reads. */
export type LockOptions = {
	/** The data key naming a block's owner (default `'lockedBy'`): a string user id locks it. */
	key?: string;
	/** A lock also holds the blocks displayed under the locked one (default `false`). */
	subtree?: boolean;
	/** Users who edit locked blocks anyway (an admin): `true` admits the frame's user. */
	bypass?: (user: string) => boolean;
};

/** The deepest owner chain we walk (a document deeper than this is checked to this depth). */
const MAX_DEPTH = 256;

/**
 * The `validate` hook of per-block locks: pass it as `attachRoom`'s
 * `validate`, return it from `DocumentRoom.locks()`, or call it from your
 * own `validate` (`lockedBlocks(options)(frame) && …`).
 */
export const lockedBlocks =
	(options: LockOptions = {}) =>
	(frame: FrameValidation): boolean => {
		const key = options.key ?? 'lockedBy';
		if (options.bypass?.(frame.user) === true) return true;
		const ownerOf = (
			id: string | null,
			read: (id: string) => ValidatedBlock | null
		): string | undefined => {
			for (let depth = 0; id !== null && depth < MAX_DEPTH; depth++) {
				const block = read(id);
				if (block === null) return undefined;
				const owner = block.data[key];
				if (typeof owner === 'string' && owner !== '') return owner;
				if (!options.subtree) return undefined;
				id = block.parent;
			}
			return undefined;
		};
		return frame.touched.every((id) => {
			const was = ownerOf(id, frame.before);
			const now = ownerOf(id, frame.after);
			return (was === undefined || was === frame.user) && (now === undefined || now === frame.user);
		});
	};
