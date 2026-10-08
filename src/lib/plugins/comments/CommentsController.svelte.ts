import type { Edytor } from '$lib/edytor.svelte.js';
import type { DocAnchor } from '$lib/crdt/index.js';
import type { Prepared } from '$lib/crdt/edytor-doc.js';
import type { CommandResult } from '$lib/session/commands.js';
import { selectedTextSpans } from '$lib/selection/visibility.js';
import { Text } from '$lib/text/text.svelte.js';
import { reveal } from '$lib/selection/replaceSelection.js';
import {
	COMMENT_MARK,
	commentAnchors,
	commentId,
	type CommentChange,
	type CommentRequest,
	type CommentRun,
	type CommentThread
} from '$lib/crdt/protocols/comments.js';
import { CommentThreads } from '$lib/collaboration/comments/threads.js';
import type {
	CommentFeed,
	CommentResult,
	CommentsClient
} from '$lib/collaboration/comments/client.js';
import { englishLabels, type CommentsLabels } from '$lib/labels.js';

/** Who a comment's author is, as the sidebar shows them. */
export type CommentUser = {
	id: string;
	/** Shown in place of the id. */
	name?: string;
	/** An avatar image URL; without one, the name's initial on `color`. */
	avatar?: string;
	color?: string;
};

/** What `onComment` receives with each change: whether the current user made it (here or elsewhere). */
export type CommentNotice = { own: boolean };

/** The thread being written: the text it will anchor, held by anchors so edits move it. */
export type CommentDraft = {
	/** The new thread's id (its anchor will be `comment:<id>`). */
	id: string;
	/** The text it was started on (a preview: the server keeps it as the thread's quote). */
	quote: string;
	/** The block it starts in. */
	block: string;
	/** Each run of selected text, by anchors. */
	spans: { start: DocAnchor; end: DocAnchor }[];
};

/** A thread as the sidebar places it: its anchor's runs (none: its text was deleted). */
export type PlacedThread = CommentThread & { runs: CommentRun[] };

/** What the controller takes from the plugin's options. */
export type CommentsControllerOptions = {
	client: CommentsClient;
	user: CommentUser;
	users?: (id: string) => Omit<CommentUser, 'id'> | undefined;
	onComment?: (change: CommentChange, notice: CommentNotice) => void;
	labels?: CommentsLabels;
};

const avatarColors = ['#e16259', '#d9730d', '#cb912f', '#448361', '#337ea9', '#9065b0', '#c14c8a'];

/**
 * The comments plugin's state and actions (`plugins/comments`): the
 * threads the client hears (merged by their newest change), each thread's
 * anchor read from the document (its `comment:<id>` mark), the thread being
 * written, the active one (the caret's, or the one clicked), and the
 * requests. The anchor mark is written by one dispatcher command
 * (`addComment`) once the server accepted the thread; a removed thread's
 * marks are its store's to remove (the room, or the memory client).
 */
export class CommentsController {
	/** The thread the caret is in, or the one picked in the sidebar. */
	active = $state<string | null>(null);
	/** The thread being written, before it is posted. */
	draft = $state.raw<CommentDraft | null>(null);
	/** The sidebar also shows the resolved threads. */
	showResolved = $state(false);
	/** The last request that failed (its message), until the next one succeeds. */
	error = $state<string | null>(null);
	/** Bumped when the threads change. */
	#version = $state(0);
	/** Bumped by every commit: the anchors are read again. */
	#revision = $state(0);
	#threads = new CommentThreads();
	#off: Array<() => void> = [];
	readonly client: CommentsClient;
	readonly user: CommentUser;
	readonly labels: CommentsLabels;

	constructor(
		private edytor: Edytor,
		private options: CommentsControllerOptions
	) {
		this.client = options.client;
		this.user = options.user;
		this.labels = options.labels ?? englishLabels.comments;
	}

