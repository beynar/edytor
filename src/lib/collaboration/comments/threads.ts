/**
 * A client's copy of a document's comment threads, merged from what it
 * hears — a request's answer, a change from the socket, a snapshot after a
 * reconnect — in whatever order they arrive: each thread keeps the state
 * of its newest change (its `rev`, the room's sequence number), so an
 * older answer never undoes a newer change, and a thread removed stays
 * removed.
 */
import type {
	CommentChange,
	CommentSnapshot,
	CommentThread
} from '../../crdt/protocols/comments.js';

export class CommentThreads {
	#threads = new Map<string, CommentThread>();
	/** Removed threads, with the sequence number of their removal. */
	#removed = new Map<string, number>();
	/** The newest sequence number heard. */
	seq = 0;

	/** The newest change heard about thread `id` (`-1`: none). */
	#known = (id: string) => this.#threads.get(id)?.rev ?? this.#removed.get(id) ?? -1;

	/** A change: applied when newer than what is known of its thread. Answers whether it was. */
	apply(change: CommentChange): boolean {
		const { thread } = change;
		if (change.seq <= this.#known(thread.id)) return false;
		if (change.type === 'removed') {
			this.#threads.delete(thread.id);
			this.#removed.set(thread.id, change.seq);
		} else {
			this.#threads.set(thread.id, { ...thread, rev: change.seq });
			this.#removed.delete(thread.id);
		}
		this.seq = Math.max(this.seq, change.seq);
		return true;
	}

	/** A thread as a request answered it (`noop`): kept when newer. */
	put(thread: CommentThread): boolean {
		if (thread.rev <= this.#known(thread.id)) return false;
		this.#threads.set(thread.id, thread);
		this.#removed.delete(thread.id);
		return true;
	}

	/**
	 * Every thread at sequence number `seq`: each newer one is kept, and a
	 * thread it lacks is removed unless a change after `seq` made it.
	 * Answers whether anything changed.
	 */
	snapshot({ seq, threads }: CommentSnapshot): boolean {
		let changed = false;
		const named = new Set<string>();
		for (const thread of threads) {
			named.add(thread.id);
			changed = this.put(thread) || changed;
		}
		for (const [id, thread] of this.#threads) {
			if (named.has(id) || thread.rev > seq) continue;
			this.#threads.delete(id);
			this.#removed.set(id, seq);
			changed = true;
		}
		this.seq = Math.max(this.seq, seq);
		return changed;
	}

	get(id: string): CommentThread | undefined {
		return this.#threads.get(id);
	}

	/** Every thread, oldest first. */
	list(): CommentThread[] {
		return [...this.#threads.values()].sort((a, b) => a.createdAt - b.createdAt);
	}
}
