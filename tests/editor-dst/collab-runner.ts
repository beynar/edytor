import { createHash } from 'node:crypto';

import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

import * as Y from '../../src/lib/crdt/vendor/yjs/src/index.js';
import { attachDocument, type EdytorDocument } from '../../src/lib/crdt/index.js';
import { blockRecordsOf } from '../../src/tests/oracles/block-records.js';
import type { JSONBlock } from '../../src/lib/utils/json.js';
import { waitForEditorReady } from '../editor-dom/helpers.js';
import { startOpaqueRelay, type OpaqueRelay } from '../editor-dom/ws-relay.js';
import {
	assertActionEffect,
	assertBrowserSnapshot,
	assertTrustedAction,
	captureBrowserSnapshot,
	DstHarnessFailure,
	installEventRecorder,
	isStickyOutsideEscape,
	settleEditor,
	type DstBrowserSnapshot
} from './browserState.js';
import type { CollabSchedule, CollabStep } from './collab-generator.js';
import {
	acceptableSelectionShapes,
	passiveSelectionInvariantViolation,
	selectionMoved,
	type EndpointSpot
} from './selectionOracle.js';
import {
	assertDeleteIntent,
	performAction,
	resolveSelection,
	setSelection,
	type ResolvedSelection
} from './runner.js';

/**
 * GENERATED collaboration DST — the connected-peer counterpart to
 * `runner.ts`'s independent-document cross-browser DST. Two/three
 * independent browser CONTEXTS mount the same `dst` document under
 * `scenario=dst` with `collabws=<room>` against the local opaque relay —
 * one shared room, deterministic per-peer actors (`?actor=peer-N`),
 * and the websocket provider has no BroadcastChannel leg (D-24 G-e), so
 * nothing but the socket can carry updates.
 *
 * The oracle is a REFERENCE DOCUMENT, not peer-equality alone (equality
 * passes when every replica loses the same edit). After each local action
 * the runner captures the acting peer's authored update via a
 * state-vector diff and applies it to a Node-side `Y.Doc`. Because the
 * update is captured at the SOURCE — before delivery decisions take
 * effect — a universally dropped edit still reaches the reference doc,
 * and the heal barrier's exact compare surfaces the loss.
 *
 * Per-step assertions:
 * - acting peer — trusted-input proof, action effect, model/DOM/selection
 *   snapshot consistency, zero page/console errors;
 * - partitioned peers — their state vectors do not advance (a held or
 *   disconnected peer provably received nothing);
 * - connected peers — converge to the acting peer's canonical state;
 * - `healBarrier` — every connected peer's `facade.toJSON()` +
 *   attribution records + lineage rings are identical AND equal the
 *   reference document's projection.
 */

export type CollabPeerName = `peer-${string}`;

export type CollabLedgerEntry = {
	stepIndex: number;
	peer: number;
	action: CollabStep;
	/** base64 of the update diff captured post-action (authored edits). */
	updateB64: string | null;
	/** Connected peers at action time; relay hold state. */
	connected: number[];
	held: boolean;
	/** Free-form observation — e.g. `suppressed-by-remote:<code>:<n>`. */
	note?: string;
};

export type CollabRunFailure = {
	code: string;
	message: string;
	stepIndex: number;
	step: CollabStep | null;
	/**
	 * The peer a `DstHarnessFailure` was raised against (`error.engine` is
	 * the actor id in this lane — `assertBrowserSnapshot(actor.actorId, …)`).
	 * Kept separate from `step.peer` (the ACTING peer) so a failure on a
	 * passive replica fingerprints differently than the same code on the actor.
	 */
	peer?: string;
	ledger: CollabLedgerEntry[];
	details?: Record<string, unknown>;
	dumps?: Record<string, unknown>;
	referenceDump?: unknown;
	/**
	 * sha256 over `{version, code, action, selectionKind, peer, failingPeer,
	 * subtype}` — the collab counterpart to the solo lane's `failureFingerprint`.
	 * The minimizer requires candidates to reproduce THIS digest, not just the
	 * outer code, so a `delete-result-mismatch` cannot shrink into an
	 * `action-produced-no-effect` or a generic timeout.
	 */
	fingerprint: string;
};

export type CollabRunResult =
	| { ok: true; ledger: CollabLedgerEntry[] }
	| { ok: false; failure: CollabRunFailure };

type PeerRuntime = {
	index: number;
	actorId: string;
	context: BrowserContext;
	page: Page;
	pageErrors: string[];
	consoleErrors: string[];
	/** Provider-level connectivity — `disconnect`/`reconnect`/`reload`. */
	connected: boolean;
	/** State-vector baseline for the next update diff. */
	sv: Uint8Array;
	/**
	 * The peer's own-client clock at its last capture — advancing it is the
	 * proof that an action AUTHORED an update (a no-op action on a held
	 * window must not count toward the ≥2-writer guarantee).
	 */
	ownClock: number;
};

export type DocumentDump = {
	value: { children: JSONBlock[] };
	blocks: Record<string, unknown>;
	lineage: Record<string, unknown>;
	actor: string;
	/**
	 * The dumping peer's own model-side selection. Deliberately EXCLUDED
	 * from `dumpSignature` — caret positions are peer-local, so equal
	 * documents legitimately carry unequal selections. Barriers instead
	 * assert each peer's selection recovered onto live, in-bounds content.
	 */
	selection: {
		kind: 'text' | 'block';
		startBlockId: string | null;
		endBlockId: string | null;
		startTextId: string | null;
		endTextId: string | null;
		/**
		 * The endpoint's `TextAnchor` (`{b, a}`) — opaque to the runner,
		 * re-resolved on the same peer's post-step document to derive the
		 * exact contract landing spot. `*AnchorOk` certifies the captured
		 * anchor resolved back to the dumped endpoint on the pre-state —
		 * a stored anchor can lag the absolute selection, and only a
		 * self-consistent one is evidence of what recovery resolved.
		 */
		startAnchor: unknown;
		endAnchor: unknown;
		startAnchorOk: boolean;
		endAnchorOk: boolean;
		yStart: number;
		yEnd: number;
		startTextLen: number | null;
		endTextLen: number | null;
		isCollapsed: boolean;
		selectedBlockIds: string[];
	} | null;
	/**
	 * Per-block first/last EDITABLE text identity — the dump walks
	 * `firstEditableText`/`lastEditableText` (the same getters the
	 * dead-endpoint seam walk uses), so a container's phantom slot is
	 * never reported as a landing spot. `firstOwner`/`lastOwner` record
	 * the text's actual OWNING block — the editable text can belong to a
	 * descendant block, so a seam endpoint must compare against the
	 * descendant's block id, not the container's.
	 */
	blockTexts?: Record<
		string,
		{
			firstId: string | null;
			firstOwner: string | null;
			lastId: string | null;
			lastOwner: string | null;
			lastLen: number | null;
		}
	>;
	/**
	 * Every live text part's content keyed by text id — lets the
	 * passive-selection oracle distinguish an endpoint whose text was
	 * UNTOUCHED (absolute position legitimately preserved) from one
	 * whose text was edited (must match anchor resolution).
	 */
	textContents?: Record<string, string>;
	/**
	 * Live text part id → containing block id, derived from which
	 * block's `content` array the traversal found the part under — never
	 * the part's own `parent` pointer, which is exactly what a
	 * stale-parent corruption breaks. Membership doubles as the liveness
	 * gate (`content` only holds live wrappers).
	 */
	textOwners?: Record<string, string>;
	/**
	 * Live text part id → the part's CLAIMED `parent.id`. The sanity
	 * gate requires claim === containment for every enumerated part: a
	 * stale parent would otherwise let a corrupted selection and a
	 * corrupted inventory agree with each other.
	 */
	textClaims?: Record<string, string | null>;
	/**
	 * Live text part id → whether it held a DOM node at dump time. A
	 * container's phantom text never mounts; an editable text only lacks
	 * a node inside a settle window — `false` at a barrier means the
	 * endpoint sits on hidden text.
	 */
	textMounted?: Record<string, boolean>;
};

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const unb64 = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, 'base64'));

const collabRoute = (
	schedule: CollabSchedule,
	room: string,
	relayUrl: string,
	actorId: string
): string => {
	const query = new URLSearchParams({
		scenario: 'dst',
		dst: JSON.stringify(schedule.document),
		collabws: room,
		wsserver: relayUrl,
		actor: actorId,
		lineagedepth: String(schedule.lineageDepth),
		wsresync: '200',
		wsbackoff: '400',
		spellcheck: 'false',
		autocorrect: 'off',
		autocomplete: 'off',
		autocapitalize: 'none'
	});
	return `/test/dom?${query}`;
};

const openPeer = async (
	browser: Browser,
	baseURL: string,
	schedule: CollabSchedule,
	room: string,
	relayUrl: string,
	index: number
): Promise<PeerRuntime> => {
	const actorId = `peer-${index}`;
	const context = await browser.newContext({ baseURL });
	const page = await context.newPage();
	const pageErrors: string[] = [];
	const consoleErrors: string[] = [];
	page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
	page.on('console', (message) => {
		if (message.type() === 'error') consoleErrors.push(message.text());
	});
	await installEventRecorder(page);
	await page.goto(collabRoute(schedule, room, relayUrl, actorId), {
		waitUntil: 'domcontentloaded'
	});
	await waitForEditorReady(page, { requireRuntime: true });
	await settleEditor(page);
	return {
		index,
		actorId,
		context,
		page,
		pageErrors,
		consoleErrors,
		connected: true,
		sv: new Uint8Array(),
		ownClock: 0
	};
};

const dumpDocument = (page: Page): Promise<DocumentDump> =>
	page.evaluate(() => {
		const w = window as Window & {
			__EDYTOR__?: { document?: unknown };
			__EDYTOR_COLLABORATION_TEST__?: {
				dumpDocument?: (document: never) => unknown;
			};
		};
		const document = w.__EDYTOR__?.document;
		const dump = w.__EDYTOR_COLLABORATION_TEST__?.dumpDocument;
		if (!document || !dump) {
			throw new Error('Missing collaboration DST runtime (document/dumpDocument)');
		}
		return dump(document as never) as DocumentDump;
	});