	/** Every thread's anchor runs, read from the document at each commit. */
	readonly anchors: Map<string, CommentRun[]> = $derived.by(() => {
		void this.#revision;
		void this.#version;
		if (!this.edytor.root) return new Map();
		return commentAnchors(this.edytor.facade);
	});

	/** Every thread, in the order of its anchor in the document (threads with none last). */
	readonly threads: PlacedThread[] = $derived.by(() => {
		void this.#version;
		const { compare } = this.edytor.facade;
		return this.#threads
			.list()
			.map((thread) => ({ ...thread, runs: this.anchors.get(thread.id) ?? [] }))
			.sort((a, b) => {
				const [x, y] = [a.runs[0], b.runs[0]];
				if (!x || !y) return (x ? 0 : 1) - (y ? 0 : 1) || a.createdAt - b.createdAt;
				return compare(x.block, y.block) || x.offset - y.offset;
			});
	});

	/** The open threads whose text shows (what the sidebar places by default). */
	readonly open: PlacedThread[] = $derived(
		this.threads.filter((thread) => !thread.resolved && thread.runs.length > 0)
	);

	/** The resolved threads. */
	readonly resolved: PlacedThread[] = $derived(this.threads.filter((thread) => thread.resolved));

	/** The threads the sidebar shows: the open ones, the resolved ones on demand, the active one. */
	readonly shown: PlacedThread[] = $derived(
		this.threads.filter(
			(thread) =>
				thread.runs.length > 0 &&
				(!thread.resolved || this.showResolved || thread.id === this.active)
		)
	);

	/** The view may write: it may start, answer, resolve and delete comments. */
	get canComment() {
		return this.edytor.dispatcher.permits();
	}

	/** One thread, by id. */
	thread(id: string): PlacedThread | undefined {
		return this.threads.find((thread) => thread.id === id);
	}

	/** A user as the sidebar shows them: their name, avatar and color. */
	userOf = (id: string): CommentUser => {
		const known = id === this.user.id ? this.user : { id, ...this.options.users?.(id) };
		const name = known.name ?? (id === this.user.id ? this.labels.you : id);
		let hash = 0;
		for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
		const color = known.color ?? avatarColors[Math.abs(hash) % avatarColors.length]!;
		return { ...known, name, color };
	};

	/** Whether the current user may delete `comment` of `thread` (its author). */
	mayDelete = (thread: CommentThread, comment: { author: string }) =>
		this.canComment && comment.author === this.user.id && thread.comments.length > 0;

	// ── Wiring ───────────────────────────────────────────────────────────

