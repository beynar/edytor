import { mount, unmount, type Snippet } from 'svelte';
import type { Edytor } from '$lib/edytor.svelte.js';
import type { Plugin } from '$lib/plugins.js';
import type { CommentChange } from '$lib/crdt/protocols/comments.js';
import { commentMarks } from '$lib/crdt/semantics.js';
import type { CommentsClient } from '$lib/collaboration/comments/client.js';
import { labelsWith, type PartialLabels } from '$lib/labels.js';
import CommentsSidebar from './CommentsSidebar.svelte';
import {
	CommentsController,
	type CommentNotice,
	type CommentUser,
	type PlacedThread
} from './CommentsController.svelte.js';

/** What a `card` snippet receives: one thread, the view's comments controller, and whether it is the active one. */
export type CommentCardPayload = {
	/** The thread, placed beside its text (its comments, its anchor's text, `resolved`). */
	thread: PlacedThread;
	/** The view's comments: the actions (reply, resolve, delete, `activate`), the user, `labels`. */
	comments: CommentsController;
	/** It is the active thread (its text is selected, or its card was pressed). */
	active: boolean;
};

export type CommentsPluginOptions = {
	/**
	 * Where the threads live: `createCommentsClient({ server, room })` for
	 * the room's (`routeDocumentComments`), `createMemoryCommentsClient` for
	 * threads in memory, or any object with `list` and `send`.
	 */
	client: CommentsClient;
	/**
	 * The current user: their id (the identity your server verifies; it
	 * decides who may delete a comment) or `{ id, name, avatar, color }`.
	 */
	user: string | CommentUser;
	/** How another user shows: their name, avatar and color, by id (default: the id). */
	users?: (id: string) => Omit<CommentUser, 'id'> | undefined;
	/**
	 * Notifications: each change this view hears (a thread added, a reply,
	 * a resolve or reopen, a delete), once; `own` when the current user made
	 * it (in this view or another).
	 */
	onComment?: (change: CommentChange, notice: CommentNotice) => void;
	/** Replace a thread card's markup (the sidebar still places it). */
	card?: Snippet<[CommentCardPayload]>;
	/** The words the sidebar and the toolbar button show, over the English ones. */
	labels?: PartialLabels<'comments'>;
};

const controllers = new WeakMap<Edytor, CommentsController>();

/** The comments plugin's controller of `edytor`; `undefined` when the plugin is not listed. */
export const commentsController = (edytor: Edytor): CommentsController | undefined =>
	controllers.get(edytor);

/**
 * Comments (Notion's): select text and press Comment in the toolbar (or
 * Mod+Shift+M) to start a thread on it. The thread's text carries its
 * anchor, a `comment:<id>` mark the document keeps through splits and
 * merges and that copy and cut leave behind; its comments live in the
 * client's store (the room's `threads` and `comments` tables). Open threads
 * are highlighted, and a sidebar beside the text (under it, on a narrow
 * screen) shows each one with its replies, a composer, Resolve and Re-open.
 */
export const createCommentsPlugin =
	(options: CommentsPluginOptions): Plugin =>
	(edytor) => {
		const labels = labelsWith('comments', options.labels);
		const user = typeof options.user === 'string' ? { id: options.user } : options.user;
		const comments = new CommentsController(edytor, {
			client: options.client,
			user,
			users: options.users,
			onComment: options.onComment,
			labels
		});
		controllers.set(edytor, comments);
		return {
			marks: {
				comment: {
					// The core renders `<span data-edytor-mark="comment:<id>">`, which the
					// controller's stylesheet highlights while the thread is open.
					tag: 'span',
					attributes: () => ({ 'data-edytor-comment': '' }),
					edge: commentMarks.comment.edge,
					copy: false,
					toolbar: { label: labels.comment, icon: '💬', run: () => comments.start() }
				}
			},
			hotkeys: {
				'mod+shift+m': ({ prevent }) => {
					if (comments.canComment) prevent(() => comments.start());
				}
			},
			onSelectionChange: () => comments.follow(),
			onEdytorAttached: () => {
				comments.connect();
				const sidebar = mount(CommentsSidebar, {
					target: edytor.overlay.layer!,
					props: { edytor, comments, card: options.card }
				});
				return () => {
					comments.destroy();
					void unmount(sidebar);
				};
			}
		};
	};