const captureUpdate = async (
	peer: PeerRuntime
): Promise<{ updateB64: string; svB64: string; ownClock: number; providerUpdates: number }> => {
	const result = await peer.page.evaluate(
		(svB64) => {
			const w = window as Window & {
				__EDYTOR__?: { document?: { doc?: unknown } };
				__EDYTOR_COLLABORATION_TEST__?: {
					stateVector?: (doc: never) => Uint8Array;
					encodeDiff?: (doc: never, sv: Uint8Array) => Uint8Array;
				};
				__EDYTOR_UPDATE_LOG__?: { isProvider?: boolean }[];
			};
			const doc = w.__EDYTOR__?.document?.doc;
			const rt = w.__EDYTOR_COLLABORATION_TEST__;
			if (!doc || !rt?.stateVector || !rt.encodeDiff) {
				throw new Error('Missing collaboration DST runtime (stateVector/encodeDiff)');
			}
			const unb64 = (value: string) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
			const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
			// An EMPTY baseline means "full state" — `encodeStateAsUpdate`
			// decodes the target vector, so it needs `undefined`, not `[]`.
			const sv = svB64 === '' ? undefined : unb64(svB64);
			// The peer's own-client clock — advancing it proves this replica
			// AUTHORED items (vs merely receiving remote ones, which only
			// append to OTHER clients' lanes).
			const store = (doc as any).store;
			// Socket-applied update count — the route logs every doc update with
			// `isProvider: origin === provider`. A delete-only remote update
			// advances NO insertion clock, so the state vector alone cannot
			// prove isolation; this counter sees every provider apply. Read in
			// the same evaluate so the partition check stays one round-trip.
			const providerUpdates = (w.__EDYTOR_UPDATE_LOG__ ?? []).reduce(
				(count, entry) => count + (entry?.isProvider === true ? 1 : 0),
				0
			);
			return {
				updateB64: b64(rt.encodeDiff(doc as never, sv as never)),
				svB64: b64(rt.stateVector(doc as never)),
				ownClock: store?.getClock?.((doc as any).clientID) ?? 0,
				providerUpdates
			};
		},
		peer.sv.byteLength > 0 ? b64(peer.sv) : ''
	);
	return result;
};

/**
 * The `isProvider` slice of `__EDYTOR_UPDATE_LOG__` beyond a captured
 * baseline — the actual frames a partitioned peer applied (origin, bytes,
 * gate, timestamp). Only read AFTER a leak is detected; the per-step
 * compare uses the cheap count inside `captureUpdate`.
 */
const providerLogSince = (page: Page, baseline: number) =>
	page.evaluate((from) => {
		const log =
			(window as Window & { __EDYTOR_UPDATE_LOG__?: { isProvider?: boolean }[] })
				.__EDYTOR_UPDATE_LOG__ ?? [];
		return log.filter((entry) => entry?.isProvider === true).slice(from);
	}, baseline);

const providerState = (page: Page) =>
	page.evaluate(() => {
		const collab = (window as Window & { __EDYTOR_COLLAB__?: { provider?: any } })
			.__EDYTOR_COLLAB__;
		if (!collab?.provider) {
			throw new Error('Missing collaboration provider');
		}
		return {
			wsconnected: collab.provider.wsconnected,
			synced: collab.provider.synced
		};
	});

const setProviderConnected = (page: Page, connected: boolean) =>
	page.evaluate((next) => {
		const collab = (window as Window & { __EDYTOR_COLLAB__?: { provider?: any } })
			.__EDYTOR_COLLAB__;
		if (!collab?.provider) {
			throw new Error('Missing collaboration provider');
		}
		if (next) {
			collab.provider.connect();
		} else {
			collab.provider.disconnect();
		}
	}, connected);

/** Wrapper-mirror dump: the live keyed arrays Svelte's {#each} iterates.
 * A model dump can be clean while root.children / block.content / remote
 * rects still hold a duplicate wrapper — dump both layers on failure. */
const dumpWrappers = (page: Page) =>
	page.evaluate(() => {
		type AnyBlock = {
			id: string;
			children?: AnyBlock[];
			content?: { id?: string }[];
		};
		const edytor = (
			window as Window & {
				__EDYTOR__?: {
					root?: { children?: AnyBlock[] };
					idToBlock?: Map<string, unknown>;
				};
			}
		).__EDYTOR__;
		if (!edytor) {
			return null;
		}
		const walk = (block: AnyBlock): unknown => ({
			id: block.id,
			children: (block.children ?? []).map((child) => child.id),
			contentIds: (block.content ?? []).map((part) => part.id ?? null),
			nested: (block.children ?? []).map(walk)
		});
		return {
			rootChildren: (edytor.root?.children ?? []).map((child) => child.id),
			idToBlock: [...(edytor.idToBlock?.keys() ?? [])],
			tree: (edytor.root?.children ?? []).map(walk),
			remoteSelectionSpans: [...document.querySelectorAll('[data-edytor-remote-selection]')].map(
				(el) => ({
					clientId: (el as HTMLElement).dataset.clientId,
					style: (el as HTMLElement).getAttribute('style')
				})
			)
		};
	});

/**
 * WebSocket connect failures surface as console errors on every engine
 * ("WebSocket connection to 'ws://…' failed: …") — WebKit phrases the
 * abort differently but shares the prefix. The schedule DELIBERATELY kills
 * rooms, drops sockets, and reloads pages mid-connect, so a transport-level
 * connect failure is the injected fault working, not a product defect.
 * Convergence + reference barriers still gate the data; the errors stay
 * collected for diagnostics either way.
 */
const isWsConnectNoise = (text: string) => text.startsWith('WebSocket connection to ');

const assertPeerClean = async (peer: PeerRuntime) => {
	const realConsoleErrors = peer.consoleErrors.filter((text) => !isWsConnectNoise(text));
	if (peer.pageErrors.length > 0 || realConsoleErrors.length > 0) {
		let dump: DocumentDump | string = 'unavailable';
		let wrappers: unknown = 'unavailable';
		try {
			dump = await dumpDocument(peer.page);
			wrappers = await dumpWrappers(peer.page);
		} catch {
			// The page error may have poisoned evaluation — keep the errors.
		}
		throw new CollabRunError('browser-error', `peer ${peer.actorId} emitted an uncaught error`, {
			dumps: {
				pageErrors: peer.pageErrors,
				consoleErrors: peer.consoleErrors,
				document: dump,
				wrappers
			}
		});
	}
};

/**
 * Canonical stringify: object keys sorted recursively, array order
 * preserved (array order is semantic — children/entry order matters).
 * `blocks`/`lineage` enumeration order follows registry iteration, which is
 * replication-order-dependent across peers; a naive stringify signature
 * never converges on identical data emitted in a different key order.
 */
const stableStringify = (v: unknown): string => {
	if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
	if (v !== null && typeof v === 'object')
		return `{${Object.keys(v as Record<string, unknown>)
			.sort()
			.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
			.join(',')}}`;
	return JSON.stringify(v);
};

const dumpSignature = (dump: DocumentDump): string =>
	stableStringify({ value: dump.value, blocks: dump.blocks, lineage: dump.lineage });

/**
 * Remote-application probe: `doc.on('update')` origins equal to the
 * provider instance are updates applied FROM the socket (room.ts passes
 * `provider` as the transaction origin). A remote update landing inside
 * the action window can legitimately suppress the strict effect oracle —
 * selection recovery may clear the caret the trusted keypress needed, or
 * an undo of an already-overwritten op lands semantically empty. The
 * counter makes that coincidence observable instead of guessing.
 */
const resetRemoteApplyCount = (page: Page) =>
	page.evaluate(() => {
		const w = window as Window & {
			__EDYTOR__?: { document?: { doc?: { on?: (n: string, f: unknown) => void } } };
			__EDYTOR_COLLAB__?: { provider?: unknown };
			__COLLAB_REMOTE_COUNT__?: number;
			__COLLAB_REMOTE_LISTENER__?: (update: unknown, origin: unknown) => void;
		};
		const doc = w.__EDYTOR__?.document?.doc;
		const provider = w.__EDYTOR_COLLAB__?.provider;
		if (!doc?.on || !provider) {
			throw new Error('Missing collaboration runtime (doc/provider)');
		}
		if (!w.__COLLAB_REMOTE_LISTENER__) {
			w.__COLLAB_REMOTE_LISTENER__ = (_update: unknown, origin: unknown) => {
				if (origin === provider) {
					w.__COLLAB_REMOTE_COUNT__ = (w.__COLLAB_REMOTE_COUNT__ ?? 0) + 1;
				}
			};
			doc.on('update', w.__COLLAB_REMOTE_LISTENER__);
		}
		w.__COLLAB_REMOTE_COUNT__ = 0;
	});

const remoteApplyCount = (page: Page) =>
	page.evaluate(
		() => (window as Window & { __COLLAB_REMOTE_COUNT__?: number }).__COLLAB_REMOTE_COUNT__ ?? 0
	);

/**
 * The post-composition phantom guard swallows the first structural key
 * within 500ms of compositionend (IME commit-key echo protection — see
 * the composition tail in `session/composition`). A fast generated sequence that types
 * composition characters (`·`, `é`, …) then presses Enter inside the
 * window is a DESIGNED no-op — the counter diff proves it instead of
 * weakening the oracle by timing.
 */
const guardSwallowCount = (page: Page) =>
	page.evaluate(
		() =>
			(window as Window & { __EDYTOR__?: { postCompositionGuardSwallows?: number } }).__EDYTOR__
				?.postCompositionGuardSwallows ?? 0
	);

/**
 * Effect-oracle codes a coinciding remote apply can legitimately suppress.
 * The exact-result delete codes are included because a remote edit landing
 * inside the action window changes `after.value` beyond the local action's
 * control — no oracle can isolate the local effect there; the end-of-run
 * reference barrier still holds the shared truth.
 */
const REMOTE_SUPPRESSIBLE = new Set([
	'action-produced-no-effect',
	'delete-result-mismatch',
	'delete-noop-mutated-document',
	'delete-selection-mismatch',
	// A remote apply mid-action can legitimately move the acting peer's
	// caret before its typed text lands — same class as the other
	// remote-influenced mismatches.
	'type-landing-mismatch'
]);

/** Actions the post-composition guard can legitimately swallow. */
const GUARD_SWALLOWABLE = new Set(['enter', 'softBreak']);

/**
 * Resolve `peerCaretBlock` on the acting peer's snapshot: read the TARGET
 * peer's live caret block id, then select that block in the actor's own
 * document (converged peers share block ids). If the target peer has no
 * text/block caret — or the id isn't live in the actor's view yet (still
 * catching up, or the schedule was sliced) — fall back to a deterministic
 * block index so a minimized schedule stays runnable.
 */
const resolvePeerCaretBlock = async (
	selector: { kind: 'peerCaretBlock'; peer: number },
	actor: PeerRuntime,
	peers: PeerRuntime[],
	snapshot: DstBrowserSnapshot
): Promise<ResolvedSelection> => {
	const blocks = snapshot.model.blocks;
	if (blocks.length === 0) {
		throw new DstHarnessFailure('no-live-block', actor.actorId, 'document has no selectable block');
	}
	const target = peers[selector.peer];
	let index = -1;
	if (target) {
		const caretBlockId = await target.page
			.evaluate(() => {
				const w = window as Window & {
					__EDYTOR__?: {
						selection?: {
							state?: {
								startBlock?: { id?: string } | null;
								startText?: { parent?: { id?: string } | null } | null;
							};
						};
					};
				};
				const state = w.__EDYTOR__?.selection?.state;
				return state?.startText?.parent?.id ?? state?.startBlock?.id ?? null;
			})
			.catch(() => null);
		if (caretBlockId !== null) {
			index = blocks.findIndex((block) => block.id === caretBlockId);
		}
	}
	return {
		kind: 'block',
		index: index < 0 ? selector.peer % blocks.length : index,
		reversed: false
	};
};

