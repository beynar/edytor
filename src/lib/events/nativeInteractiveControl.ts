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

const getEventPath = (event: Event) => {
	if (typeof event.composedPath === 'function') {
		return event.composedPath();
	}

	return event.target ? [event.target] : [];
};

const getActiveElement = (event: Event) => {
	const target = getElementFromTarget(event.target);
	if (target?.ownerDocument.activeElement) {
		return target.ownerDocument.activeElement;
	}

	return typeof document === 'undefined' ? null : document.activeElement;
};

const findNativeControlInEvent = (event: Event, selector: string) => {
	for (const target of getEventPath(event)) {
		const control = findClosestElement(target, selector);
		if (control) {
			return control;
		}
	}

	const activeElementSelector =
		selector === NATIVE_INTERACTIVE_SELECTOR ? NATIVE_ACTIVE_ELEMENT_SELECTOR : selector;
	const targetControl = findClosestElement(event.target, selector);
	if (targetControl) {
		return targetControl;
	}

	const targetElement = getElementFromTarget(event.target);
	const activeElement = getActiveElement(event);
	const isActiveElementRelatedToTarget =
		typeof Element !== 'undefined' &&
		activeElement instanceof Element &&
		(!targetElement ||
			activeElement === targetElement ||
			activeElement.contains(targetElement) ||
			targetElement.contains(activeElement));
	return isActiveElementRelatedToTarget
		? findClosestElement(activeElement, activeElementSelector)
		: null;
};

export const isNativeInteractiveControl = (target: EventTarget | null) =>
	Boolean(findClosestElement(target, NATIVE_INTERACTIVE_SELECTOR));

export const isNativeFormControl = (target: EventTarget | null) =>
	Boolean(findClosestElement(target, NATIVE_ACTIVE_ELEMENT_SELECTOR));

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
 * The event target sits inside a nested `contenteditable` island that is
 * neither the editor root nor a managed text element (text elements
 * carry their own `contentEditable="true"`). Such islands — a plugin
 * chrome editor, an embedded code field — own their input/composition
 * lifecycle; the outer editor must not snapshot them against the model
 * selection or commit their composition text.
 */
export const isNestedForeignEditableTarget = (
	editorRoot: Element | null | undefined,
	target: EventTarget | null
) => {
	const editable = findClosestElement(target, EDITABLE_TARGET_SELECTOR);
	if (!editable || editable === editorRoot) {
		return false;
	}
	return !editable.hasAttribute('data-edytor-text');
};

/**
 * Event-level variant — walks `composedPath()` so shadow-DOM
 * retargeting can't hide the real origin. Listeners bound on
 * `node.ownerDocument` (outside the editor's shadow root) see
 * `event.target` retargeted to the host; the island element itself
 * still appears earlier in the composed path.
 */
export const isNestedForeignEditableEvent = (
	editorRoot: Element | null | undefined,
	event: Event
) => {
	for (const target of getEventPath(event)) {
		if (isNestedForeignEditableTarget(editorRoot, target)) {
			return true;
		}
	}
	return false;
};
