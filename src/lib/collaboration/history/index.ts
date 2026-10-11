/**
 * The version history: a room's stored versions, a read-only preview of one
 * with the blocks changed since highlighted, and Restore / Undo restore
 * (`VersionHistory`; site `server/history-panel`). The panel's markup is
 * the app's.
 */
export {
	createHistoryClient,
	HistoryRequestError,
	type HistoryClient,
	type HistoryClientOptions,
	type HistoryRestoreResult,
	type HistoryUndoResult,
	type HistoryVersion
} from './client.js';
export { versionDiff, type VersionChange, type VersionDiff } from './diff.js';
export {
	VersionHistory,
	type VersionHistoryStatus,
	type VersionHistoryOptions
} from './panel.svelte.js';
