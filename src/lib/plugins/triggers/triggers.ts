/**
 * A plugin's `inputRules` and `triggers`, turned into its hooks: the rules
 * run in its `onBeforeOperation` (after its own hook), each trigger is a
 * `TriggerMenuController` fed by its `onAfterOperation` and
 * `onSelectionChange`, rendered in the overlay, and keyed through its
 * `hotkeys` (before its own bindings of the same keys). The precedence of
 * both is the plugin's place in the list.
 */
import type { Edytor } from '$lib/edytor.svelte.js';
import type { ChangePayload, InitializedPlugin } from '$lib/plugins.js';
import type { HotKey, HotKeyCombination } from '$lib/session/keymap.js';
import type { Text } from '$lib/text/text.svelte.js';
import { inputRulesHook } from '$lib/session/inputRules.js';
import { TriggerMenuController, type TextInsertionPayload } from './TriggerController.svelte.js';
import TriggerMenu from './TriggerMenu.svelte';
import { caretRect, placeBelow } from './place.js';

type Keys = Partial<Record<HotKeyCombination, HotKey>>;

/** Two bindings of one chord, `first`'s claim ending the key. */
const both =
	(first: HotKey, then: HotKey | undefined): HotKey =>
	(payload) => {
		first(payload);
		then?.(payload);
	};

/** `plugin` with its input rules and triggers wired into its hooks; `at` is its place in the list. */
export const withRulesAndTriggers = (
	edytor: Edytor,
	plugin: InitializedPlugin,
	at: number
): InitializedPlugin => {
	const rules = plugin.inputRules ?? [];
	const triggers = plugin.triggers ?? [];
	if (!rules.length && !triggers.length) return plugin;
	const extended: InitializedPlugin = { ...plugin };

	if (rules.length) {
		const own = plugin.onBeforeOperation;
		const run = inputRulesHook(edytor, rules);
		// Both run, whatever the plugin's hook answers (a prevent in it throws and
		// ends the hook): the rules read the payload it replaced the command's with.
		extended.onBeforeOperation = <C extends ChangePayload>(change: C) => {
			const out = own?.(change);
			run(out && typeof out === 'object' ? { ...change, payload: out } : change);
			return out;
		};
	}
	if (!triggers.length) return extended;

	const controllers = triggers.map(
		(trigger, index) => new TriggerMenuController(edytor, trigger, `trigger-${at}-${index}`)
	);
	const open = () => controllers.find((controller) => controller.isOpen);
	const keys: Keys = {
		arrowdown: ({ prevent }) => {
			if (open()?.moveSelection(1)) prevent();
		},
		arrowup: ({ prevent }) => {
			if (open()?.moveSelection(-1)) prevent();
		},
		enter: ({ prevent }) => {
			const controller = open();
			// A pending search's Enter waits for its rows: never an older query's row.
			if (controller?.items.length || controller?.loading)
				prevent(() => void controller.pickSelected());
		},
		escape: ({ prevent }) => {
			const controller = open();
			if (controller) prevent(() => controller.close());
		}
	};
	const hotkeys: Keys = { ...plugin.hotkeys };
	for (const [chord, binding] of Object.entries(keys) as [HotKeyCombination, HotKey][])
		hotkeys[chord] = both(binding, plugin.hotkeys?.[chord]);
	extended.hotkeys = hotkeys;

	extended.onAfterOperation = (change) => {
		plugin.onAfterOperation?.(change);
		if (change.operation !== 'insertText' || !('text' in change)) return;
		for (const controller of controllers)
			controller.handleTextInsertion(
				change.text as Text,
				change.block,
				change.payload as TextInsertionPayload
			);
		edytor.overlay.invalidate();
	};
	extended.onSelectionChange = (selection) => {
		plugin.onSelectionChange?.(selection);
		for (const controller of controllers) controller.reconcileSelection();
		edytor.overlay.invalidate();
	};
	extended.onEdytorAttached = (payload) => {
		const own = plugin.onEdytorAttached?.(payload);
		// Below the caret (above it when there is no room), kept in the viewport.
		const unmount = controllers.map((controller) =>
			edytor.overlay.mount(TriggerMenu, { controller }, 'edytor-trigger-menu-host', 50, (host) => {
				if (!controller.isOpen) return;
				const rect = caretRect(edytor);
				return rect && placeBelow(host, rect, { width: 280, height: 240 });
			})
		);
		return () => {
			own?.();
			for (const off of unmount) off();
		};
	};
	return extended;
};
