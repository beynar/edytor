const NATIVE_INTERACTIVE_SELECTOR = 'input, textarea, select, button, a[href]';
const NATIVE_ACTIVE_ELEMENT_SELECTOR = 'input, textarea, select, button';
const NATIVE_TEXT_SELECTOR = 'input, textarea';

const getElementFromTarget = (target: EventTarget | null) => {
	if (typeof Element === 'undefined' || typeof Node === 'undefined' || !(target instanceof Node)) {
		return null;
	}

	return target instanceof Element ? target : target.parentElement;
};

const findClosestElement = (target: EventTarget | null, selector: string) => {
	const element = getElementFromTarget(target);
	return element?.closest(selector) ?? null;
};

/**
 * A control on the event's path, else the focused one (a link takes no
 * focus there) when it holds the target or the target holds it.
 */
const findNativeControlInEvent = (event: Event, selector: string) => {
	for (const target of event.composedPath()) {
		const control = findClosestElement(target, selector);
		if (control) return control;
	}
	const target = getElementFromTarget(event.target);
	const active = (target?.ownerDocument ?? globalThis.document)?.activeElement;
	return active &&
		(!target || active === target || active.contains(target) || target.contains(active))
		? findClosestElement(
				active,
				selector === NATIVE_INTERACTIVE_SELECTOR ? NATIVE_ACTIVE_ELEMENT_SELECTOR : selector
			)
		: null;
};

export const isNativeInteractiveControl = (target: EventTarget | null) =>
	Boolean(findClosestElement(target, NATIVE_INTERACTIVE_SELECTOR));

export const isNativeInteractiveEvent = (event: Event) =>
	Boolean(findNativeControlInEvent(event, NATIVE_INTERACTIVE_SELECTOR));

export const isNativeTextControl = (target: EventTarget | null) =>
	Boolean(findClosestElement(target, NATIVE_TEXT_SELECTOR));

export const isNativeTextControlEvent = (event: Event) =>
	Boolean(findNativeControlInEvent(event, NATIVE_TEXT_SELECTOR));

// Any non-"false" contenteditable value — attribute selectors are
// case-sensitive, and "TRUE"/"Plaintext-Only"/"inherit"/garbage values
// all still establish a nested editable context the guard must catch.
const EDITABLE_TARGET_SELECTOR = '[contenteditable]:not([contenteditable="false" i])';

/**
 * A kind's own control: a form control (`input` of any type, `textarea`,
 * `select`, `button`) or a nested editable island inside the host (a plugin
 * chrome editor, an embedded code field: it owns its input and composition
 * lifecycle), never the root nor the editor's own text elements (they carry
 * their own `contentEditable="true"`). It owns its focus, selection and
 * events; the projector never writes the editor's caret over it, and the
 * editor never snapshots it nor commits its composition text.
 */
export const isKindControl = (
	editorRoot: Element | null | undefined,
	target: EventTarget | null
) => {
	const editable = findClosestElement(target, EDITABLE_TARGET_SELECTOR);
	const control =
		findClosestElement(target, NATIVE_ACTIVE_ELEMENT_SELECTOR) ??
		(editable?.hasAttribute('data-edytor-text') ? null : editable);
	return Boolean(control && editorRoot && control !== editorRoot && editorRoot.contains(control));
};

/**
 * The one rule for a kind's markup: an event with a kind's own
 * control on its composed path is the control's. Its keys, `beforeinput`,
 * paste, copy, cut, drops and selection gestures pass the editor untouched,
 * whatever the control's type and whatever the editor's selection (a block or
 * atom selection included: Backspace there never deletes the selected
 * blocks). `onKeyDown`, `onBeforeInput`, `onPaste`, `copySelection` and
 * `onDrop` all ask this.
 */
export const ownsEvent = (editorRoot: Element | null | undefined, event: Event) =>
	event.composedPath().some((target) => isKindControl(editorRoot, target));

/**
 * An event of a native control anywhere (a link, the chrome's buttons beside
 * the host) or of a kind's own: never the view's own composition or input.
 */
export const isControlEvent = (editorRoot: Element | null | undefined, event: Event) =>
	isNativeInteractiveEvent(event) || ownsEvent(editorRoot, event);

/** A DOM point of the view's own: inside the host and in no kind's own control. */
export const isOwnPoint = (editorRoot: Element | null | undefined, node: Node | null | undefined) =>
	Boolean(node && editorRoot?.contains(node) && !isKindControl(editorRoot, node));
