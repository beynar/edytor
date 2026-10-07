/**
 * The public surface (WU-10, API-01/API-02): what each entry point exports
 * and what the emitted declarations show of the view's classes.
 *
 * - The wire and coordinator vocabulary (frames, message types, codecs,
 *   generation records, admission internals, raw provider classes) lives
 *   in `edytor/protocol` only: neither the root nor `edytor/crdt/edytor`
 *   exports it.
 * - The committed API report (`api/*.api.md`, `scripts/api-report.mjs`)
 *   is the reviewed surface: a change to what the package exports, or to
 *   an exported declaration, fails here until the report is regenerated
 *   (`pnpm api:report`) and the diff reviewed.
 * - Plumbing members (`@internal`, stripped by `stripInternal`) never
 *   reach the emitted `.d.ts`.
 */
import { describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as bindings from '$lib/crdt/index.js';
import * as protocol from '$lib/crdt/protocol.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const report = (entry: string) => readFileSync(join(ROOT, 'api', `${entry}.api.md`), 'utf8');
/** The export names a report lists (`### name` headings). */
const names = (entry: string) =>
	[...report(entry).matchAll(/^### (\S+)$/gm)].map((match) => match[1]);
/** The emitted declaration of `name` in a report. */
const declaration = (entry: string, name: string) => {
	const text = report(entry);
	const start = text.indexOf(`### ${name}\n`);
	if (start < 0) throw new Error(`${name} is not in ${entry}.api.md`);
	const end = text.indexOf('\n### ', start + 1);
	return text.slice(start, end < 0 ? undefined : end);
};

/** A class member declaration line (`name:`, `name(`, `get name(`, `readonly name:`). */
const declares = (member: string) =>
	new RegExp(`^\\s+(?:readonly |get |set )*${member}[?]?[:(<]`, 'm');

/** The wire and coordinator vocabulary: `edytor/protocol` only. */
const WIRE = [
	'GENERATION',
	'GENERATION_RECORD',
	'STORED_GENERATION_RECORD',
	'STORAGE_FORMAT',
	'PROTOCOL_VERSION',
	'PREVIOUS_SCHEMA',
	'META_KEY',
	'CLOSE',
	'MAX_FRAME_BYTES',
	'frame',
	'generationWord',
	'readProtocolVersion',
	'isPreviousGenerationRecord',
	'GenerationMismatchError',
	'messageSync',
	'messageAwareness',
	'messageAuth',
	'messageQueryAwareness',
	'messageSaved',
	'messageChunk',
	'messageYjsSyncStep1',
	'messageYjsSyncStep2',
	'messageYjsUpdate',
	'messagePermissionDenied',
	'messageReadOnly',
	'writePermissionDenied',
	'writeReadOnly',
	'chunkFrame',
	'createChunkReader',
	'ChunkLimitError',
	'applyAwarenessUpdate',
	'encodeAwarenessUpdate',
	'modifyAwarenessUpdate',
	'readAwarenessEntries',
	'writeAwarenessEntries',
	'createDecoder',
	'readVarUint',
	'readVarUint8Array',
	'writeVarUint8Array',
	'assertAdmission',
	'assertSchema',
	'assertUsableDoc',
	'checkSchema',
	'inspectAdmission',
	'isInitialized',
	'registryEmpty',
	'schemaVersion',
	'IndexeddbPersistence',
	'WebsocketProvider',
	'storeState'
];

describe('entry points', () => {
	test('edytor/protocol exports the wire and coordinator vocabulary, and bindCrdt', () => {
		for (const name of WIRE.filter((name) => !['IndexeddbPersistence', 'WebsocketProvider', 'storeState'].includes(name)))
			expect(protocol, name).toHaveProperty(name);
		expect(typeof protocol.bindCrdt).toBe('function');
		expect(typeof protocol.IndexeddbPersistence).toBe('function');
		expect(typeof protocol.WebsocketProvider).toBe('function');
		expect(protocol.GENERATION).toBe(protocol.generationWord(protocol.SCHEMA_VERSION));
	});

	test('edytor/crdt/edytor exports none of it', () => {
		for (const name of WIRE) expect(bindings, name).not.toHaveProperty(name);
		expect(typeof bindings.createDocument).toBe('function');
		expect(typeof bindings.bindCrdt).toBe('function');
	});

	test('the package maps edytor/protocol to the built protocol module', () => {
		expect(pkg.exports['./protocol']).toEqual({
			types: './dist/crdt/protocol.d.ts',
			default: './dist/crdt/protocol.js'
		});
	});

	// The plan's target is about 120; 132 is the reviewed list (WU-13 added
	// the command surface: PreventionError, isPrevention, Prevent,
	// AfterOperationPayload, CommandResult). A new root name is a decision.
	test('the root exports none of it, and about 120 names in all', () => {
		const root = names('edytor');
		for (const name of WIRE) expect(root, name).not.toContain(name);
		expect(root.length).toBeLessThanOrEqual(132);
		expect(names('edytor-protocol')).toEqual(expect.arrayContaining(WIRE));
	});
});

describe('declarations', () => {
	test('no plumbing member of the view reaches the emitted declarations', () => {
		const edytor = declaration('edytor', 'EdytorInstance');
		for (const member of [
			'projector',
			'surface',
			'pin',
			'attempts',
			'intentSerial',
			'markUserGesture',
			'onBeforeInput',
			'onCompositionStart',
			'isHandlingUserInput',
			'suppressCaretScrollDepth',
			'nodeToText',
			'textAt',
			'segmentOf',
			'attach',
			'crdt'
		])
			expect(edytor, member).not.toMatch(declares(member));
		for (const member of ['selection', 'dispatcher', 'transact', 'historyUndo', 'overlay'])
			expect(edytor, member).toMatch(declares(member));
		const selection = declaration('edytor', 'EdytorSelection');
		for (const member of [
			'onSelectionChange',
			'applySelectionSnapshot',
			'capturePointerDragStart',
			'handleTripleClick',
			'mint',
			'observed'
		])
			expect(selection, member).not.toMatch(declares(member));
		for (const member of ['select', 'setAtTextOffset', 'selectedMembers', 'state'])
			expect(selection, member).toMatch(declares(member));
		const block = declaration('edytor', 'Block');
		for (const member of ['attach', 'firstEditableText'])
			expect(block, member).not.toMatch(declares(member));
	});

	test('the committed API report is current (pnpm api:report regenerates it)', () => {
		execFileSync('node', [join(ROOT, 'scripts/api-report.mjs'), '--check'], {
			cwd: ROOT,
			stdio: 'pipe'
		});
	}, 240_000);
});
