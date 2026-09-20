import type { Text } from './text.svelte.js';

const ZERO_WIDTH_SPACE = '\u200B';
const PLACEHOLDER_SELECTOR = '[data-edytor-text-placeholder]';
const TEXT_SELECTOR = '[data-edytor-text="true"]';

const hasVisibleDomText = (text: Text) =>
	Boolean(text.node?.textContent?.replaceAll(ZERO_WIDTH_SPACE, '').length);

const hasVisibleTextElementContent = (element: Element) =>
	Boolean(element.textContent?.replaceAll(ZERO_WIDTH_SPACE, '').length);

export const removeStalePlaceholdersIn = (root: ParentNode | null | undefined) => {
	if (!root) {
		return;
	}

	const placeholdersByParent = new Map<HTMLElement, HTMLElement[]>();
	const placeholders = Array.from(root.querySelectorAll<HTMLElement>(PLACEHOLDER_SELECTOR));

	for (const placeholder of placeholders) {
		const parent = placeholder.parentElement;
		if (!parent) {
			continue;
		}

		const parentPlaceholders = placeholdersByParent.get(parent);
		if (parentPlaceholders) {
			parentPlaceholders.push(placeholder);
		} else {
			placeholdersByParent.set(parent, [placeholder]);
		}
	}

	for (const [parent, parentPlaceholders] of placeholdersByParent) {
		const hasText = Array.from(parent.querySelectorAll<HTMLElement>(TEXT_SELECTOR)).some(
			hasVisibleTextElementContent
		);

		if (hasText) {
			parentPlaceholders.forEach((placeholder) => {
				placeholder.remove();
			});
			continue;
		}

		parentPlaceholders.slice(0, -1).forEach((placeholder) => {
			placeholder.remove();
		});
	}
};

export const removeStalePlaceholders = (text: Text) => {
	const textParent = text.node?.parentElement;

	if (!textParent) {
		return;
	}

	if (text.stringContent.length === 0 && !hasVisibleDomText(text)) {
		removeStalePlaceholdersIn(textParent);
		return;
	}

	textParent.querySelectorAll(PLACEHOLDER_SELECTOR).forEach((placeholder) => {
		placeholder.remove();
	});
};

const schedulePlaceholderRemoval = (remove: () => void) => {
	remove();
	queueMicrotask(remove);

	if (typeof requestAnimationFrame === 'function') {
		requestAnimationFrame(() => {
			remove();
			setTimeout(remove);
		});
	}

	setTimeout(remove, 50);
	setTimeout(remove, 250);
	setTimeout(remove, 1000);
};

export const scheduleRemoveStalePlaceholders = (text: Text) => {
	schedulePlaceholderRemoval(() => removeStalePlaceholders(text));
};

export const scheduleRemoveStalePlaceholdersIn = (root: ParentNode | null | undefined) => {
	schedulePlaceholderRemoval(() => removeStalePlaceholdersIn(root));
};
