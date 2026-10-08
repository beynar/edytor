/**
 * Comment threads, client side (site `plugins/comments`): the clients the
 * comments plugin reads and writes threads through, and the thread shapes
 * every store shares with the room (`edytor/cloudflare`).
 */
export {
	createCommentsClient,
	createMemoryCommentsClient,
	CommentRequestError,
	type CommentDocument,
	type CommentFeed,
	type CommentResult,
	type CommentsClient,
	type CommentsClientOptions,
	type MemoryCommentsClient,
	type MemoryCommentsClientOptions
} from './client.js';
export { commentAnchors } from '../../crdt/protocols/comments.js';
export type {
	CommentChange,
	CommentRequest,
	CommentRun,
	CommentSnapshot,
	CommentThread,
	ThreadComment
} from '../../crdt/protocols/comments.js';
