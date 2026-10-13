/**
 * Notion's palette, as the demo's toolbar offers it: each name's text colour
 * and background (`Default` none), the CSS values the toolbar's colour marks
 * store. The block colours (`BLOCK_COLORS`) are the same names, lowercase,
 * painted by the theme's tokens with these as fallbacks.
 */
export const PALETTE = [
	{ name: 'Default', text: null, background: null },
	{ name: 'Gray', text: '#7d7a75', background: '#f0efed' },
	{ name: 'Brown', text: '#9f765a', background: '#f5ede9' },
	{ name: 'Orange', text: '#d27b2d', background: '#fbebde' },
	{ name: 'Yellow', text: '#cb9434', background: '#f9f3dc' },
	{ name: 'Green', text: '#50946e', background: '#e8f1ec' },
	{ name: 'Blue', text: '#387dc9', background: '#e5f2fc' },
	{ name: 'Purple', text: '#9a6bb4', background: '#f3ebf9' },
	{ name: 'Pink', text: '#c14c8a', background: '#fae9f1' },
	{ name: 'Red', text: '#cf5148', background: '#fce9e7' }
] as const;
