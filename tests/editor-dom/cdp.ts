/**
 * cdp lane harness (architecture v2 plan §8 "Lanes", §9.3 G0, §12 BI-10).
 *
 * Drives Chromium's REAL IME path through the DevTools protocol:
 * `Input.imeSetComposition` makes Blink's `InputMethodController` open/update
 * a composition (trusted `compositionstart`/`compositionupdate`, trusted
 * `beforeinput`/`input` with `insertCompositionText`, the browser itself
 * writing the preview into the focused text node), and `Input.insertText`
 * confirms it (trusted `insertFromComposition`/`compositionend`). This is
 * what `dispatchComposition` in `helpers.ts` cannot be: those events are
 * script-dispatched (`isTrusted: false`), the browser never edits the DOM,
 * and no IME node exists — so they cannot falsify IME-node survival,
 * no-write-during-composition or post-commit claims.
 *
 * A second browser context on the same websocket room acts as the peer, so a
 * peer edit arrives over the real provider stack while the composition is
 * live (`openImePeerPair`).
 *
 * Every helper here is test-side only — nothing patches production code;
 * the spies patch DOM prototypes inside the page.
 */
import type { Browser, BrowserContext, CDPSession, Page, TestInfo } from '@playwright/test';

import { expect } from './editorTest';
import { gotoEditorRoute, readJsonByTestId } from './helpers';
import { startOpaqueRelay, type OpaqueRelay } from './ws-relay';

// ---------------------------------------------------------------------------
// IME driver
// ---------------------------------------------------------------------------

export type ImeComposeOptions = {
	/** Caret inside the composition text (UTF-16), default: end of `text`. */
	selectionStart?: number;
	selectionEnd?: number;
	/**
	 * Replace an existing range of the focused text (UTF-16 offsets in the
	 * focused editable) instead of the current composition/selection — what
	 * an IME does when it reconverts committed text.
	 */
	replacementStart?: number;
	replacementEnd?: number;
};

export type Ime = {
	client: CDPSession;
	/** Open or update the live composition to show `text`. */
	compose: (text: string, options?: ImeComposeOptions) => Promise<void>;
	/** Run `compose` for each step, waiting `gapMs` between steps. */
	composeSteps: (steps: string[], gapMs?: number) => Promise<void>;
	/** Confirm the composition with `text` (`Input.insertText`). */
	commit: (text: string) => Promise<void>;
	/** Cancel: empty the composition, then confirm nothing. */
	cancel: () => Promise<void>;
	detach: () => Promise<void>;
};

/**
 * Open a CDP session on `page` and return the IME driver. Chromium only
 * (the `cdp` project is Chromium-only by construction).
 */
export const openIme = async (page: Page): Promise<Ime> => {
	const browserName = page.context().browser()?.browserType().name();
	if (browserName && browserName !== 'chromium') {
		throw new Error(`the cdp IME driver needs Chromium, got ${browserName}`);
	}
	const client = await page.context().newCDPSession(page);
	let detached = false;

	const compose: Ime['compose'] = async (text, options = {}) => {
		const caret = options.selectionStart ?? text.length;
		await client.send('Input.imeSetComposition', {
			text,
			selectionStart: caret,
			selectionEnd: options.selectionEnd ?? caret,
			...(options.replacementStart !== undefined
				? { replacementStart: options.replacementStart }
				: {}),
			...(options.replacementEnd !== undefined ? { replacementEnd: options.replacementEnd } : {})
		});
	};

	return {
		client,
		compose,
		composeSteps: async (steps, gapMs = 0) => {
			for (const [index, step] of steps.entries()) {
				if (index > 0 && gapMs > 0) {
					await page.waitForTimeout(gapMs);
				}
				await compose(step);
			}
		},
		commit: async (text) => {
			await client.send('Input.insertText', { text });
		},
		cancel: async () => {
			await client.send('Input.imeSetComposition', {
				text: '',
				selectionStart: 0,
				selectionEnd: 0
			});
			await client.send('Input.insertText', { text: '' });
		},
		detach: async () => {
			if (detached) return;
			detached = true;
			await client.detach();
		}
	};
};

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