export class CollabRunError extends Error {
	readonly code: string;
	readonly dumps?: Record<string, unknown>;
	readonly referenceDump?: unknown;
	constructor(
		code: string,
		message: string,
		extras?: { dumps?: Record<string, unknown>; referenceDump?: unknown }
	) {
		super(message);
		this.code = code;
		this.dumps = extras?.dumps;
		this.referenceDump = extras?.referenceDump;
	}
}

/**
 * Poll every connected peer's canonical dump until all are identical —
 * the connected-subset convergence check. Disconnected peers and a held
 * relay legitimately lag; callers exclude them from `targets`.
 */
const expectConverged = async (
	peers: PeerRuntime[],
	targets: PeerRuntime[],
	timeout = 20_000
): Promise<Record<string, DocumentDump>> => {
	let dumps: Record<string, DocumentDump> = {};
	try {
		await expect
			.poll(
				async () => {
					const entries = await Promise.all(
						targets.map(async (peer) => [peer.actorId, await dumpDocument(peer.page)] as const)
					);
					dumps = Object.fromEntries(entries);
					const signatures = entries.map(([, dump]) => dumpSignature(dump));
					return signatures.every((sig) => sig === signatures[0]);
				},
				{ timeout, message: 'connected peers did not converge' }
			)
			.toBe(true);
	} catch (error) {
		// Attach the LAST polled dumps plus each peer's state vector — a
		// convergence stall needs to know WHICH field differs AND which
		// replica's store is physically missing the update.
		for (const peer of targets) {
			const { svB64 } = await captureUpdate(peer).catch(() => ({ svB64: null }));
			const dump = dumps[peer.actorId];
			if (dump && svB64 !== null) {
				(dump as Record<string, unknown>).__sv = svB64;
				(dump as Record<string, unknown>).__raw = await peer.page
					.evaluate(() => {
						const w = window as Window & {
							__EDYTOR__?: { document?: { doc?: any } };
							__EDYTOR_COLLABORATION_TEST__?: { probeSliceRanges?: (d: any) => unknown };
						};
						const doc = w.__EDYTOR__?.document?.doc;
						const document = w.__EDYTOR__?.document;
						const probe = w.__EDYTOR_COLLABORATION_TEST__?.probeSliceRanges;
						if (!doc) return null;
						// Raw store view: which items back each block's content node and
						// whether they are integrated-but-deleted vs never-integrated.
						// `pendingStructs`/`pendingDs` prove starvation; `deleted` flags
						// prove a divergent delete set — identical state vectors can't.
						const registry = doc.get('blocks');
						const out: Record<string, unknown> = {
							pendingStructs: doc.store.pendingStructs
								? [...doc.store.pendingStructs.missing.entries()]
								: null,
							pendingDs: !!doc.store.pendingDs
						};
						for (const key of registry.attrKeys()) {
							const node = registry.getAttr(key);
							const rec: Record<string, unknown> = {};
							for (const attr of ['content', 'slices'] as const) {
								const list = node?.getAttr?.(attr);
								if (!list) continue;
								const items: unknown[] = [];
								for (let it = list._start; it !== null; it = it.right) {
									items.push({
										id: `${it.id.client}:${it.id.clock}`,
										len: it.length,
										del: !!it.deleted,
										sub: it.parentSub ?? null,
										payload: it.content?.getContent?.() ?? null
									});
								}
								rec[attr] = items;
								// Local-only render cache — divergent marker.index values make
								// anchor resolution replica-dependent. Dumped so a stall can be
								// attributed to stale markers vs claim-order bugs offline.
								rec[`${attr}Markers`] = (list._searchMarker ?? []).map((m: any) => ({
									p: m.p ? `${m.p.id.client}:${m.p.id.clock}` : null,
									index: m.index
								}));
							}
							rec._nodeDeleted = !!node?._item?.deleted;
							out[key] = rec;
						}
						// Resolved claim ranges via the engine's own anchor machinery —
						// identical slices + identical resolution proves the divergence
						// lives above the store (maintained caches), not in it.
						out.__resolved = probe ? (probe(document) as Record<string, unknown>) : null;
						return out;
					})
					.catch(() => null);
			}
		}
		throw new CollabRunError(
			'peers-diverged',
			`connected peers did not converge (${error instanceof Error ? error.message : String(error)})`,
			{ dumps }
		);
	}
	for (const peer of peers) {
		await assertPeerClean(peer);
	}
	// Selection sanity rides the same barrier: convergence is proven, so a
	// peer whose caret still anchors a remotely-deleted block (or whose
	// offset overran the recovered text) is a real recovery bug, not lag.
	for (const peer of targets) {
		const dump = dumps[peer.actorId];
		if (dump) assertDumpSelectionSane(peer.actorId, dump);
	}
	return dumps;
};

/**
 * Remote-overlay staleness probe: for every REMOTE client a peer still
 * renders an overlay for (`[data-edytor-remote-selection]`/`-cursor`
 * spans, keyed by `data-client-id`), re-resolve that client's freshest
 * published awareness selection and report endpoints that land on dead
 * content — or that no longer resolve at all while the span remains.
 *
 * The render path (`getRenderedRemoteSelections`) skips unresolvable
 * candidates, but `resolveTextAnchor`'s fallback walk can return a text
 * inside a DELETED block (its `block.content` scan doesn't check liveness),
 * so a span that resolved at render time can stay parked on a dead
 * wrapper. Re-resolving and checking `text.isInDocument` is the honest "points
 * at a live block" test; an absent span is always acceptable (the
 * renderer correctly declined or the presence expired).
 */
const remoteOverlayStaleness = (page: Page) =>
	page.evaluate(() => {
		type StaleOverlay = {
			clientId: string;
			end?: 'start' | 'end';
			reason: 'overlay-without-selection' | 'unresolvable' | 'dead-block';
			blockId?: string | null;
		};
		const w = window as Window & {
			__EDYTOR__?: {
				awareness?: { getStates?: () => Map<number, Record<string, unknown>> };
				idToText?: { get: (id: string) => { isInDocument?: boolean } | undefined };
				selection?: {
					resolveTextAnchor?: (anchor: unknown) => {
						text: { isInDocument?: boolean; parent?: { id?: string } | null };
						offset: number;
					} | null;
				};
			};
		};
		const edytor = w.__EDYTOR__;
		if (!edytor?.awareness?.getStates || !edytor.selection?.resolveTextAnchor) {
			return [];
		}
		const renderedClientIds = new Set(
			[
				...document.querySelectorAll<HTMLElement>(
					'[data-edytor-remote-selection],[data-edytor-remote-cursor]'
				)
			]
				.map((el) => el.dataset.clientId ?? '')
				.filter((id) => id !== '')
		);
		// Mirror of `remoteSelection.ts`'s `getSelection`: the freshest VALID
		// `selections` entry by publish sequence `t`, else the legacy
		// `selection` mirror — replicated here because the production helper
		// isn't reachable from the test route's debug surface.
		const normalize = (value: unknown) =>
			value !== null &&
			typeof value === 'object' &&
			(value as Record<string, unknown>).start !== undefined &&
			(value as Record<string, unknown>).end !== undefined
				? (value as Record<string, unknown>)
				: null;
		const freshest = (state: Record<string, unknown>) => {
			const selections = state.selections;
			if (selections !== null && typeof selections === 'object') {
				let best: Record<string, unknown> | null = null;
				let bestT = Number.NEGATIVE_INFINITY;
				for (const entry of Object.values(selections)) {
					const normalized = normalize(entry);
					if (!normalized) continue;
					const t =
						typeof (entry as Record<string, unknown>).t === 'number'
							? ((entry as Record<string, unknown>).t as number)
							: 0;
					if (t > bestT) {
						best = normalized;
						bestT = t;
					}
				}
				if (best) return best;
			}
			return normalize(state.selection);
		};
		const resolveLiveText = (
			anchor: unknown,
			textId: unknown
		): { live: boolean; blockId: string | null } | null => {
			let text: { isInDocument?: boolean; parent?: { id?: string } | null } | null | undefined;
			try {
				// `resolveTextAnchor` is the anchor-first path the renderer
				// uses; malformed wire anchors throw, hence the guard.
				text = anchor ? edytor.selection!.resolveTextAnchor!(anchor)?.text : null;
			} catch {
				text = null;
			}
			if (!text && typeof textId === 'string') {
				try {
					text = edytor.idToText?.get(textId);
				} catch {
					text = null;
				}
			}
			if (!text) return null;
			return { live: text.isInDocument !== false, blockId: text.parent?.id ?? null };
		};
		const stale: StaleOverlay[] = [];
		for (const clientId of renderedClientIds) {
			const state = edytor.awareness.getStates().get(Number(clientId));
			const selection = state ? freshest(state) : null;
			if (!selection) {
				// A rendered span with no selection payload behind it can only
				// be residue — the awareness entry expired or never carried a
				// valid selection, yet the overlay stayed mounted.
				stale.push({ clientId, reason: 'overlay-without-selection' });
				continue;
			}
			for (const end of ['start', 'end'] as const) {
				const resolved = resolveLiveText(selection[end], selection[`${end}TextId`]);
				if (!resolved) {
					stale.push({ clientId, end, reason: 'unresolvable' });
					continue;
				}
				if (!resolved.live) {
					stale.push({ clientId, end, reason: 'dead-block', blockId: resolved.blockId });
				}
			}
		}
		return stale;
	});

/**
 * Heal-barrier remote-overlay gate: awareness rides an ephemeral stream
 * that trails doc updates, so a still-rendered overlay is allowed a short
 * window to re-resolve or withdraw; an overlay that persists pointing at
 * deleted/unresolvable content is a `stale-remote-overlay` failure.
 */
const assertRemoteOverlaysLive = async (targets: PeerRuntime[]) => {
	for (const peer of targets) {
		let stale: unknown[] = [];
		try {
			await expect
				.poll(async () => (stale = await remoteOverlayStaleness(peer.page).catch(() => [])), {
					timeout: 5_000,
					message: 'remote selection overlay stayed stale'
				})
				.toEqual([]);
		} catch {
			const dump = await dumpDocument(peer.page).catch(() => 'unavailable');
			throw new CollabRunError(
				'stale-remote-overlay',
				`peer ${peer.actorId} renders remote selection overlay(s) on dead or ` +
					`unresolvable anchors: ${JSON.stringify(stale)}`,
				{ dumps: { [peer.actorId]: dump, staleOverlays: stale } }
			);
		}
	}
};

/**
 * Full-convergence barrier: every connected peer's canonical dump must be
 * identical, AND equal the reference document's projection — the
 * intent-ledger check. An update every replica lost still lives in the
 * reference doc, so this is the "equality can't hide a lost edit" gate.
 */