	/** Start hearing the threads: the client's list, its changes, the document's commits. */
	connect = () => {
		const { edytor, client } = this;
		this.#off.push(edytor.facade.onChange(() => this.#revision++));
		const detach = client.attach?.({
			order: () => edytor.facade.order(),
			contentItems: (id) => edytor.facade.contentItems(id),
			unsetMark: (block, offset, length, mark) =>
				edytor.facade.unsetMark(block, offset, length, mark),
			// A store's removal is no step of this view's history.
			transact: (fn) => (edytor.doc._transaction ? fn() : edytor.dispatcher.outside(() => fn()))
		});
		if (detach) this.#off.push(detach);
		const unsubscribe = client.subscribe?.((message) => this.#hear(message));
		if (unsubscribe) this.#off.push(unsubscribe);
		void client.list().then(
			(snapshot) => {
				if (this.#threads.snapshot(snapshot)) this.#version++;
			},
			(error: unknown) => this.#fail(error)
		);
	};

	/** Stop hearing them (the editor is going away). */
	destroy = () => {
		for (const off of this.#off.splice(0)) off();
	};

	#hear = (message: CommentFeed) => {
		if (message.type === 'snapshot') {
			if (this.#threads.snapshot(message)) this.#version++;
			return;
		}
		this.#applied(message.change);
	};

	#applied = (change: CommentChange) => {
		if (!this.#threads.apply(change)) return;
		this.#version++;
		if (change.type === 'removed' && this.active === change.thread.id) this.active = null;
		try {
			this.options.onComment?.(change, { own: change.user === this.user.id });
		} catch (error) {
			console.error('[edytor] onComment threw', error);
		}
	};

	#fail = (error: unknown) => {
		this.error = error instanceof Error ? error.message : String(error);
	};

	/** Send one request; its change is applied here at once (the socket's echo is then old news). */
	#send = async (request: CommentRequest): Promise<CommentResult | null> => {
		try {
			const result = await this.client.send(request);
			this.error = null;
			if (result.status === 'applied') this.#applied(result.change);
			else if (this.#threads.put(result.thread)) this.#version++;
			return result;
		} catch (error) {
			this.#fail(error);
			return null;
		}
	};

	// ── Writing a thread ─────────────────────────────────────────────────

	/**
	 * Start a thread on the selected text (the toolbar's Comment button,
	 * Mod+Shift+M): each selected run, held by anchors while it is written;
	 * at a caret, its block's whole text. Answers whether a draft opened.
	 */
	start = (): boolean => {
		const { edytor } = this;
		if (!this.canComment) return false;
		const { facade, selection } = edytor;
		const { isCollapsed, startBlock } = selection.state;
		const spans = isCollapsed
			? (startBlock?.content ?? []).flatMap((part) =>
					part instanceof Text && part.length > 0
						? [{ text: part, start: 0, end: part.length }]
						: []
				)
			: selectedTextSpans(edytor).filter(({ start, end }) => end > start);
		if (spans.length === 0) return false;
		const anchored = spans.flatMap(({ text, start, end }) => {
			const block = text.parent.id;
			const from = facade.anchorAt(block, text.segStart + start, 'right');
			const to = facade.anchorAt(block, text.segStart + end, 'left');
			return from && to ? [{ start: from, end: to }] : [];
		});
		if (anchored.length === 0) return false;
		this.draft = {
			id: commentId(),
			quote: spans.map(({ text, start, end }) => text.stringContent.slice(start, end)).join(' '),
			block: spans[0]!.text.parent.id,
			spans: anchored
		};
		this.active = null;
		edytor.overlay.invalidate();
		return true;
	};

	/** Drop the thread being written; the editor takes the focus back. */
	cancel = () => {
		if (!this.draft) return;
		this.draft = null;
		this.#refocus();
	};

	/** The runs the draft's anchors cover now. */
	draftRuns = (draft: CommentDraft | null = this.draft): CommentRun[] => {
		const { facade } = this.edytor;
		return (draft?.spans ?? []).flatMap(({ start, end }) => {
			const [from, to] = [facade.resolveAnchor(start), facade.resolveAnchor(end)];
			if (!from || !to || from.blockId !== to.blockId || to.offset <= from.offset) return [];
			return [{ block: from.blockId, offset: from.offset, length: to.offset - from.offset }];
		});
	};

	/**
	 * Post the thread being written: the server keeps it, then its anchor
	 * mark is written over the draft's text (one `addComment` command, one
	 * undo step). Answers whether it was posted.
	 */
	submit = async (body: string): Promise<boolean> => {
		const draft = this.draft;
		if (!draft || !body.trim()) return false;
		const result = await this.#send({
			op: 'add',
			thread: draft.id,
			body,
			quote: draft.quote,
			block: draft.block
		});
		if (!result) return false;
		if (this.draft === draft) this.draft = null;
		this.#anchor(draft.id, this.draftRuns(draft));
		this.active = draft.id;
		this.#refocus();
		return true;
	};

