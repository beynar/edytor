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