const healBarrier = async (
	peers: PeerRuntime[],
	reference: EdytorDocument,
	lineageDepth: number
) => {
	const targets = peers.filter((peer) => peer.connected);
	const dumps = await expectConverged(peers, targets, 25_000);
	const referenceDump = dumpReference(reference);
	for (const peer of targets) {
		const dump = dumps[peer.actorId];
		if (dumpSignature(dump) !== dumpSignature(referenceDump as DocumentDump)) {
			const updateLogs: Record<string, unknown> = {};
			for (const target of targets) {
				updateLogs[target.actorId] = await target.page
					.evaluate(
						() =>
							(window as Window & { __EDYTOR_UPDATE_LOG__?: unknown[] }).__EDYTOR_UPDATE_LOG__ ??
							null
					)
					.catch(() => 'unavailable');
			}
			throw new CollabRunError(
				'reference-mismatch',
				`peer ${peer.actorId} converged away from the captured-update reference ` +
					`(depth=${lineageDepth}) — a delivered-everywhere edit is missing or an ` +
					`undelivered one leaked`,
				// `updateLogs` must live INSIDE `dumps` — `CollabRunError` only
				// forwards the dumps/referenceDump fields; a sibling key would
				// be dropped before it reached the artifact.
				{ dumps: { ...dumps, updateLogs }, referenceDump }
			);
		}
	}
	// Doc state is proven — now the presence layer: every remote overlay
	// still rendered must resolve onto live content (or be absent). A
	// caret span parked on a block a remote delete removed is a stale
	// awareness failure, not a convergence one.
	await assertRemoteOverlaysLive(targets);
};

/** Node-side dump identical in shape to the page's `dumpDocument`. */
const dumpReference = (document: EdytorDocument): DocumentDump => {
	const value = document.facade.toJSON();
	const blocks: Record<string, unknown> = {};
	const lineage: Record<string, unknown> = {};
	const live = new Set<string>();
	const walk = (children: JSONBlock[]) => {
		for (const child of children) {
			if (child.id !== undefined) {
				live.add(child.id);
				const attribution = document.attribution.block(child.id);
				blocks[child.id] = attribution
					? {
							createdBy: attribution.createdBy,
							contributors: [...attribution.contributors].sort(),
							lastChangedBy: attribution.lastChangedBy
						}
					: null;
				lineage[child.id] = document.attribution.history(child.id) ?? null;
			}
			if (child.children) walk(child.children);
		}
	};
	walk(value.children);
	// Mirror of the page dump: deleted blocks' records are readable by
	// design — enumerate them so a lost recovery snapshot or diverging
	// stamp on a tombstoned block fails the barrier.
	for (const rec of blockRecordsOf(
		document.doc as unknown as Parameters<typeof blockRecordsOf>[0]
	)) {
		const deleted = !live.has(rec.id);
		const attribution = rec.attribution;
		blocks[rec.id] = {
			deleted,
			incarnation: rec.incarnation,
			createdBy: attribution?.createdBy,
			contributors: attribution ? [...attribution.contributors].sort() : [],
			lastChangedBy: attribution?.lastChangedBy
		};
		lineage[rec.id] = rec.lineage ?? null;
	}
	return { value, blocks, lineage, blockTexts: {}, actor: document.actor.id, selection: null };
};

/**
 * Post-convergence selection sanity: the dump's `selection` is peer-local
 * so it never enters the signature, but a remote edit must not strand it —
 * every endpoint must anchor on a LIVE block id with an in-bounds offset.
 * This is the assertion that catches a caret left dangling on a deleted
 * block after another peer's structural edit.
 */
export const assertDumpSelectionSane = (actorId: string, dump: DocumentDump) => {
	const sel = dump.selection;
	if (!sel) return;
	const live = new Set<string>();
	const walk = (children: JSONBlock[]) => {
		for (const child of children) {
			if (child.id !== undefined) live.add(child.id);
			if (child.children) walk(child.children);
		}
	};
	walk(dump.value.children);
	// The root container is never part of `value.children` but is a valid
	// permanent anchor — an empty document's caret sits at root level, and
	// the root can never be deleted by a remote edit.
	live.add('root');
	// Claim-vs-containment on EVERY live text part — a stale `parent`
	// pointer must disagree with the traversal-derived owner even when
	// the corrupted text sits nowhere near the selection.
	if (dump.textOwners) {
		for (const [textId, claimedParent] of Object.entries(dump.textClaims ?? {})) {
			const owner = dump.textOwners[textId];
			if (owner !== undefined && claimedParent !== owner) {
				throw new CollabRunError(
					'dump-inventory-mismatch',
					`peer ${actorId} text ${textId} claims parent ${claimedParent} ` +
						`but is contained in block ${owner}`,
					{ dumps: { [actorId]: dump } }
				);
			}
		}
	}
	if (sel.kind === 'block') {
		const dead = sel.selectedBlockIds.filter((id) => !live.has(id));
		if (dead.length > 0) {
			throw new CollabRunError(
				'remote-selection-dead-block',
				`peer ${actorId} block-selection still anchors deleted block(s) ${dead.join(', ')}`,
				{ dumps: { [actorId]: dump } }
			);
		}
		return;
	}
	if (sel.isCollapsed) {
		const mismatch =
			sel.startBlockId !== sel.endBlockId ||
			sel.startTextId !== sel.endTextId ||
			sel.yStart !== sel.yEnd;
		if (mismatch) {
			throw new CollabRunError(
				'remote-selection-out-of-bounds',
				`peer ${actorId} reports isCollapsed but endpoints differ ` +
					`(start ${sel.startBlockId}#${sel.startTextId}@${sel.yStart}, ` +
					`end ${sel.endBlockId}#${sel.endTextId}@${sel.yEnd})`,
				{ dumps: { [actorId]: dump } }
			);
		}
	}
	const ends = [
		['start', sel.startBlockId, sel.startTextId, sel.yStart, sel.startTextLen],
		['end', sel.endBlockId, sel.endTextId, sel.yEnd, sel.endTextLen]
	] as const;
	for (const [label, blockId, textId, offset, len] of ends) {
		if (blockId === null) continue;
		if (!live.has(blockId)) {
			throw new CollabRunError(
				'remote-selection-dead-block',
				`peer ${actorId} ${label} caret anchors deleted block ${blockId}`,
				{ dumps: { [actorId]: dump } }
			);
		}
		// Bounds are checked against the ENUMERATED live content, not the
		// wrapper's reported `length` — a stale wrapper reporting length 6
		// over live text "ab" would otherwise let an offset of 5 pass.
		// The reported length is kept as a second channel: disagreeing
		// with the inventory is itself the corruption signal.
		const liveLen = textId !== null ? dump.textContents?.[textId]?.length : undefined;
		if (textId !== null && dump.textContents && liveLen === undefined) {
			throw new CollabRunError(
				'remote-selection-dead-block',
				`peer ${actorId} ${label} caret anchors text ${textId} ` +
					`absent from the live content inventory`,
				{ dumps: { [actorId]: dump } }
			);
		}
		if (len !== null && liveLen !== undefined && len !== liveLen) {
			throw new CollabRunError(
				'dump-inventory-mismatch',
				`peer ${actorId} ${label} endpoint reports text length ${len} ` +
					`but live content of ${textId} is ${liveLen} chars`,
				{ dumps: { [actorId]: dump } }
			);
		}
		const bound = liveLen ?? len;
		if (bound !== null && bound !== undefined && (offset < 0 || offset > bound)) {
			throw new CollabRunError(
				'remote-selection-out-of-bounds',
				`peer ${actorId} ${label} caret offset ${offset} outside [0, ${bound}] on block ${blockId}`,
				{ dumps: { [actorId]: dump } }
			);
		}
		// The textId must be a LIVE part (`content` arrays drop killed
		// wrappers) owned by the very block the endpoint claims — a dead
		// wrapper id under a live block is the signature of repair that
		// moved the block but not the text.
		if (textId !== null && dump.textOwners) {
			const owner = dump.textOwners[textId];
			if (owner === undefined) {
				throw new CollabRunError(
					'remote-selection-dead-block',
					`peer ${actorId} ${label} caret anchors dead text ${textId} ` + `(no live block owns it)`,
					{ dumps: { [actorId]: dump } }
				);
			}
			if (owner !== blockId) {
				throw new CollabRunError(
					'remote-selection-dead-block',
					`peer ${actorId} ${label} caret claims block ${blockId} but ` +
						`text ${textId} is owned by ${owner}`,
					{ dumps: { [actorId]: dump } }
				);
			}
		}
		// A live part with no DOM node at a settled barrier is hidden —
		// the container's phantom slot. Recovery must land on EDITABLE
		// text, so an endpoint parked here is the hidden-target defect,
		// not a valid landing.
		if (textId !== null && dump.textMounted?.[textId] === false) {
			throw new CollabRunError(
				'remote-selection-uneditable',
				`peer ${actorId} ${label} caret anchors text ${textId} ` +
					`which held no DOM node at dump time (hidden/phantom target)`,
				{ dumps: { [actorId]: dump } }
			);
		}
	}
};

// ── Passive-peer selection exactness ──────────────────────────────────
// The liveness gate above proves a recovered caret lands SOMEWHERE live
// and in-bounds; it cannot prove it landed at the contract position.
// `assertPassiveSelectionExact` replays the endpoint's own `TextAnchor`
// through `resolveTextAnchor` on the passive peer's post-step document —
// the same anchor resolution production recovery uses. A resolvable
// anchor defines the exact expected spot (block + text + UTF-16 offset);
// only when the anchor is unresolvable (its atoms died wholesale) does
// the dead-endpoint seam rule apply — the topmost dead child's vacated
// slot under the nearest live ancestor, resolved to the surviving
// sibling's start (one slid into the slot) or the previous sibling's
// end (the dead child was last), and ultimately the first child's first
// text. Anything else is `remote-selection-misplaced`, even when the
// caret sits live and in-bounds somewhere else.
//
// Scope bound: when neither resolution nor a computable seam exists the
// check degrades to the liveness+bounds gate rather than guessing.

type SeamSpot = EndpointSpot;

const liveBlockIdsOf = (dump: DocumentDump): Set<string> => {
	const live = new Set<string>();
	const walk = (children: JSONBlock[]) => {
		for (const child of children) {
			if (child.id !== undefined) live.add(child.id);
			if (child.children) walk(child.children);
		}
	};
	walk(dump.value.children);
	return live;
};

/** Path from the root children down to `blockId`, each entry `{id, children}`. */
const findBlockChain = (
	children: JSONBlock[],
	blockId: string,
	trail: { id: string; children: JSONBlock[] }[] = []
): { id: string; children: JSONBlock[] }[] | null => {
	for (const child of children) {
		if (child.id === blockId) return [...trail, { id: child.id, children: child.children ?? [] }];
		const found = findBlockChain(child.children ?? [], blockId, [
			...trail,
			{ id: child.id, children: child.children ?? [] }
		]);
		if (found) return found;
	}
	return null;
};

