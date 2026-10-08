/**
 * The room's one alarm (`room.alarm.tasks`): each task's due time,
 * stored in the meta table (`due.<task>`), and the alarm set to the
 * earliest. The tasks themselves are their owners' (`AttachedDocument`
 * wires them): this module decides only when each runs.
 */
import { noTimers } from './shared.js';
import type { RoomContext } from './context.js';

/** The room's alarm tasks (`room.alarm.tasks`), in the order an alarm runs them. */
export type Task = 'history' | 'save' | 'purge' | 'retention' | 'forward' | 'expiry';
const TASKS: readonly Task[] = ['history', 'save', 'purge', 'retention', 'forward', 'expiry'];

/** What runs each task: a promise is awaited before the next task. */
export type TaskRunners = Record<Task, () => Promise<void> | void>;

export class Scheduler {
	/** Each alarm task's due time (`room.alarm.tasks`), mirrored in the meta table (`due.<task>`). */
	private dues: Partial<Record<Task, number>> = {};
	/** The alarm this instance set, or found set at its start (`null`: none). */
	private armed: number | null = null;

	constructor(
		private readonly room: RoomContext,
		private readonly tasks: TaskRunners
	) {}

	/** `task`'s due time, if it is due. */
	due(task: Task): number | undefined {
		return this.dues[task];
	}

	/** Read the alarm already set: a wake keeps every task due. */
	async readAlarm() {
		this.armed = await this.room.ctx.storage.getAlarm();
	}

	/** Forget every due time (a reset dropped the meta table). */
	forget() {
		this.dues = {};
	}

	/**
	 * Run every task due at the alarm's time, each re-arming itself or
	 * clearing its due row; then set the alarm to the earliest due time
	 * left (`AttachedDocument.alarm`).
	 */
	async alarm(): Promise<void> {
		const room = this.room;
		const at = Math.max(room.clock(), this.armed ?? -Infinity);
		this.armed = null;
		await room.storage.retryStart();
		noTimers(() => room.storage.heal());
		let failure: { error: unknown } | null = null;
		for (const task of TASKS) {
			const due = this.dues[task];
			if (due === undefined || due > at) continue;
			try {
				const running = this.tasks[task]();
				if (running !== undefined) await running;
			} catch (error) {
				failure ??= { error };
			}
		}
		// A task that could not run stays due: it runs again a minute later, never in a loop.
		for (const task of TASKS) {
			const due = this.dues[task];
			if (due !== undefined && due <= at) this.schedule(task, room.clock() + 60_000, 'replace');
		}
		this.arm();
		if (failure !== null) throw failure.error;
	}

	/**
	 * Arm `task` at `at` (`room.alarm.tasks`): a task already due keeps its
	 * time (a wake or an edit never moves a pending save), unless `earlier`
	 * (an earlier time wins: the purge tick) or `replace`. The due time is
	 * stored (meta `due.<task>`) and the alarm set to the earliest one.
	 */
	schedule(task: Task, at: number, mode: 'keep' | 'earlier' | 'replace' = 'keep') {
		const due = this.dues[task];
		if (due !== undefined && (mode === 'keep' || (mode === 'earlier' && due <= at))) return;
		this.dues[task] = at;
		try {
			this.room.sql.exec(
				`INSERT OR REPLACE INTO ${this.room.tables.meta} (key, value) VALUES (?, ?)`,
				`due.${task}`,
				at
			);
		} catch {
			// the rows cannot be written: memory and the alarm still hold it
		}
		this.arm();
	}

	/** Clear `task`'s due time. */
	unschedule(task: Task) {
		if (this.dues[task] === undefined) return;
		delete this.dues[task];
		try {
			this.room.sql.exec(`DELETE FROM ${this.room.tables.meta} WHERE key = ?`, `due.${task}`);
		} catch {
			// a stale row re-arms a task that finds nothing to do
		}
	}

	/** Set the alarm to the earliest due time (none due: the alarm set is left, and finds nothing). */
	private arm() {
		const next = Math.min(...Object.values(this.dues));
		if (!Number.isFinite(next) || this.armed === next) return;
		this.armed = next;
		void this.room.ctx.storage.setAlarm(next);
	}

	/** The due times stored (`due.<task>`); an alarm armed before the scheduler (none stored) is a due save. */
	readDues() {
		const rows = this.room.sql
			.exec<{
				key: string;
				value: number;
			}>(`SELECT key, value FROM ${this.room.tables.meta} WHERE key LIKE 'due.%'`)
			.toArray();
		this.dues = {};
		for (const { key, value } of rows) {
			const task = key.slice('due.'.length) as Task;
			if (TASKS.includes(task)) this.dues[task] = value;
		}
		if (rows.length === 0 && this.armed !== null && this.room.options.onSave) {
			this.schedule('save', this.armed);
		}
		this.arm();
	}
}