type ContentPart = { text?: string; type?: string; marks?: Record<string, unknown> };
type SerializedBlock = { id?: string; content?: ContentPart[]; children?: SerializedBlock[] };
type SerializedValue = { children: SerializedBlock[] };

export const readValue = (page: Page) => readJsonByTestId<SerializedValue>(page, 'value');

/** Model text of root child `index` (inline atoms contribute nothing). */
export const readBlockText = async (page: Page, index: number) =>
	((await readValue(page)).children[index]?.content ?? []).map((part) => part.text ?? '').join('');

export const readBlockTexts = async (page: Page) =>
	(await readValue(page)).children.map((block) =>
		(block.content ?? []).map((part) => part.text ?? '').join('')
	);

/** Model content parts (text + marks, canonicalized) of root child `index`. */
export const readBlockContent = async (page: Page, index: number) =>
	(await readValue(page)).children[index]?.content ?? [];

/** DOM `textContent` of the `index`-th `[data-edytor-text]` element. */
export const readDomText = (page: Page, textIndex: number) =>
	page.evaluate((index) => {
		const texts = document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]');
		return texts[index]?.textContent ?? null;
	}, textIndex);

export type DomSelectionSnapshot = {
	/** Index of the `[data-edytor-text]` element holding the anchor/focus, -1 if none. */
	anchorTextIndex: number;
	focusTextIndex: number;
	/** Offset within the whole `[data-edytor-text]` element (text-node offsets summed). */
	anchorOffset: number;
	focusOffset: number;
	isCollapsed: boolean;
	/** Text of the DOM node the focus sits in. */
	focusNodeText: string | null;
};

/** The live DOM selection, mapped to text-element index + element-relative offset. */
export const readDomSelection = (page: Page) =>
	page.evaluate((): DomSelectionSnapshot | null => {
		const selection = window.getSelection();
		if (!selection || selection.rangeCount === 0) return null;
		const texts = Array.from(document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]'));
		const locate = (node: Node | null, offset: number) => {
			if (!node) return { index: -1, offset };
			const host = (
				node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element)
			)?.closest?.('[data-edytor-text="true"]') as HTMLElement | null | undefined;
			const index = host ? texts.indexOf(host) : -1;
			if (!host) return { index, offset };
			if (node.nodeType !== Node.TEXT_NODE) {
				let total = 0;
				for (const child of Array.from(node.childNodes).slice(0, offset)) {
					total += child.textContent?.length ?? 0;
				}
				return { index, offset: total };
			}
			const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
			let total = 0;
			for (let current = walker.nextNode(); current; current = walker.nextNode()) {
				if (current === node) return { index, offset: total + offset };
				total += current.textContent?.length ?? 0;
			}
			return { index, offset };
		};
		const anchor = locate(selection.anchorNode, selection.anchorOffset);
		const focus = locate(selection.focusNode, selection.focusOffset);
		return {
			anchorTextIndex: anchor.index,
			focusTextIndex: focus.index,
			anchorOffset: anchor.offset,
			focusOffset: focus.offset,
			isCollapsed: selection.isCollapsed,
			focusNodeText: selection.focusNode?.textContent ?? null
		};
	});

// ---------------------------------------------------------------------------
// Composing-node identity
// ---------------------------------------------------------------------------

type NodeSnapshotWindow = Window & {
	__cdpNodes?: Record<string, { node: Node; host: Element | null }>;
};

/**
 * Pin the DOM text node the caret sits in (during a live composition: the
 * node the IME writes its preview into) and its `[data-edytor-text]` host,
 * under `key`. With `textIndex`, pin the first text node of that host
 * instead (e.g. before the composition starts).
 */