/**
 * The contract landing spot for an endpoint whose block `deadBlockId`
 * died between `pre` and `post`. Mirrors `selection.svelte.ts`'s repair:
 * climb to the topmost dead child under the nearest live ancestor, take
 * the first live sibling at/after its slot (land at its first text) else
 * the last live sibling before it (land at its last text's end), else
 * the root's first child's first text.
 */
const seamExpectation = (
	pre: DocumentDump,
	post: DocumentDump,
	deadBlockId: string
): SeamSpot | null => {
	const postLive = liveBlockIdsOf(post);
	const chain = findBlockChain(pre.value.children, deadBlockId);
	if (!chain || chain.length === 0) return null;
	// Nearest ancestor that survived in post — chain is root→dead, so scan
	// back from the dead end; everything past it is the dead subtree.
	let liveAncestorIdx = -1;
	for (let i = chain.length - 1; i >= 0; i--) {
		if (postLive.has(chain[i].id)) {
			liveAncestorIdx = i;
			break;
		}
	}
	const liveAncestor = liveAncestorIdx >= 0 ? chain[liveAncestorIdx] : null;
	// The vacating child sits one level below the live ancestor — the dead
	// block itself when its own parent survived.
	const topDead = chain[liveAncestorIdx + 1];
	if (!topDead) return null;
	const siblings = liveAncestor ? liveAncestor.children : (pre.value.children ?? []);
	const slot = siblings.findIndex((block) => block.id === topDead.id);
	if (slot < 0) return null;
	// Mirror production's directional scan: from the dead slot, walk the
	// PREVIOUS sibling ordering forward (then backward) and take the
	// first live sibling WITH an editable text — a live-but-textless
	// sibling (void divider, empty container) is skipped, not a landing.
	// The dump's blockTexts entries are editable-text ids + owning block.
	for (let i = slot; i < siblings.length; i++) {
		const candidate = siblings[i];
		if (!postLive.has(candidate?.id ?? '')) continue;
		const texts = candidate?.id ? post.blockTexts?.[candidate.id] : undefined;
		if (texts?.firstId && texts.firstOwner) {
			return { blockId: texts.firstOwner, textId: texts.firstId, offset: 0 };
		}
	}
	for (let i = slot - 1; i >= 0; i--) {
		const candidate = siblings[i];
		if (!postLive.has(candidate?.id ?? '')) continue;
		const texts = candidate?.id ? post.blockTexts?.[candidate.id] : undefined;
		if (texts?.lastId && texts.lastOwner) {
			return { blockId: texts.lastOwner, textId: texts.lastId, offset: texts.lastLen ?? 0 };
		}
	}
	// No live sibling under the ancestor — production lands on the root's
	// first editable text.
	return rootFallbackSpot(post);
};

/** The root's first editable text spot — production's last-resort
 * landing for dead-endpoint repair (`firstText` descends into a
 * container's first child, so the recorded `firstOwner` may be a
 * descendant's block id). */
const rootFallbackSpot = (post: DocumentDump): SeamSpot | null => {
	for (const child of post.value.children ?? []) {
		const entry = child?.id ? post.blockTexts?.[child.id] : undefined;
		if (entry?.firstId && entry.firstOwner) {
			return { blockId: entry.firstOwner, textId: entry.firstId, offset: 0 };
		}
	}
	return null;
};

/**
 * Resolve a captured `TextAnchor` on a peer's CURRENT document — the same
 * `resolveTextAnchor` production recovery calls. Returns the exact landing
 * spot when the anchor resolves onto a live text in a live block, `null`
 * when unresolvable (dead target, dead resolved text, or a missing
 * runtime — all mean the dead-endpoint repair contract applies instead).
 */
const resolvePeerAnchor = async (page: Page, anchor: unknown): Promise<SeamSpot | null> =>
	page
		.evaluate((a) => {
			const w = window as Window & {
				__EDYTOR__?: {
					selection?: {
						resolveTextAnchor?: (anchor: unknown) => {
							text: {
								id: string;
								isInDocument: boolean;
								parent?: { id: string; isInTree?: boolean };
							};
							offset: number;
						} | null;
					};
				};
			};
			const resolved = w.__EDYTOR__?.selection?.resolveTextAnchor?.(a);
			if (
				!resolved ||
				resolved.text.isInDocument !== true ||
				resolved.text.parent?.isInTree === false
			) {
				return null;
			}
			return {
				blockId: resolved.text.parent?.id ?? null,
				textId: resolved.text.id,
				offset: resolved.offset
			};
		}, anchor)
		.then((spot) => (spot?.blockId && spot.textId ? (spot as SeamSpot) : null));
// Deliberately no .catch: a page-side throw is a defect in the anchor
// machinery, not an unresolvable anchor — let it fail the step.

/**
 * Exact recovered-position gate for a PASSIVE peer. The JOINT
 * expectation lives in `selectionOracle.ts` (`acceptableSelectionShapes`)
 * — a range's endpoints do not recover independently, so the oracle
 * enumerates whole-selection shapes: the resolved range when both
 * anchors resolve, a collapse to the survivor when one does, the
 * start-block seam or root fallback when neither does and an endpoint
 * died, and the untouched pre shape when nothing died. Each endpoint's
 * own `TextAnchor` is re-resolved through the live editor — production's
 * recovery path verbatim — giving atom-identity evidence: a rewritten
 * text keeps an identical string but resolves the anchor elsewhere.
 *
 * Structural invariants hold on EVERY step (all frame counts): a text
 * selection must not vanish and a collapsed caret stays collapsed —
 * remote edits repair, they never clear or expand a passive selection.
 * Endpoint exactness runs only on single-remote-frame steps — chained
 * multi-apply recovery isn't replayable from outside. Zero frames
 * asserts "no delivery ⇒ no movement". Everything outside the set is
 * `remote-selection-misplaced` — including a caret in the wrong live
 * block, the defect class this gate exists to catch.
 */
export const assertPassiveSelectionExact = async (
	actorId: string,
	peer: PeerRuntime,
	pre: DocumentDump | undefined,
	preProviderUpdates: number,
	post: DocumentDump | undefined
): Promise<void> => {
	if (!pre?.selection || pre.selection.kind !== 'text') return;
	const invariantViolation = passiveSelectionInvariantViolation({
		pre: pre.selection,
		post: post?.selection
	});
	if (invariantViolation) {
		throw new CollabRunError(
			'remote-selection-lost',
			`peer ${actorId}: ${invariantViolation} ` +
				`(pre ${pre.selection.kind}@${pre.selection.yStart} → ` +
				`post ${post?.selection?.kind ?? 'none'}@${post?.selection?.yStart ?? '-'})`,
			{ dumps: { [actorId]: post ?? pre } }
		);
	}
	// Unreachable when `pre` is a text selection — the invariant above
	// already threw — but it narrows `post` for the checks below.
	if (!post?.selection || post.selection.kind !== 'text') return;
	const frames = (await captureUpdate(peer)).providerUpdates - preProviderUpdates;
	if (frames === 0) {
		// Nothing remote reached this peer — the caret cannot have moved.
		if (selectionMoved(pre.selection, post.selection)) {
			throw new CollabRunError(
				'remote-selection-misplaced',
				`peer ${actorId} selection moved without a remote delivery ` +
					`(pre ${pre.selection.startBlockId}@${pre.selection.yStart} → ` +
					`post ${post.selection.startBlockId}@${post.selection.yStart})`,
				{ dumps: { [actorId]: post } }
			);
		}
		return;
	}
	if (frames > 1) return;
	const postLive = liveBlockIdsOf(post);
	// Wrapper liveness: `content` arrays only hold live parts, so a textId
	// missing from `textContents` means the endpoint's wrapper died even
	// under a surviving block. A null pre textId mirrors production's
	// null-text early return — nothing repairs, the position stands.
	const startDead =
		pre.selection.startTextId !== null &&
		post.textContents?.[pre.selection.startTextId] === undefined;
	const endDead =
		!pre.selection.isCollapsed &&
		pre.selection.endTextId !== null &&
		post.textContents?.[pre.selection.endTextId] === undefined;
	const startBlockDied = !postLive.has(pre.selection.startBlockId ?? '');
	// Atom-identity evidence, not string equality: each endpoint's own
	// anchor — the SAME object production resolves — is re-resolved on the
	// converged document. A text whose items were rewritten keeps an
	// identical string but resolves the anchor elsewhere (`aa|aa` →
	// delete first 'a' + append 'a' → anchor moves to 1).
	const resolvedStart =
		pre.selection.startAnchor != null
			? await resolvePeerAnchor(peer.page, pre.selection.startAnchor)
			: null;
	const resolvedEnd =
		!pre.selection.isCollapsed && pre.selection.endAnchor != null
			? await resolvePeerAnchor(peer.page, pre.selection.endAnchor)
			: null;
	// JOINT expectation — a range's endpoints do not recover
	// independently: one live anchor collapses the whole selection to the
	// survivor; two dead anchors + a dead endpoint collapse to the
	// start-block seam or the root fallback. Checking each endpoint
	// against its own seam rejects the valid survivor collapse.
	const acceptable = acceptableSelectionShapes({
		isCollapsed: pre.selection.isCollapsed,
		preStart: {
			blockId: pre.selection.startBlockId ?? '',
			textId: pre.selection.startTextId ?? '',
			offset: pre.selection.yStart
		},
		preEnd: {
			blockId: pre.selection.endBlockId ?? '',
			textId: pre.selection.endTextId ?? '',
			offset: pre.selection.yEnd
		},
		resolvedStart,
		resolvedEnd,
		startDead,
		endDead,
		// The seam belongs to the START block's dead chain — production's
		// seam walk reads `state.startBlock` regardless of which endpoint
		// died; a surviving start block has no drop links and the walk
		// falls through to the root fallback.
		seam:
			startBlockDied && pre.selection.startBlockId
				? seamExpectation(pre, post, pre.selection.startBlockId)
				: null,
		rootFallback: rootFallbackSpot(post)
	});
	if (acceptable.length === 0) {
		throw new CollabRunError(
			'remote-selection-misplaced',
			`peer ${actorId} selection has no contract landing ` +
				`(start block ${pre.selection.startBlockId} ${startBlockDied ? 'died' : 'survived'}, ` +
				`start text ${pre.selection.startTextId} ${startDead ? 'dead' : 'alive'}, ` +
				`end text ${pre.selection.endTextId} ${endDead ? 'dead' : 'alive'}, ` +
				`anchors ${resolvedStart ? 'start-resolved' : 'start-dead'}/` +
				`${resolvedEnd ? 'end-resolved' : 'end-dead'})`,
			{ dumps: { [actorId]: post } }
		);
	}
	const landed = acceptable.some(
		(spot) =>
			spot.start.blockId === post.selection?.startBlockId &&
			spot.start.textId === post.selection.startTextId &&
			spot.start.offset === post.selection.yStart &&
			spot.end.blockId === post.selection.endBlockId &&
			spot.end.textId === post.selection.endTextId &&
			spot.end.offset === post.selection.yEnd &&
			spot.isCollapsed === post.selection.isCollapsed
	);
	if (!landed) {
		throw new CollabRunError(
			'remote-selection-misplaced',
			`peer ${actorId} selection recovered to ` +
				`${post.selection.startBlockId}#${post.selection.startTextId}@${post.selection.yStart} → ` +
				`${post.selection.endBlockId}#${post.selection.endTextId}@${post.selection.yEnd} ` +
				`(collapsed ${post.selection.isCollapsed}) — no contract ` +
				`shape matches ${JSON.stringify(acceptable)} ` +
				`(anchors ${pre.selection.startAnchor == null ? 'absent' : pre.selection.startAnchorOk ? 'consistent' : 'stale'}/` +
				`${pre.selection.endAnchor == null ? 'absent' : pre.selection.endAnchorOk ? 'consistent' : 'stale'}; ` +
				`start block ${pre.selection.startBlockId} ${startBlockDied ? 'died' : 'survived'} to the remote edit)`,
			{
				dumps: {
					[actorId]: post,
					expected: acceptable,
					actual: {
						start: {
							blockId: post.selection.startBlockId,
							textId: post.selection.startTextId,
							offset: post.selection.yStart
						},
						end: {
							blockId: post.selection.endBlockId,
							textId: post.selection.endTextId,
							offset: post.selection.yEnd
						},
						isCollapsed: post.selection.isCollapsed
					}
				}
			}
		);
	}
};

