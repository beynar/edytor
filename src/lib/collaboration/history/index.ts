/**
 * The version history panel: a room's stored versions, a read-only preview
 * of one with the blocks changed since highlighted, and Restore / Undo
 * restore (site `server/history-panel`).
 */
export { default as HistoryPanel } from './HistoryPanel.svelte';
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
export { defaultHistoryLabels, type HistoryPanelLabels, type HistoryPanelProps } from './panel.js';
