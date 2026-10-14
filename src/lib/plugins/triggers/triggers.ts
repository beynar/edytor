/**
 * Input rules and triggers, wired into a plugin's own hooks
 * (`withRulesAndTriggers`): the rules run in its `onBeforeOperation`
 * (after its own hook), each trigger is a `TriggerMenuController` fed by
 * its `onAfterOperation` and `onSelectionChange`, rendered in the overlay,
 * and keyed through its `hotkeys` (before its own bindings of the same
 * keys), as the slash menu is (`withTriggerMenus`). The precedence of both
 * is the plugin's place in the list. A view without such a plugin ships
 * none of it.
 */
import type { Edytor } from '$lib/edytor.svelte.js';
import type {
	ChangePayload,
	InitializedPlugin,
	InputRule,
	TextRuleContext,
	Trigger
} from '$lib/plugins.js';
import type { HotKey, HotKeyCombination } from '$lib/session/keymap.js';
import { inputRulesHook } from '$lib/session/inputRules.js';
import { TriggerMenuController, type TextTriggerController } from './TriggerController.svelte.js';
import { caretRect } from './place.js';
import { placeNear } from '$lib/surface/overlay.js';
import { listHotkeys, type HeldList } from '../list.svelte.js';
import { mountChrome } from '../chrome.js';

type Keys = Partial<Record<HotKeyCombination, HotKey>>;

/** Two bindings of one chord, `first`'s claim ending the key. */
const both =
	(first: HotKey, then: HotKey | undefined): HotKey =>
	(payload) => {
		first(payload);
		then?.(payload);
	};

/** The triggers each view numbered so far: a trigger's popup owner name. */
const counts = new WeakMap<Edytor, number>();

/**
 * Write `atom` where the matched text starts (`ctx.from`: a trigger's pick,
 * an input rule's replacement), the caret after it; whether it was written.
 */
export const placeAtom = (
	{ edytor, block, from, caret }: TextRuleContext,
	atom: Parameters<Edytor['insertInline']>[2]
) => {
	const written = edytor.insertInline(block.id, from, atom).status === 'applied';
	if (written) caret(from + 1);
	return written;
};

/**
 * `plugin` with `inputRules` (text typed at the caret that a rule
 * replaces: markdown, `:smile:` → 😄) and `triggers` (characters that open
 * a menu of rows at the caret: `@` mentions) run through its own hooks.
 * A plugin declares them by returning this:
 * `(edytor) => withRulesAndTriggers(edytor, { inlineBlocks }, { triggers: [mention] })`.
 */
export const withRulesAndTriggers = (
	edytor: Edytor,
	plugin: InitializedPlugin,
	{ inputRules = [], triggers = [] }: { inputRules?: InputRule[]; triggers?: Trigger[] }
): InitializedPlugin => {
	const extended: InitializedPlugin = { ...plugin };

	if (inputRules.length) {
		const own = plugin.onBeforeOperation;
		const run = inputRulesHook(edytor, inputRules);
		// Both run, whatever the plugin's hook answers (a prevent in it throws and
		// ends the hook): the rules read the payload it replaced the command's with.
		extended.onBeforeOperation = <C extends ChangePayload>(change: C) => {
			const out = own?.(change);
			run(out && typeof out === 'object' ? { ...change, payload: out } : change);
			return out;
		};
	}
	// The records read with no view (`plugin(undefined)`) keep no menus.
	if (!triggers.length || !edytor) return extended;

	const controllers = triggers.map((trigger) => {
		const n = counts.get(edytor) ?? 0;
		counts.set(edytor, n + 1);
		return new TriggerMenuController(edytor, trigger, `trigger-${n}`);
	});
	return withTriggerMenus(
		edytor,
		extended,
		controllers,
		(controller) => ({
			move: controller.move,
			// A pending search's Enter waits for its rows: never an older query's row.
			pick:
				controller.items.length || controller.loading
					? () => void controller.pickSelected()
					: undefined,
			close: () => controller.close()
		}),
		// Below the caret (above it when there is no room), kept in the viewport.
		(controller) =>
			mountChrome(
				edytor,
				controller.trigger.menu,
				controller,
				() => controller.isOpen,
				{
					name: 'edytor-trigger-menu-host',
					zIndex: 50,
					measure: (host) => {
						if (!controller.isOpen) return;
						const rect = caretRect(edytor);
						return rect && placeNear(host, rect, [280, 240]);
					}
				},
				() => controller.close()
			)
	);
};

/**
 * `plugin` with trigger menus wired into its hooks (a plugin's `triggers`,
 * the slash menu): each controller fed by its `onAfterOperation` (an
 * `insertText`) and `onSelectionChange`, its menu mounted in the overlay by
 * `mount` once the view is attached, and the open one keyed through its
 * `hotkeys` (`listHotkeys`, before the plugin's own bindings of the same
 * keys) as `held` drives it.
 */
export const withTriggerMenus = <C extends TextTriggerController>(
	edytor: Edytor,
	plugin: InitializedPlugin,
	controllers: C[],
	held: (controller: C) => HeldList,
	mount: (controller: C) => () => void
): InitializedPlugin => {
	const keys = listHotkeys(() => {
		const controller = controllers.find(({ isOpen }) => isOpen);
		return controller && held(controller);
	});
	const hotkeys: Keys = { ...plugin.hotkeys };
	for (const [chord, binding] of Object.entries(keys) as [HotKeyCombination, HotKey][])
		hotkeys[chord] = both(binding, plugin.hotkeys?.[chord]);
	return {
		...plugin,
		hotkeys,
		onAfterOperation: (change) => {
			plugin.onAfterOperation?.(change);
			if (change.operation !== 'insertText' || !change.text) return;
			const [, offset, value] = change.payload;
			const { text } = change;
			for (const controller of controllers)
				controller.handleTextInsertion(text, change.block, offset - text.segStart, value);
			edytor.overlay.invalidate();
		},
		onSelectionChange: (selection) => {
			plugin.onSelectionChange?.(selection);
			for (const controller of controllers) controller.reconcileSelection();
			edytor.overlay.invalidate();
		},
		onEdytorAttached: (payload) => {
			const own = plugin.onEdytorAttached?.(payload);
			const unmount = controllers.map(mount);
			return () => {
				own?.();
				for (const off of unmount) off();
			};
		}
	};
};
