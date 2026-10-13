/**
 * A starter theme as the CSS variables on the starter's root: each colour a
 * `--notion-*` or `--edytor-starter-*` variable (the dark ones
 * `--edytor-starter-dark-*`, which the stylesheet reads under a dark
 * scheme), each size an `--edytor-starter-*` one.
 */
import type { StarterColors, StarterTheme } from './types.js';

/** Each colour of a theme and the variable it sets. */
export const COLOR_VARIABLES: Record<keyof StarterColors, string> = {
	background: 'background',
	text: 'text',
	textSecondary: 'text-secondary',
	placeholder: 'placeholder',
	border: 'border',
	hover: 'hover',
	panel: 'panel',
	accent: 'accent',
	selection: 'selection',
	blockSelection: 'block-selection'
};

const length = (value: string | number) => (typeof value === 'number' ? `${value}px` : value);

/** The CSS variables of `theme`, by name. */
export const themeVariables = (theme: StarterTheme = {}): Record<string, string> => {
	const variables: Record<string, string> = {};
	for (const [scheme, colors] of [
		['light', theme.colors?.light],
		['dark', theme.colors?.dark]
	] as const)
		for (const [key, value] of Object.entries(colors ?? {}))
			if (value)
				variables[`--edytor-starter-${scheme}-${COLOR_VARIABLES[key as keyof StarterColors]}`] =
					value;
	const { fonts, radius, spacing, maxWidth, coverHeight } = theme;
	if (fonts?.body) variables['--notion-font'] = fonts.body;
	if (fonts?.mono) variables['--notion-mono'] = fonts.mono;
	if (fonts?.title) variables['--edytor-starter-title-font'] = fonts.title;
	if (radius !== undefined) variables['--edytor-starter-radius'] = length(radius);
	if (spacing !== undefined) variables['--edytor-starter-gutter'] = length(spacing);
	if (maxWidth !== undefined) variables['--edytor-starter-max-width'] = length(maxWidth);
	if (coverHeight !== undefined) variables['--edytor-starter-cover-height'] = length(coverHeight);
	Object.assign(variables, theme.variables);
	return variables;
};

/** `themeVariables` as an inline `style` value. */
export const themeStyle = (theme?: StarterTheme): string =>
	Object.entries(themeVariables(theme))
		.map(([name, value]) => `${name}: ${value}`)
		.join('; ');