export const pinComposingNode = (page: Page, key: string, textIndex?: number) =>
	page.evaluate(
		({ key, textIndex }) => {
			const win = window as NodeSnapshotWindow;
			let node: Node | null;
			if (textIndex === undefined) {
				node = window.getSelection()?.focusNode ?? null;
			} else {
				const host = document.querySelectorAll<HTMLElement>('[data-edytor-text="true"]')[textIndex];
				if (!host) throw new Error(`Missing text element at index ${textIndex}`);
				node = document.createTreeWalker(host, NodeFilter.SHOW_TEXT).nextNode() ?? host;
			}
			if (!node) throw new Error('No node to pin (no DOM selection)');
			const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
			win.__cdpNodes = {
				...win.__cdpNodes,
				[key]: { node, host: element?.closest('[data-edytor-text="true"]') ?? null }
			};
			return {
				isText: node.nodeType === Node.TEXT_NODE,
				text: node.textContent
			};
		},
		{ key, textIndex }
	);

export type PinnedNodeState = {
	/** The pinned node is still in the document. */
	connected: boolean;
	/** Its pinned `[data-edytor-text]` host is still in the document and still its ancestor. */
	hostIntact: boolean;
	/** The pinned node is the node the DOM selection's focus sits in now. */
	isFocusNode: boolean;
	/** The pinned node is the text node holding `text` (searched in its host), when given. */
	holdsText: boolean | null;
	text: string | null;
};

/** Where the pinned node stands now; `text` checks it is the node rendering that string. */
export const readPinnedNode = (page: Page, key: string, text?: string) =>
	page.evaluate(
		({ key, text }): PinnedNodeState => {
			const pinned = (window as NodeSnapshotWindow).__cdpNodes?.[key];
			if (!pinned) throw new Error(`No pinned node "${key}"`);
			const { node, host } = pinned;
			return {
				connected: node.isConnected,
				hostIntact: Boolean(host?.isConnected && host.contains(node)),
				isFocusNode: window.getSelection()?.focusNode === node,
				holdsText: text === undefined ? null : (node.textContent ?? '').includes(text),
				text: node.textContent
			};
		},
		{ key, text }
	);

/** Whether two pins name the same DOM node. */
export const samePinnedNode = (page: Page, a: string, b: string) =>
	page.evaluate(
		({ a, b }) => {
			const nodes = (window as NodeSnapshotWindow).__cdpNodes ?? {};
			if (!nodes[a] || !nodes[b]) throw new Error(`Missing pin "${a}" or "${b}"`);
			return nodes[a].node === nodes[b].node;
		},
		{ a, b }
	);

// ---------------------------------------------------------------------------
// Event + selection-write spies (test-side prototype patches)
// ---------------------------------------------------------------------------

type SpyWindow = Window & {
	__cdpSpy?: {
		events: Array<{ type: string; inputType?: string; data?: string | null; trusted: boolean }>;
		selectionWrites: string[];
		armed: boolean;
	};
};

/**
 * Record composition/input events on the editor root and every call that
 * writes the DOM selection (`Selection.prototype` mutators). Arm with
 * `armSpy`, read with `readSpy`. Installed once per page load.
 */
export const installSpy = (page: Page) =>
	page.evaluate(() => {
		const win = window as SpyWindow;
		if (win.__cdpSpy) return;
		const spy = (win.__cdpSpy = { events: [], selectionWrites: [], armed: false });
		for (const type of [
			'compositionstart',
			'compositionupdate',
			'compositionend',
			'beforeinput',
			'input'
		]) {
			document.addEventListener(
				type,
				(event) => {
					if (!spy.armed) return;
					const input = event as InputEvent & CompositionEvent;
					spy.events.push({
						type,
						inputType: 'inputType' in input ? input.inputType : undefined,
						data: input.data,
						trusted: event.isTrusted
					});
				},
				true
			);
		}
		const proto = Selection.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
		for (const name of [
			'addRange',
			'removeAllRanges',
			'removeRange',
			'collapse',
			'collapseToStart',
			'collapseToEnd',
			'setPosition',
			'setBaseAndExtent',
			'extend',
			'selectAllChildren',
			'empty'
		]) {
			const original = proto[name];
			if (typeof original !== 'function') continue;
			proto[name] = function (this: Selection, ...args: unknown[]) {
				if (spy.armed) spy.selectionWrites.push(name);
				return original.apply(this, args);
			};
		}
	});

