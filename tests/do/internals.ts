/**
 * The room's parts behind an `AttachedDocument` (`src/lib/cloudflare/room/`),
 * for the rows that inject a fault or run a task by hand. White-box: none of
 * this is public API.
 */
import type { AttachedDocument } from '../../src/lib/cloudflare/index.js';
import type { RoomContext } from '../../src/lib/cloudflare/room/context.js';

export const internals = (room: AttachedDocument): RoomContext =>
	(room as unknown as { room: RoomContext }).room;

/** The room's next `failures` reads of its rows throw (a transient I/O error). */
export const failReads = (room: AttachedDocument, failures: number) => {
	const { storage } = internals(room);
	const records = storage.records.bind(storage);
	storage.records = (only) => {
		if (failures-- > 0) throw new Error('injected read failure');
		return records(only);
	};
};