	/** The one write of a thread's anchor: its mark over `runs`, one command. */
	#anchor = (thread: string, runs: CommentRun[]): CommandResult['status'] => {
		const { facade, dispatcher, idToBlock } = this.edytor;
		if (runs.length === 0) return 'noop';
		const mark = `${COMMENT_MARK}:${thread}`;
		const prepare = (payload: { thread: string; runs: CommentRun[] }): Prepared =>
			facade.compose(
				...payload.runs.map(({ block, offset, length }) =>
					facade.prepare.formatRange(block, offset, length, { [mark]: { id: payload.thread } })
				)
			);
		const block = idToBlock.get(runs[0]!.block) ?? this.edytor.root!;
		dispatcher.dispatch(
			'addComment',
			{ thread, runs },
			{ block },
			(payload, plan = prepare(payload)) => {
				if ('writes' in plan) facade.apply(plan);
			},
			prepare
		);
		return dispatcher.last?.operation === 'addComment' ? dispatcher.last.status : 'refused';
	};

	// ── A thread's actions ───────────────────────────────────────────────

	reply = async (thread: string, body: string) =>
		body.trim() ? (await this.#send({ op: 'reply', thread, body })) !== null : false;

	resolve = async (thread: string) => {
		const done = (await this.#send({ op: 'resolve', thread })) !== null;
		if (done && this.active === thread && !this.showResolved) this.active = null;
		return done;
	};

	reopen = async (thread: string) => (await this.#send({ op: 'reopen', thread })) !== null;

	/** Delete one comment; without `comment` (or its first), the whole thread. */
	remove = async (thread: string, comment?: string) =>
		(await this.#send({ op: 'delete', thread, ...(comment ? { comment } : {}) })) !== null;

	// ── The active thread ────────────────────────────────────────────────

	/** Make `thread` the active one (a click on its card); its text scrolls into view. */
	focus = (thread: string | null) => {
		this.active = thread;
		const run = thread ? this.anchors.get(thread)?.[0] : undefined;
		const block = run && this.edytor.idToBlock.get(run.block);
		if (block) {
			reveal(block);
			block.textAtOffset(run!.offset)?.text.node?.scrollIntoView?.({
				block: 'nearest',
				inline: 'nearest'
			});
		}
		this.edytor.overlay.invalidate();
	};

	/**
	 * The caret moved (`onSelectionChange`): the thread whose text holds it
	 * becomes the active one (an open one first), or none.
	 */
	follow = () => {
		if (this.draft) return;
		const { isCollapsed, startText, yStart } = this.edytor.selection.state;
		if (!isCollapsed || !startText) return;
		const block = startText.parent.id;
		const at = startText.segStart + yStart;
		const holds = (thread: PlacedThread) =>
			thread.runs.some(
				(run) => run.block === block && at > run.offset && at <= run.offset + run.length
			);
		const hit =
			this.threads.find((thread) => !thread.resolved && holds(thread)) ??
			(this.showResolved ? this.threads.find(holds) : undefined);
		const next = hit?.id ?? null;
		if (next !== this.active) {
			this.active = next;
			this.edytor.overlay.invalidate();
		}
	};

	/** The highlight of the threads' text: open threads, the active one stronger. */
	readonly css: string = $derived.by(() => {
		const rule = (id: string) => `[data-edytor-mark="${COMMENT_MARK}:${id}"]`;
		const lit = this.threads.filter(
			(thread) => !thread.resolved || (this.showResolved && thread.id === this.active)
		);
		if (lit.length === 0) return '';
		const active = this.active && lit.some((t) => t.id === this.active) ? this.active : null;
		return [
			`${lit.map((t) => rule(t.id)).join(',')}{background:var(--edytor-comment-highlight,rgb(255 212 0 / 0.14));border-bottom:2px solid var(--edytor-comment-underline,rgb(255 212 0 / 0.8));cursor:pointer}`,
			active ? `${rule(active)}{background:var(--edytor-comment-active,rgb(255 212 0 / 0.42))}` : ''
		].join('');
	});

	#refocus = () => {
		this.edytor.expectInternalFocus();
		this.edytor.node?.focus({ preventScroll: true });
		this.edytor.overlay.invalidate();
	};
}