export const armSpy = (page: Page, armed = true) =>
	page.evaluate((armed) => {
		const spy = (window as SpyWindow).__cdpSpy;
		if (!spy) throw new Error('installSpy first');
		if (armed) {
			spy.events = [];
			spy.selectionWrites = [];
		}
		spy.armed = armed;
	}, armed);

export const readSpy = (page: Page) =>
	page.evaluate(() => {
		const spy = (window as SpyWindow).__cdpSpy;
		if (!spy) throw new Error('installSpy first');
		const count = (type: string, inputType?: string) =>
			spy.events.filter(
				(event) => event.type === type && (inputType === undefined || event.inputType === inputType)
			).length;
		return {
			events: spy.events,
			selectionWrites: [...spy.selectionWrites],
			compositionStarts: count('compositionstart'),
			compositionEnds: count('compositionend'),
			// The IME's own events. `compositionend` is left out: Chromium
			// was observed to deliver it with `isTrusted: false` when it ends
			// a composition itself (bold-mark scenario), so it cannot tell the
			// real IME path from a script.
			allTrusted: spy.events
				.filter((event) => event.type !== 'compositionend')
				.every((event) => event.trusted),
			untrusted: spy.events.filter((event) => !event.trusted).map((event) => event.type)
		};
	});

// ---------------------------------------------------------------------------
// Peer: a second browser context in the same websocket room
// ---------------------------------------------------------------------------

export type ImePeerPair = {
	relay: OpaqueRelay;
	room: string;
	/** The context/page the IME drives. */
	userContext: BrowserContext;
	user: Page;
	/** The second, independent context acting as the collaborator. */
	peerContext: BrowserContext;
	peer: Page;
	close: () => Promise<void>;
};

const roomName = () => `cdp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Two independent browser contexts on `/test/dom?scenario=collab` joined
 * through the opaque websocket relay (`ws-relay.ts`, BroadcastChannel
 * disabled by the route), converged on the deterministic seed
 * `alpha | beta | gamma` (ids `collab-b1..3`).
 */
export const openImePeerPair = async (
	browser: Browser,
	testInfo: TestInfo
): Promise<ImePeerPair> => {
	const relay = await startOpaqueRelay();
	const room = roomName();
	const baseURL = testInfo.project.use.baseURL;
	const userContext = await browser.newContext({ baseURL });
	const peerContext = await browser.newContext({ baseURL });
	const close = async () => {
		await userContext.close();
		await peerContext.close();
		await relay.close();
	};
	try {
		const user = await userContext.newPage();
		const peer = await peerContext.newPage();
		const path = `/test/dom?scenario=collab&collabws=${room}&wsserver=${encodeURIComponent(relay.url)}&wsbackoff=400`;
		await Promise.all([
			gotoEditorRoute(user, path, { requireRuntime: true }),
			gotoEditorRoute(peer, path, { requireRuntime: true })
		]);
		await expectConverged(user, peer);
		return { relay, room, userContext, user, peerContext, peer, close };
	} catch (error) {
		await close();
		throw error;
	}
};

/** Poll until both pages serialize the identical document; returns it. */
export const expectConverged = async (a: Page, b: Page, timeout = 15000) => {
	await expect
		.poll(async () => JSON.stringify(await readValue(a)) === JSON.stringify(await readValue(b)), {
			timeout
		})
		.toBe(true);
	return readValue(a);
};

/** A peer write through its own facade (travels to the user over the socket). */
export const peerInsertText = (peer: Page, blockId: string, offset: number, text: string) =>
	peer.evaluate(
		({ blockId, offset, text }) => {
			const edytor = (window as Window & { __EDYTOR__?: any }).__EDYTOR__;
			if (!edytor?.facade) throw new Error('Missing edytor facade');
			return edytor.facade.insertText(blockId, offset, text);
		},
		{ blockId, offset, text }
	);