// ── Failure fingerprinting ─────────────────────────────────────────────
// Replicates `runner.ts`'s `firstMismatchPath`/`normalizeMismatchPath`/
// `parseSemanticSignature` locally — that file is independently owned, so
// the small helpers are copied rather than imported. The payload mirrors
// the solo lane's `{version, code, engine, action, selectionKind,
// subtype}` with `engine` replaced by the collab peer axis (acting peer +
// failing peer).

/**
 * Deepest path at which `left` and `right` first differ, or `null` when
 * they are deep-equal. `Object.is` alone cannot short-circuit structural
 * equality — deep-equal objects still recurse, and a "mismatch" that only
 * exists by reference previously STOPPED inside the first unchanged
 * block, reporting `:object`/`:array` stubs that collapsed every later
 * defect into one fingerprint. The walk now continues past equal
 * siblings, and an arity gap reports the position where the extra
 * element sits plus which side grew.
 */
const firstMismatchPath = (left: unknown, right: unknown, path = '$'): string | null => {
	if (Object.is(left, right)) return null;
	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right)) return `${path}:type`;
		const shared = Math.min(left.length, right.length);
		for (let index = 0; index < shared; index++) {
			const sub = firstMismatchPath(left[index], right[index], `${path}[${index}]`);
			if (sub !== null) return sub;
		}
		if (left.length !== right.length) {
			return `${path}[${shared}]:arity-${left.length}v${right.length}`;
		}
		return null;
	}
	if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
		return path;
	}
	const leftObject = left as Record<string, unknown>;
	const rightObject = right as Record<string, unknown>;
	const keys = [...new Set([...Object.keys(leftObject), ...Object.keys(rightObject)])].sort();
	for (const key of keys) {
		if (!(key in leftObject) || !(key in rightObject)) return `${path}.${key}:presence`;
		const sub = firstMismatchPath(leftObject[key], rightObject[key], `${path}.${key}`);
		if (sub !== null) return sub;
	}
	return null;
};

/**
 * Shape-stable form of a mismatch path: indices normalize to `[]` for
 * bucketing, but the raw index sequence rides along as `@i,j,k` — a
 * defect at `children[0]` and an unrelated one at `children[3]` are
 * different reduction classes, while the same defect re-running at the
 * same positions keeps one fingerprint.
 */
const normalizeMismatchPath = (path: string | null): string => {
	if (path === null) return '$:equal';
	const indices = [...path.matchAll(/\[(\d+)\]/g)].map((m) => m[1]).join(',');
	const stripped = path.replace(/\[\d+\]/g, '[]');
	return indices === '' ? stripped : `${stripped}@${indices}`;
};

/** Semantic signatures travel as JSON strings — parse before diffing. */
const parseSemanticSignature = (value: unknown): unknown => {
	if (typeof value !== 'string') return value;
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return value;
	}
};

/** The `{value, blocks, lineage}` triple `dumpSignature` compares. */
const dumpProjection = (dump: unknown) => {
	const d = dump as DocumentDump | null | undefined;
	return { value: d?.value, blocks: d?.blocks, lineage: d?.lineage };
};

const isDocumentDump = (dump: unknown): dump is DocumentDump =>
	dump !== null && typeof dump === 'object' && 'value' in dump && 'blocks' in dump;

/**
 * The normalized "where did it actually differ" bucket inside a code —
 * two `delete-result-mismatch` failures on different subtrees must not
 * shrink into each other, and a `partition-leak` via the update log is a
 * different defect than one via the state vector.
 */
const collabFailureSubtype = (
	failure: Pick<CollabRunFailure, 'code' | 'details' | 'dumps' | 'referenceDump'>
): string => {
	const details =
		failure.details && typeof failure.details === 'object'
			? (failure.details as Record<string, unknown>)
			: null;
	if (failure.code === 'selection-model-dom-mismatch' && details) {
		const selection = details.selection as
			| { isCollapsed?: boolean; isReversed?: boolean }
			| undefined;
		const native = details.native as
			| {
					isCollapsed?: boolean;
					isReversed?: boolean;
					start?: { kind?: string };
					end?: { kind?: string };
					selectedNode?: unknown;
			  }
			| undefined;
		if (!native) return 'native-missing';
		if (native.selectedNode) return 'native-node-for-text';
		if (selection?.isCollapsed !== native.isCollapsed) return 'collapsed';
		if (selection?.isReversed !== native.isReversed) return 'direction';
		if (native.start?.kind === 'outside' || native.end?.kind === 'outside') return 'outside';
		return `endpoint:${native.start?.kind ?? 'missing'}:${native.end?.kind ?? 'missing'}`;
	}
	if (failure.code === 'selection-kind-mismatch' && details) {
		const selection = details.selection as { kind?: string } | undefined;
		const native = details.native as { selectedNode?: { kind?: string } | null } | undefined;
		return `${selection?.kind ?? 'none'}:${native?.selectedNode?.kind ?? 'none'}`;
	}
	if (details && 'expected' in details && 'actual' in details) {
		// Exact-oracle mismatches (delete result/selection, history
		// roundtrip) carry the expected/actual pair — diff to the FIRST
		// divergent path so a mark-loss defect can't shrink into a
		// lost-child defect.
		return normalizeMismatchPath(
			firstMismatchPath(
				parseSemanticSignature(details.expected),
				parseSemanticSignature(details.actual)
			)
		);
	}
	if (details && 'model' in details && 'dom' in details) {
		return normalizeMismatchPath(firstMismatchPath(details.model, details.dom));
	}
	if (failure.code === 'partition-leak' && failure.dumps) {
		const leak = failure.dumps.leak as { sv?: boolean; providerLog?: boolean } | undefined;
		if (leak) {
			return [leak.sv ? 'sv' : null, leak.providerLog ? 'provider-log' : null]
				.filter(Boolean)
				.join('+');
		}
	}
	if (failure.code === 'stale-remote-overlay' && failure.dumps) {
		// Dead-anchor, unresolvable-anchor and orphaned-span staleness are
		// different defects — keep them in separate shrink buckets.
		const overlays = failure.dumps.staleOverlays;
		if (Array.isArray(overlays)) {
			const reasons = [
				...new Set(overlays.map((entry) => (entry as { reason?: string }).reason ?? 'unknown'))
			].sort();
			if (reasons.length) return reasons.join('+');
		}
	}
	if (failure.code === 'peers-diverged' && failure.dumps) {
		// First pair of peers whose canonical dump differs — the path
		// inside `{value, blocks, lineage}` where they split.
		const dumps = Object.values(failure.dumps).filter(isDocumentDump);
		const reference = dumps[0];
		const divergent = dumps.find((dump) => dumpSignature(dump) !== dumpSignature(reference));
		if (reference && divergent) {
			return normalizeMismatchPath(
				firstMismatchPath(dumpProjection(reference), dumpProjection(divergent))
			);
		}
	}
	if (failure.code === 'reference-mismatch' && failure.dumps && failure.referenceDump) {
		const referenceSignature = dumpSignature(failure.referenceDump as DocumentDump);
		const divergent = Object.values(failure.dumps).find(
			(dump) => isDocumentDump(dump) && dumpSignature(dump) !== referenceSignature
		);
		if (divergent) {
			return normalizeMismatchPath(
				firstMismatchPath(dumpProjection(divergent), dumpProjection(failure.referenceDump))
			);
		}
	}
	return failure.code;
};

/**
 * sha256 fingerprint over the failure's stable identity — code, action
 * shape, selection shape, peer role and normalized mismatch path. The
 * minimizer accepts a candidate only when it reproduces THIS digest, so
 * shrinking can strip causally irrelevant steps but can never retarget
 * the defect (a `delete-result-mismatch` can't collapse into an
 * `action-produced-no-effect` or a disconnected-page timeout).
 */
export const collabFailureFingerprint = (
	failure: Pick<CollabRunFailure, 'code' | 'step' | 'peer' | 'details' | 'dumps' | 'referenceDump'>
): string => {
	const step = failure.step;
	const payload = {
		version: 1,
		code: failure.code,
		action:
			step?.kind === 'edit'
				? step.action.kind
				: step?.kind === 'net'
					? `net:${step.op.kind}`
					: null,
		selectionKind: step?.kind === 'edit' ? step.selection.kind : null,
		// Peer ids are deterministic (`peer-N`), so pinning the acting peer
		// keeps "B deletes the block A's caret sits in" distinct from the
		// same code fired on a symmetric pair — without depending on the
		// transient block ids the schedule resolved.
		actingPeer: step?.kind === 'edit' ? `peer-${step.peer}` : null,
		failingPeer: failure.peer ?? null,
		subtype: collabFailureSubtype(failure)
	};
	return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
};

