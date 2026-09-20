<script lang="ts">
	import { untrack } from 'svelte';
	import Edytor, { type EdytorContext } from '$lib/components/Edytor.svelte';
	import { arrowMovePlugin } from '$lib/plugins/arrowMove/arrowMove.js';
	import { blockHandlesPlugin } from '$lib/plugins/blockHandles/blockHandlesPlugin.js';
	import { codePlugin } from '$lib/plugins/code/CodePlugin.svelte';
	import { htmlPlugin } from '$lib/plugins/html/htmlPlugin.js';
	import { imagePlugin } from '$lib/plugins/image/ImagePlugin.svelte';
	import { markdownShortcutsPlugin } from '$lib/plugins/markdownShortcuts.js';
	import { mentionPlugin } from '$lib/plugins/mention/MentionPlugin.svelte';
	import { richTextPlugin } from '$lib/plugins/richtext/RichTextPlugin.svelte';
	import { slashMenuPlugin } from '$lib/plugins/slashMenu/slashMenuPlugin.js';
	import { toolbarPlugin } from '$lib/plugins/toolbar/toolbarPlugin.js';
	import {
		IndexeddbPersistence,
		clearDocument,
		storeState,
		type EdytorSync
	} from '$lib/collaboration/index.js';
	import type { JSONDoc } from '$lib/utils/json.js';
	import type { Text } from '$lib/text/text.svelte.js';
	import type { InlineBlock } from '$lib/block/inlineBlock.svelte.js';
	import type { HotKey } from '$lib/hotkeys.js';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const scenarios: Record<string, JSONDoc> = {
		basic: {
			children: [
				{
					type: 'paragraph'
				},
				{
					type: 'paragraph',
					content: [{ text: 'note' }]
				},
				{
					type: 'paragraph',
					content: [{ text: 'tail' }]
				}
			]
		},
		compositionRepeat: {
			children: [
				{
					type: 'paragraph',
					content: [{ text: 'に' }]
				}
			]
		},
		callout: {
			children: [
				{
					type: 'callout',
					content: [{ text: 'task' }],
					data: { icon: '!' }
				},
				{
					type: 'paragraph',
					content: [{ text: 'after callout' }]
				}
			]
		},
		nested: {
			children: [
				{
					type: 'paragraph',
					content: [{ text: 'Hello' }],
					children: [
						{
							type: 'paragraph',
							content: [{ text: 'Nested child' }]
						},
						{
							type: 'paragraph',
							content: [{ text: 'Nested tail' }]
						}
					]
				},
				{
					type: 'paragraph',
					content: [{ text: 'After' }]
				}
			]
		},
		nestedInline: {
			children: [
				{
					type: 'paragraph',
					content: [
						{ text: 'hello', marks: { bold: true } },
						{ type: 'mention' },
						{ text: 'World', marks: { bold: true } },
						{ type: 'mention' },
						{ text: 'Prout', marks: { bold: true } }
					],
					children: [
						{
							type: 'paragraph',
							content: [{ text: 'One', marks: { bold: true } }]
						}
					]
				},
				{
					type: 'paragraph',
					content: [{ text: 'After' }]
				}
			]
		},
		navigation: {
			children: [
				{
					type: 'paragraph',
					content: [{ text: 'Start' }]
				},
				{
					type: 'paragraph',
					content: [{ text: 'Parent' }],
					children: [
						{
							type: 'paragraph',
							content: [{ text: 'Nested middle' }]
						}
					]
				},
				{
					type: 'image',
					content: [{ text: 'image caption' }]
				},
				{
					type: 'paragraph',
					content: [{ text: 'Finish' }]
				}
			]
		},
		marks: {
			children: [
				{
					type: 'paragraph',
					content: [{ text: 'Alpha', marks: { bold: true } }, { text: ' beta' }]
				},
				{
					type: 'paragraph',
					content: [
						{ text: 'Gamma', marks: { italic: true } },
						{ text: ' delta', marks: { underline: true } }
					]
				}
			]
		},
		links: {
			children: [
				{
					type: 'paragraph',
					content: [
						{
							text: 'Link',
							marks: { link: { href: 'https://example.com', target: '_blank' } }
						},
						{ text: ' tail' }
					]
				}
			]
		},
		inline: {
			children: [
				{
					type: 'paragraph',
					content: [{ text: '' }, { type: 'mention', data: {} }, { text: 'tail' }]
				},
				{
					type: 'paragraph',
					content: [{ text: 'lead ' }, { type: 'mention', data: {} }, { text: ' end' }]
				}
			]
		},
		rtlInline: {
			children: [
				{
					type: 'paragraph',
					content: [{ text: 'שלום ' }, { type: 'mention', data: {} }, { text: ' סוף' }]
				}
			]
		},
		code: {
			children: [
				{
					type: 'code',
					content: [{ text: 'caption' }],
					children: [
						{
							type: 'codeLine',
							content: [{ text: 'const a = 1;' }]
						},
						{
							type: 'codeLine',
							content: [{ text: 'return a;' }]
						}
					]
				},
				{
					type: 'paragraph',
					content: [{ text: 'after code' }]
				}
			]
		},
		void: {
			children: [
				{
					type: 'image',
					content: [{ text: 'caption' }]
				},
				{
					type: 'paragraph',
					content: [{ text: 'after image' }]
				}
			]
		},
		divider: {
			children: [
				{
					type: 'paragraph',
					content: [{ text: 'before divider' }]
				},
				{
					type: 'divider'
				},
				{
					type: 'paragraph',
					content: [{ text: 'after divider' }]
				}
			]
		},
		lists: {
			children: [
				{
					type: 'ordered-list',
					children: [
						{
							type: 'list-item',
							content: [{ text: 'First' }]
						},
						{
							type: 'list-item',
							content: [{ text: 'Second' }],
							children: [
								{
									type: 'paragraph',
									content: [{ text: 'Nested item child' }]
								}
							]
						}
					]
				},
				{
					type: 'unordered-list',
					children: [
						{
							type: 'list-item',
							content: [{ text: 'Bullet' }]
						}
					]
				}
			]
		},
		selection: {
			children: [
				{
					type: 'paragraph',
					content: [{ text: 'First block' }]
				},
				{
					type: 'paragraph',
					content: [
						{ text: 'Marked ', marks: { bold: true } },
						{ text: 'middle', marks: { italic: true } }
					]
				},
				{
					type: 'paragraph',
					content: [{ text: 'lead ' }, { type: 'mention', data: {} }, { text: ' tail' }]
				}
			]
		},
		wordNavigation: {
			children: [
				{
					type: 'paragraph',
					content: [
						{ text: 'alpha ' },
						{ text: 'bold', marks: { bold: true } },
						{ text: ' ' },
						{ type: 'mention', data: {} },
						{ text: ' rocket 🚀 tail' }
					]
				}
			]
		},
		unicode: {
			children: [
				{
					type: 'paragraph',
					content: [{ text: 'A 🚀 e\u0301 Z' }]
				}
			]
		},
		// Deterministic block ids: two clients mounting this scenario seed the
		// identical spec set, so concurrent `init`s LWW-dedupe to one block per
		// id instead of duplicating content.
		collab: {
			children: [
				{
					type: 'paragraph',
					id: 'collab-b1',
					content: [{ text: 'alpha' }]
				},
				{
					type: 'paragraph',
					id: 'collab-b2',
					content: [{ text: 'beta' }]
				},
				{
					type: 'paragraph',
					id: 'collab-b3',
					content: [{ text: 'gamma' }]
				}
			]
		}
	};

	const plugins = $derived([
		arrowMovePlugin,
		...(data.handles ? [blockHandlesPlugin] : []),
		imagePlugin,
		codePlugin,
		htmlPlugin({}),
		markdownShortcutsPlugin,
		mentionPlugin,
		slashMenuPlugin,
		toolbarPlugin,
		richTextPlugin
	]);
	const collaborationTestRuntime = {
		IndexeddbPersistence,
		clearDocument,
		storeState
	};

	/**
	 * `?collab=<room>` mounts the editor on the real provider stack:
	 * `IndexeddbPersistence` gives IndexedDB persistence AND BroadcastChannel
	 * cross-context sync (channel = db name) — no external relay. The provider
	 * is exposed on `window.__EDYTOR_COLLAB__` so specs can partition the room
	 * (`disconnectBc`/`connectBc`) or force a state flush (`storeState`).
	 */
	// `data` is a static load() payload for this navigation, so the initial
	// `data.collab` read is intentionally untracked.
	const collabSync: EdytorSync | undefined = untrack(() => data.collab)
		? ({ doc, awareness, synced }) => {
				const room = data.collab!;
				const provider = new IndexeddbPersistence(`edytor-collab-${room}`, doc, {
					awareness
				});
				(
					window as Window & {
						__EDYTOR_COLLAB__?: { provider: InstanceType<typeof IndexeddbPersistence> };
						__EDYTOR_SYNC_ERROR__?: unknown;
					}
				).__EDYTOR_COLLAB__ = { provider };
				let fired = false;
				provider.on('synced', () => {
					if (fired) {
						return;
					}
					fired = true;
					try {
						synced(provider);
					} catch (error) {
						// Schema-gate refusal surfaces here instead of an async
						// unhandled rejection, so specs can assert it deterministically.
						(window as Window & { __EDYTOR_SYNC_ERROR__?: unknown }).__EDYTOR_SYNC_ERROR__ = error;
					}
				});
				return () => {
					void provider.destroy();
				};
			}
		: undefined;

	let edytor = $state<EdytorContext>();
	let secondaryEdytor = $state<EdytorContext>();

	const getScenarioValue = (scenario: string, emptyPosition: string | null) => {
		const value = structuredClone(scenarios[scenario] ?? scenarios.basic);

		if (scenario === 'basic') {
			const paragraphs = value.children;
			const nonEmptyValues = ['lead', 'note', 'tail'];
			const emptyIndex = emptyPosition === 'middle' ? 1 : emptyPosition === 'last' ? 2 : 0;

			paragraphs.forEach((paragraph, index) => {
				if (emptyIndex === index) {
					delete paragraph.content;
					return;
				}

				paragraph.content = [{ text: nonEmptyValues[index] }];
			});
		}

		return value;
	};

	const getPartPath = (part: Text | InlineBlock) => {
		const index = part.parent.content.findIndex((candidate) => candidate.id === part.id);
		return [...part.parent.path, index === -1 ? part.index : index];
	};

	const getSelectionSnapshot = (instance: EdytorContext | undefined) => {
		if (!instance) {
			return {
				startBlockPath: null,
				endBlockPath: null,
				startTextPath: null,
				endTextPath: null,
				yStart: 0,
				yEnd: 0,
				isCollapsed: true,
				selectedBlockPaths: [],
				focusedBlockPaths: []
			};
		}

		return {
			startBlockPath: instance.selection.state.startBlock?.path ?? null,
			endBlockPath: instance.selection.state.endBlock?.path ?? null,
			startTextPath: instance.selection.state.startText
				? getPartPath(instance.selection.state.startText)
				: null,
			endTextPath: instance.selection.state.endText
				? getPartPath(instance.selection.state.endText)
				: null,
			yStart: instance.selection.state.yStart,
			yEnd: instance.selection.state.yEnd,
			isCollapsed: instance.selection.state.isCollapsed,
			selectedBlockPaths: Array.from(instance.selection.selectedBlocks).map((block) => block.path),
			focusedBlockPaths: Array.from(instance.selection.focusedBlocks).map((block) => block.path)
		};
	};

	const scenario = $derived(data.scenario);
	const value = $derived(getScenarioValue(data.scenario, data.empty));
	const secondaryValue = $derived({
		children: [
			{
				type: 'paragraph',
				content: [{ text: 'other' }]
			}
		]
	} satisfies JSONDoc);
	const placeholder = $derived(data.placeholder ?? 'Write something here ...');
	let runtimeReadonly = $state(false);
	let runtimeReadonlySource = $state<string | null>(null);
	const readonly = $derived(data.dynamicReadonly ? runtimeReadonly : Boolean(data.readonly));
	$effect(() => {
		const source = `${data.dynamicReadonly}:${data.readonly}`;
		if (runtimeReadonlySource === source) {
			return;
		}

		runtimeReadonlySource = source;
		runtimeReadonly = Boolean(data.readonly);
	});
	const direction: 'ltr' | 'rtl' = $derived(data.dir === 'rtl' ? 'rtl' : 'ltr');
	const hotKeys = $derived.by(() => {
		const routeHotKeys: Record<string, HotKey> = {};

		const insertProbeText = (edytor: EdytorContext, value: string) => {
			const text = edytor.selection.state.startText;
			const offset = edytor.selection.state.yStart;
			if (!text) {
				return;
			}

			text.insertText({ value, start: offset, end: offset });
			void edytor.selection.setAtTextOffset(text, offset + value.length);
		};

		if (data.enterHotkey) {
			routeHotKeys.enter = ({ edytor, prevent }) => {
				prevent(() => insertProbeText(edytor, '!'));
			};
		}

		if (data.backspaceHotkey) {
			routeHotKeys.backspace = ({ edytor, prevent }) => {
				prevent(() => insertProbeText(edytor, '?'));
			};
		}

		if (data.altGraphHotkey) {
			routeHotKeys['mod+alt+b'] = ({ edytor, prevent }) => {
				prevent(() => insertProbeText(edytor, '!'));
			};
		}

		if (data.deadKeyHotkey) {
			routeHotKeys['mod+alt+dead'] = ({ edytor, prevent }) => {
				prevent(() => insertProbeText(edytor, '!'));
			};
		}

		return Object.keys(routeHotKeys).length ? routeHotKeys : undefined;
	});
	const translate: 'yes' | 'no' = $derived(data.translate === 'yes' ? 'yes' : 'no');
	const spellcheck = $derived(data.spellcheck);
	const autocorrect: 'on' | 'off' | undefined = $derived(
		data.autocorrect === 'on' || data.autocorrect === 'off' ? data.autocorrect : undefined
	);
	const autocomplete: 'on' | 'off' | undefined = $derived(
		data.autocomplete === 'on' || data.autocomplete === 'off' ? data.autocomplete : undefined
	);
	const autocapitalize = $derived.by(() => {
		const value = data.autocapitalize;
		if (
			value === 'off' ||
			value === 'none' ||
			value === 'on' ||
			value === 'sentences' ||
			value === 'words' ||
			value === 'characters'
		) {
			return value;
		}
		return undefined;
	});
	const serializedValue = $derived(JSON.stringify(edytor?.value ?? { type: 'root', children: [] }));
	const serializedSelection = $derived(JSON.stringify(getSelectionSnapshot(edytor)));
	const serializedSecondaryValue = $derived(
		JSON.stringify(secondaryEdytor?.value ?? { type: 'root', children: [] })
	);
	const serializedSecondarySelection = $derived(
		JSON.stringify(getSelectionSnapshot(secondaryEdytor))
	);

	$effect(() => {
		if (typeof window !== 'undefined') {
			(
				window as Window & {
					__EDYTOR__?: EdytorContext;
					__SECOND_EDYTOR__?: EdytorContext;
					__EDYTOR_COLLABORATION_TEST__?: typeof collaborationTestRuntime;
				}
			).__EDYTOR__ = edytor;
			(
				window as Window & {
					__EDYTOR_COLLABORATION_TEST__?: typeof collaborationTestRuntime;
				}
			).__EDYTOR_COLLABORATION_TEST__ = collaborationTestRuntime;
			if (data.secondary) {
				(
					window as Window & {
						__SECOND_EDYTOR__?: EdytorContext;
					}
				).__SECOND_EDYTOR__ = secondaryEdytor;
			}
		}
	});
