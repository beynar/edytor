/**
 * The purge (`room.purge.*`): the daily tick records an epoch (the state
 * vector) when the document changed, and purges what was deleted before
 * the horizon — the newest epoch at least `purgeAfterDays` old — and what
 * the sessions whose history ended deleted (`hist.release.end`), as the
 * room's own transaction (`crdt/purge.ts`), then compacts. With no epoch
 * due, a tick still purges the ended sessions' deletes.
 */
import { Y } from '../../crdt/engine.js';
import { releasesOf, type PurgeReport } from '../../crdt/purge.js';
import { asEngineDoc } from '../../crdt/structs.js';
import { PURGE_ORIGIN, noTimers } from './shared.js';
import { DEFAULT_RETENTION_DAYS } from '../history.js';
import { DAY, crdt, knob, type RoomContext } from './context.js';
import { sameBytes } from './updates.js';

export class RoomPurge {
	constructor(private readonly room: RoomContext) {}

	/** Days after which deleted content is purged (`null`: never), `room.purge.timing`. */
	get days(): number | null {
		const days = this.room.options.purgeAfterDays;
		if (days === false) return null;
		return knob(days, this.room.history.config?.retentionDays ?? DEFAULT_RETENTION_DAYS, 36_500);
	}

	/** A change was stored at `at`: the purge tick runs a day later at the latest. */
	noteChange(at: number) {
		if (this.days !== null) this.room.scheduler.schedule('purge', at + DAY, 'earlier');
	}

	/**
	 * The purge task (`AttachedDocument.purge`): its report, `horizon` the
	 * epoch it purged to (`null`: only ended sessions' deletes).
	 */
	tick(): (PurgeReport & { horizon: number | null }) | null {
		const room = this.room;
		const { scheduler, sql, tables } = room;
		return noTimers(() => {
			const days = this.days;
			if (days === null) {
				scheduler.unschedule('purge');
				return null;
			}
			room.storage.heal();
			const doc = room.live;
			const now = room.clock();
			if (doc === null) {
				scheduler.schedule('purge', now + DAY, 'replace');
				return null;
			}
			// The cuts past their grace go (`room.reseed.grace`).
			room.reseed.prune(now);
			const sv = Y.encodeStateVector(doc);
			const newest = sql
				.exec<{ sv: ArrayBuffer }>(`SELECT sv FROM ${tables.epochs} ORDER BY at DESC LIMIT 1`)
				.toArray()[0];
			if (newest === undefined || !sameBytes(new Uint8Array(newest.sv), sv)) {
				sql.exec(`INSERT OR REPLACE INTO ${tables.epochs} (at, sv) VALUES (?, ?)`, now, sv);
			}
			const purged =
				sql
					.exec<{
						value: number;
					}>(`SELECT value FROM ${tables.meta} WHERE key = 'purged'`)
					.toArray()[0]?.value ?? -1;
			const horizon = sql
				.exec<{
					at: number;
					sv: ArrayBuffer;
				}>(
					`SELECT at, sv FROM ${tables.epochs} WHERE at <= ? ORDER BY at DESC LIMIT 1`,
					now - days * DAY
				)
				.toArray()[0];
			let result: (PurgeReport & { horizon: number | null }) | null = null;
			if (horizon !== undefined && horizon.at > purged) {
				result = this.#purgeTo({ at: horizon.at, sv: new Uint8Array(horizon.sv) });
			} else if (releasesOf(asEngineDoc(doc)).size > 0) {
				// No epoch is due: the ended sessions' deletes go all the same.
				result = this.#purgeTo(null);
			}
			// The next epoch to pass the horizon, or the next change, arms it again.
			const next = sql
				.exec<{
					at: number;
				}>(
					`SELECT at FROM ${tables.epochs} WHERE at > ? ORDER BY at LIMIT 1`,
					Math.max(purged, horizon?.at ?? -1)
				)
				.toArray()[0];
			if (next === undefined) scheduler.unschedule('purge');
			else scheduler.schedule('purge', Math.max(next.at + days * DAY, now + 1), 'replace');
			return result;
		});
	}

	/**
	 * Purge what was deleted before `horizon` and what ended sessions deleted
	 * (`null`: only those), as the room's own transaction, then compact. A
	 * purge of ended sessions' deletes that finds none left compacts nothing
	 * and reports `null`.
	 */
	#purgeTo(
		horizon: { at: number; sv: Uint8Array } | null
	): (PurgeReport & { horizon: number | null }) | null {
		const room = this.room;
		const doc = room.requireDoc();
		// A restore past the horizon can no longer be undone (`room.history.undo`).
		if (horizon !== null) room.history.expireRestore(horizon.at);
		room.history.closeSlotIfPast();
		let report!: PurgeReport;
		let wrote = true;
		room.transacting = true;
		try {
			room.facade.transact(() => {
				report = crdt.doc.purge(asEngineDoc(doc), room.facade, horizon);
				const tr = asEngineDoc(doc)._transaction as unknown as Record<
					'insertSet' | 'deleteSet',
					{ isEmpty(): boolean }
				>;
				wrote = !tr.insertSet.isEmpty() || !tr.deleteSet.isEmpty();
			}, PURGE_ORIGIN);
		} finally {
			room.transacting = false;
		}
		if (room.unstored !== null) {
			const error = room.unstored;
			room.storage.heal();
			throw error;
		}
		if (horizon !== null)
			room.ctx.storage.transactionSync(() => {
				room.sql.exec(
					`INSERT OR REPLACE INTO ${room.tables.meta} (key, value) VALUES ('purged', ?)`,
					horizon.at
				);
				room.sql.exec(`DELETE FROM ${room.tables.epochs} WHERE at < ?`, horizon.at);
			});
		const keys = [
			'removed',
			'emptied',
			'marks',
			'records',
			'claims',
			'merged',
			'released',
			'suggestions'
		] as const;
		// Nothing an ended session deleted was left: no compaction, no run.
		if (horizon === null && !wrote) return null;
		room.storage.compact();
		const counters = room.counters.purge;
		counters.runs++;
		if (horizon !== null) counters.horizon = horizon.at;
		for (const key of keys) counters[key] += report[key];
		room.log({
			edytor: 'purge',
			horizon: horizon?.at ?? null,
			bytes: room.counters.compaction.lastBytes,
			...report
		});
		return { ...report, horizon: horizon?.at ?? null };
	}
}