export const runCollabSchedule = async (
	browser: Browser,
	baseURL: string,
	schedule: CollabSchedule
): Promise<CollabRunResult> => {
	const relay: OpaqueRelay = await startOpaqueRelay();
	const room = `collab-dst-${schedule.seed}-${Math.random().toString(36).slice(2, 8)}`;
	const ledger: CollabLedgerEntry[] = [];
	const peers: PeerRuntime[] = [];
	const referenceDoc = new Y.Doc();
	let reference: EdytorDocument | undefined;
	let held = false;
	/**
	 * Peers whose own-client clock advanced during the current hold window —
	 * the authored-update ledger. Distinct PEER ACTIONS are not enough: a
	 * held episode only proves multi-writer concurrency when ≥2 peers
	 * actually committed updates while blind, so `release` asserts it.
	 */
	const heldAuthors = new Set<number>();
	let stepIndex = -1;
	let step: CollabStep | null = null;

	const feedReference = (updateB64: string) => {
		Y.applyUpdate(referenceDoc, unb64(updateB64));
	};

	try {
		for (let index = 0; index < schedule.peerCount; index++) {
			peers.push(await openPeer(browser, baseURL, schedule, room, relay.url, index));
		}
		// Every provider reached synced through the socket handshake — BC is
		// disabled so there is no other path.
		for (const peer of peers) {
			await expect
				.poll(() => providerState(peer.page), { timeout: 15_000 })
				.toMatchObject({ wsconnected: true, synced: true });
		}
		// Baseline: capture each peer's initial state (seed writes +
		// handshake state) and feed the reference doc.
		for (const peer of peers) {
			const { updateB64, svB64, ownClock } = await captureUpdate(peer);
			feedReference(updateB64);
			peer.sv = unb64(svB64);
			peer.ownClock = ownClock;
		}
		reference = attachDocument(referenceDoc, {
			lineage: { depth: schedule.lineageDepth }
		});
		// Seeds dedupe to one shared document — prove it before the schedule.
		const initial = await expectConverged(peers, peers, 20_000);
		for (const peer of peers) {
			if (!initial[peer.actorId].value.children.length) {
				throw new CollabRunError('empty-seed', 'converged document has no blocks');
			}
			if (initial[peer.actorId].actor !== peer.actorId) {
				throw new CollabRunError(
					'actor-mismatch',
					`peer ${peer.actorId} mounted with actor ${initial[peer.actorId].actor}`
				);
			}
		}

		for (stepIndex = 0; stepIndex < schedule.steps.length; stepIndex++) {
			step = schedule.steps[stepIndex];

			if (step.kind === 'net') {
				const op = step.op;
				// Selection baselines around EVERY net op that can deliver —
				// `release`, `reconnect`, `killRoom`, `healBarrier` (and the
				// no-delivery ops, where frames=0 asserts the selection must
				// not have moved at all). Without this the edit-step gate is
				// bypassed by exactly the operations that deliver the most
				// updates at once, and the barrier sanity check accepts
				// `selection: null` — a release that strands a passive caret
				// on dead text would pass the final convergence barrier.
				// `reload` resets the peer's whole page: its baseline is
				// meaningless post-reload, so only the OTHER peers are
				// captured — they must not move (a relay replay storm would
				// otherwise go unnoticed).
				const netBefore = new Map<number, { providerUpdates: number; dump?: DocumentDump }>();
				for (const peer of peers) {
					if (op.kind === 'reload' && peer.index === op.peer) continue;
					const { providerUpdates } = await captureUpdate(peer);
					// Disconnected peers dump too — their page is alive, and
					// "received nothing ⇒ selection must not move" is exactly
					// the check that catches a stray relay rebroadcast landing
					// on a partitioned peer.
					const dump = await dumpDocument(peer.page).catch(() => undefined);
					netBefore.set(peer.index, { providerUpdates, dump });
				}
				switch (op.kind) {
					case 'hold':
						relay.hold(room);
						held = true;
						heldAuthors.clear();
						break;
					case 'release':
						// A held window only proves multi-writer concurrency if
						// ≥2 distinct peers' own-client clocks advanced inside it —
						// distinct ACTIONS can all no-op. The generator pins the
						// first two blind edits to `type` on different peers, so
						// starvation here means the harness weakened, not chance.
						// (Guarded on `held`: a minimized schedule can slice a
						// release free of its hold — a bare release is a no-op.)
						if (held && heldAuthors.size < 2) {
							throw new CollabRunError(
								'held-episode-starved',
								`held window ended with ${heldAuthors.size} authoring peer(s) ` +
									`([${[...heldAuthors].join(',')}]) — concurrent updates were not generated`,
								{ dumps: { heldAuthors: [...heldAuthors] } }
							);
						}
						relay.release(room, {
							permute: op.permute,
							duplicates: op.duplicates
						});
						held = false;
						break;
					case 'dropNext':
						relay.dropNext(room, op.count);
						break;
					case 'latency':
						relay.setLatency(room, op.ms);
						break;
					case 'disconnect': {
						const peer = peers[op.peer];
						if (!peer?.connected) break;
						await setProviderConnected(peer.page, false);
						peer.connected = false;
						await expect
							.poll(() => providerState(peer.page))
							.toMatchObject({ wsconnected: false, synced: false });
						break;
					}
					case 'reconnect': {
						const peer = peers[op.peer];
						if (!peer || peer.connected) break;
						await setProviderConnected(peer.page, true);
						await expect
							.poll(() => providerState(peer.page), { timeout: 15_000 })
							.toMatchObject({ wsconnected: true, synced: true });
						peer.connected = true;
						break;
					}
					case 'reload': {
						const peer = peers[op.peer];
						if (!peer) break;
						await peer.page.reload({ waitUntil: 'domcontentloaded' });
						await waitForEditorReady(peer.page, { requireRuntime: true });
						await expect
							.poll(() => providerState(peer.page), { timeout: 15_000 })
							.toMatchObject({ wsconnected: true, synced: true });
						await settleEditor(peer.page);
						peer.connected = true;
						// Rebaseline — the fresh doc's local clock restarted; the next
						// diff must measure from the re-handshaked state.
						const { svB64, ownClock } = await captureUpdate(peer);
						peer.sv = unb64(svB64);
						peer.ownClock = ownClock;
						break;
					}
					case 'killRoom': {
						relay.killRoom(room);
						// Provider backoff re-dials — wait for the full room back.
						await expect
							.poll(() => relay.socketCount(room), { timeout: 20_000 })
							.toBe(schedule.peerCount);
						for (const peer of peers) {
							await expect
								.poll(() => providerState(peer.page), { timeout: 15_000 })
								.toMatchObject({ wsconnected: true, synced: true });
						}
						break;
					}
					case 'healBarrier':
						// A barrier only proves something for peers that can receive —
						// skip it while the relay holds (nothing can flow) or while a
						// peer is intentionally still partitioned.
						if (!held) {
							await healBarrier(peers, reference!, schedule.lineageDepth);
						}
						break;
				}
				// Post-op selection gate — the same contract the edit step
				// runs after `expectConverged`. Presence + collapsed-ness on
				// every frame count, exact joint-shape replay on a single
				// delivered frame, and "no delivery ⇒ no movement" when the
				// peer's provider log didn't advance. Peers skipped at
				// capture (the `reload` target) have no baseline to compare
				// and are intentionally absent here.
				for (const peer of peers) {
					const before = netBefore.get(peer.index);
					if (!before) continue;
					const post = await dumpDocument(peer.page).catch(() => undefined);
					if (post) assertDumpSelectionSane(peer.actorId, post);
					await assertPassiveSelectionExact(
						peer.actorId,
						peer,
						before.dump,
						before.providerUpdates,
						post
					);
				}
				ledger.push({
					stepIndex,
					peer: -1,
					action: step,
					updateB64: null,
					connected: peers.filter((peer) => peer.connected).map((peer) => peer.index),
					held
				});
				continue;
			}

			// ── Edit step ────────────────────────────────────────────────
			const actor = peers[step.peer];
			if (!actor) {
				throw new CollabRunError('bad-peer', `schedule names peer ${step.peer}`);
			}
			// Resolve against the pre-selection state, then re-capture AFTER
			// the selection lands — `assertActionEffect`/`performAction` must
			// reason about the selection the action actually saw (the
			// single-doc runner's `selectedSnapshots` ordering).
			const preSnapshot = await captureBrowserSnapshot(actor.page);
			assertBrowserSnapshot(actor.actorId, preSnapshot);
			const resolvedSelection: ResolvedSelection =
				step.selection.kind === 'peerCaretBlock'
					? await resolvePeerCaretBlock(step.selection, actor, peers, preSnapshot)
					: resolveSelection(step.selection, preSnapshot);
			await setSelection(actor.page, resolvedSelection);
			await settleEditor(actor.page);
			const actingBefore = await captureBrowserSnapshot(actor.page);
			assertBrowserSnapshot(actor.actorId, actingBefore, { requireSelection: true });

			// Passive-peer isolation baseline: state vector AND the count
			// of provider-applied updates. The SV alone misses delete-only
			// leaks — tombstones advance no insertion clock — so the update
			// log's `isProvider` tally rides along as the second channel.
			const passiveBefore = new Map<
				number,
				{ svB64: string; providerUpdates: number; dump?: DocumentDump }
			>();
			for (const peer of peers) {
				if (peer !== actor) {
					const { svB64, providerUpdates } = await captureUpdate(peer);
					// The pre-step dump feeds `assertPassiveSelectionExact` — a
					// passive peer's selection can only move via remote
					// delivery, so pre/post dumps bound the recovery contract.
					const dump = peer.connected
						? await dumpDocument(peer.page).catch(() => undefined)
						: undefined;
					passiveBefore.set(peer.index, { svB64, providerUpdates, dump });
				}
			}
			// While held the ACTOR is partitioned for delivery as well —
			// baseline its provider-applied count so the post-action check
			// can prove no remote frame slipped through (its SV legitimately
			// advances from the action itself, so it isn't in passiveBefore).
			const actorProviderBefore = held ? (await captureUpdate(actor)).providerUpdates : -1;

			await resetRemoteApplyCount(actor.page);
			const guardSwallowsBefore = await guardSwallowCount(actor.page);
			await performAction(actor.page, step.action, actingBefore);
			await settleEditor(actor.page);

			const actingAfter = await captureBrowserSnapshot(actor.page);
			assertBrowserSnapshot(actor.actorId, actingAfter, {
				requireSelection: true,
				allowOutsideNative: isStickyOutsideEscape(step.action, actingBefore, actingAfter)
			});
			await assertPeerClean(actor);
			assertTrustedAction(actor.actorId, step.action, actingAfter.events);
			const remoteApplies = await remoteApplyCount(actor.page);
			try {
				// Intent before effect: a wordDelete chord that delivered
				// deleteContent* (or nothing) is a unit mismatch, not a pass —
				// same gate as the solo lane.
				assertDeleteIntent(actor.actorId, step.action, actingBefore, actingAfter);
				assertActionEffect(actor.actorId, step.action, actingBefore, actingAfter, {});
			} catch (error) {
				if (!(error instanceof DstHarnessFailure)) {
					throw error;
				}
				// Attach the action-window event trace — the post-action
				// snapshot already drained the recorder — plus the live
				// focus/selection state, so browser-specific no-ops name
				// the exact beforeinput/key sequence that produced nothing
				// and where the DOM selection actually sat.
				const domState = await actor.page
					.evaluate(() => {
						const active = document.activeElement;
						const sel = document.getSelection();
						const anchor =
							sel?.anchorNode instanceof Element ? sel.anchorNode : sel?.anchorNode?.parentElement;
						return {
							activeElement: active
								? `${active.tagName}#${(active as HTMLElement).id}.${(active as HTMLElement).className}`
								: null,
							activeIsContentEditable: (active as HTMLElement | null)?.isContentEditable ?? null,
							activeInsideEditor: Boolean(
								active && (active as HTMLElement).closest?.('[data-edytor-root]')
							),
							activeInsideContenteditable: Boolean(
								active && (active as HTMLElement).closest?.('[contenteditable]')
							),
							anchorInsideEditor: Boolean(
								anchor?.closest?.('[data-edytor-root],[contenteditable]')
							),
							anchorText: sel?.anchorNode?.textContent?.slice(0, 40) ?? null,
							anchorOffset: sel?.anchorOffset ?? null,
							rangeCount: sel?.rangeCount ?? null
						};
					})
					.catch(() => null);
				// Live engine serialization at failure time — catches a stale
				// `edytor.value`/snapshot that the DOM↔model checks cannot
				// (both sides can lag the same pending commit).
				const facadeJson = await actor.page
					.evaluate(() => {
						const edytor = (
							window as unknown as {
								__EDYTOR__?: { facade?: { toJSON?: () => unknown } };
							}
						).__EDYTOR__;
						return edytor?.facade?.toJSON?.() ?? null;
					})
					.catch(() => null);
				error.details = {
					...(typeof error.details === 'object' && error.details !== null
						? (error.details as Record<string, unknown>)
						: { details: error.details }),
					events: actingAfter.events,
					domState,
					facadeJson,
					remoteApplies
				};
				// `history-produced-no-effect` is unconditionally tolerated in
				// collab: undoing an op a REMOTE edit already neutralized (e.g.
				// peer-2's doc-replace deleted peer-1's insert before peer-1's
				// undo) is a correct semantic no-op. This is safe because the
				// oracle checks `history-stack-did-not-advance` FIRST — the
				// tolerated code can only fire after the stack provably moved.
				// Action no-ops tolerate only when a remote apply landed inside
				// the action window (selection recovery / stale caret) or the
				// post-composition phantom guard provably swallowed the key.
				const guardSwallows = (await guardSwallowCount(actor.page)) - guardSwallowsBefore;
				const tolerated =
					error.code === 'history-produced-no-effect' ||
					(remoteApplies > 0 && REMOTE_SUPPRESSIBLE.has(error.code)) ||
					(guardSwallows > 0 &&
						GUARD_SWALLOWABLE.has(step.action.kind) &&
						error.code === 'action-produced-no-effect');
				if (!tolerated) {
					throw error;
				}
				ledger.push({
					stepIndex,
					peer: step.peer,
					action: step,
					updateB64: null,
					connected: peers.filter((peer) => peer.connected).map((peer) => peer.index),
					held,
					note:
						guardSwallows > 0
							? `suppressed-by-composition-guard:${error.code}`
							: `suppressed-by-remote:${error.code}:${remoteApplies}`
				});
			}

			// Capture the authored update at the source — before delivery
			// decisions take effect — and feed the reference doc. While held,
			// the actor's own-client clock advancing is the proof this edit
			// authored an update (a tolerated no-op never counts).
			const {
				updateB64,
				svB64,
				ownClock,
				providerUpdates: actorProviderAfter
			} = await captureUpdate(actor);
			feedReference(updateB64);
			actor.sv = unb64(svB64);
			if (held && ownClock > actor.ownClock) heldAuthors.add(step.peer);
			actor.ownClock = ownClock;

			// The actor is partitioned for DELIVERY too while held — its own
			// edits legitimately advance its SV, so only the provider-log
			// channel can check it. A provider-origin frame landing on the
			// actor inside a hold window is the same leak as on a peer.
			if (held && actorProviderAfter !== actorProviderBefore) {
				const entries = await providerLogSince(actor.page, actorProviderBefore).catch(() => null);
				throw new CollabRunError(
					'partition-leak',
					`actor ${actor.actorId} received ${entries?.length ?? 'an'} update(s) while ` +
						`held at step ${stepIndex}`,
					{
						dumps: {
							leak: {
								peer: actor.actorId,
								connected: actor.connected,
								held,
								sv: false,
								providerLog: true,
								entries
							}
						}
					}
				);
			}

			// Partitioned peers must have received NOTHING. Two channels
			// prove it: the state vector must not advance (catches
			// insert-bearing leaks) AND no new provider-applied update may
			// appear in the log (catches delete-only leaks that leave every
			// clock unchanged — `isProvider` marks socket delivery, local
			// edits can't mint it).
			for (const peer of peers) {
				if (peer === actor) continue;
				const partitioned = !peer.connected || held;
				if (partitioned) {
					const before = passiveBefore.get(peer.index);
					const { svB64: afterSv, providerUpdates: afterProviderUpdates } =
						await captureUpdate(peer);
					const svLeaked = afterSv !== before?.svB64;
					const providerLeaked = afterProviderUpdates !== before?.providerUpdates;
					if (svLeaked || providerLeaked) {
						// Surface WHAT leaked — the appended provider frames name
						// the delivery the state vector alone couldn't see.
						const entries = await providerLogSince(peer.page, before?.providerUpdates ?? 0).catch(
							() => null
						);
						throw new CollabRunError(
							'partition-leak',
							`peer ${peer.actorId} received ${entries?.length ?? 'an'} update(s) while ` +
								`partitioned (connected=${peer.connected} held=${held} ` +
								`sv=${svLeaked ? 'changed' : 'unchanged'}) at step ${stepIndex}`,
							{
								dumps: {
									leak: {
										peer: peer.actorId,
										connected: peer.connected,
										held,
										sv: svLeaked,
										providerLog: providerLeaked,
										entries
									}
								}
							}
						);
					}
				}
			}

			// Connected peers converge on the acting peer's canonical state —
			// while held, nobody converges (checked above); connected peers
			// settle to the same signature asynchronously.
			//
			// This settle doubles as the PER-STEP passive-selection gate:
			// `expectConverged` dumps every connected peer and runs
			// `assertDumpSelectionSane` on each — actor and non-acting peers
			// alike — so a remote delivery that strands a passive caret on a
			// deleted block or an out-of-bounds offset fails AT THE STEP, not
			// just at the next heal barrier. Partitioned peers (held or
			// disconnected) can't receive — the check above proved it — so
			// their selection can't have moved and isn't re-read (a per-peer
			// dump each step would also cost one evaluate per peer for no new
			// information). Selection movement from `release`/`reconnect`/
			// `killRoom` net ops is caught at the next converge point — the
			// generated episodes always end in a `healBarrier`.
			if (!held) {
				const targets = peers.filter((peer) => peer.connected);
				const stepDumps = await expectConverged(peers, targets);
				// Passive peers only move via remote delivery — every dead
				// endpoint must sit at the contract seam (block + text + UTF-16
				// offset), not just somewhere live and in-bounds. The acting
				// peer's caret legitimately moved with its own edit, so the
				// exact gate covers non-actor targets only.
				for (const peer of targets) {
					if (peer === actor) continue;
					const before = passiveBefore.get(peer.index);
					await assertPassiveSelectionExact(
						peer.actorId,
						peer,
						before?.dump,
						before?.providerUpdates ?? -1,
						stepDumps[peer.actorId]
					);
				}
			}

			ledger.push({
				stepIndex,
				peer: step.peer,
				action: step,
				updateB64,
				connected: peers.filter((peer) => peer.connected).map((peer) => peer.index),
				held
			});
		}

		return { ok: true, ledger };
	} catch (error) {
		// Keep the REAL failure identity: `DstHarnessFailure` codes
		// (`delete-result-mismatch`, `action-produced-no-effect`, …) carry
		// the oracle verdict — collapsing them to `unexpected` would let
		// the minimizer shrink one defect into another. Uncoded errors
		// keep their constructor name (`unexpected:TimeoutError` vs a bare
		// `unexpected:Error`) so distinct harness faults stay distinct.
		const failureBase: Omit<CollabRunFailure, 'fingerprint'> = {
			code:
				error instanceof CollabRunError || error instanceof DstHarnessFailure
					? error.code
					: `unexpected:${error instanceof Error ? error.name || 'Error' : typeof error}`,
			message: error instanceof Error ? (error.stack ?? error.message) : String(error),
			stepIndex,
			step,
			peer: error instanceof DstHarnessFailure ? error.engine : undefined,
			ledger,
			details:
				error instanceof DstHarnessFailure
					? (error.details as Record<string, unknown> | undefined)
					: undefined,
			dumps: error instanceof CollabRunError ? error.dumps : undefined,
			referenceDump: error instanceof CollabRunError ? error.referenceDump : undefined
		};
		return {
			ok: false,
			failure: { ...failureBase, fingerprint: collabFailureFingerprint(failureBase) }
		};
	} finally {
		reference?.destroy();
		referenceDoc.destroy();
		await Promise.all(peers.map((peer) => peer.context.close().catch(() => undefined)));
		await relay.close();
	}
};