</script>

<div class="grid gap-4 p-6">
	<div data-testid="scenario">{scenario}</div>
	{#if data.dynamicReadonly}
		<button
			type="button"
			data-testid="toggle-readonly"
			aria-pressed={readonly}
			onclick={() => {
				runtimeReadonly = !runtimeReadonly;
			}}
		>
			{readonly ? 'Set editable' : 'Set readonly'}
		</button>
	{/if}
	<div data-testid="editor-shell" dir={direction}>
		<Edytor
			bind:edytor
			{plugins}
			{value}
			{readonly}
			{translate}
			{spellcheck}
			{autocorrect}
			{autocomplete}
			{autocapitalize}
			{hotKeys}
			sync={collabSync}
			class="outline-none"
			{placeholder}
		/>
	</div>
	{#if data.secondary}
		<div data-testid="secondary-editor-shell" dir={direction}>
			<Edytor
				bind:edytor={secondaryEdytor}
				{plugins}
				value={secondaryValue}
				{translate}
				{spellcheck}
				{autocorrect}
				{autocomplete}
				{autocapitalize}
				class="outline-none"
				placeholder="Second editor"
			/>
		</div>
		<pre data-testid="secondary-value">{serializedSecondaryValue}</pre>
		<pre data-testid="secondary-selection">{serializedSecondarySelection}</pre>
	{/if}
	<pre data-testid="value">{serializedValue}</pre>
	<pre data-testid="selection">{serializedSelection}</pre>
</div>