/**
 * Chunk-removal minimization over the step stream. Net ops are all
 * optional no-ops, so any slice stays runnable; "same failure" means the
 * same FINGERPRINT — code + action/selection shape + peer role +
 * normalized mismatch path — not just the outer code. A candidate that
 * still fails but differently (a `delete-result-mismatch` degrading into
 * an `action-produced-no-effect`, or a causal prerequisite like the
 * partition vanishing so the leak can't re-fire) is REJECTED, which is
 * what keeps the minimized repro about the same defect.
 */
export const minimizeCollabFailure = async (
	browser: Browser,
	baseURL: string,
	schedule: CollabSchedule,
	failure: CollabRunFailure,
	maxAttempts = 30,
	maxDurationMs = Number(process.env.COLLAB_DST_SHRINK_BUDGET_MS ?? 120_000)
): Promise<{
	schedule: CollabSchedule;
	attempts: number;
	fingerprint: string;
	termination: 'fixed-point' | 'attempt-limit' | 'time-budget';
}> => {
	const durationBudget =
		Number.isFinite(maxDurationMs) && maxDurationMs >= 0 ? maxDurationMs : 120_000;
	let steps = schedule.steps.slice(0, failure.stepIndex + 1);
	let chunk = Math.max(1, Math.floor(steps.length / 2));
	let attempts = 0;
	const deadline = Date.now() + durationBudget;
	while (chunk >= 1 && attempts < maxAttempts && Date.now() < deadline) {
		let reduced = false;
		for (
			let index = 0;
			index + chunk <= steps.length && attempts < maxAttempts && Date.now() < deadline;
			index++
		) {
			const candidate = steps.slice(0, index).concat(steps.slice(index + chunk));
			if (candidate.length === 0) continue;
			attempts += 1;
			const replay = await runCollabSchedule(browser, baseURL, {
				...schedule,
				steps: candidate
			});
			if (!replay.ok && replay.failure.fingerprint === failure.fingerprint) {
				steps = candidate;
				reduced = true;
				break;
			}
		}
		if (!reduced) chunk = Math.floor(chunk / 2);
	}
	return {
		schedule: { ...schedule, steps },
		attempts,
		fingerprint: failure.fingerprint,
		termination:
			Date.now() >= deadline
				? 'time-budget'
				: attempts >= maxAttempts
					? 'attempt-limit'
					: 'fixed-point'
	};
};
