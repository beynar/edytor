/**
 * The chrome's shared shadcn classes: a list row (shadcn's Command item:
 * the keyboard's row is `data-selected="true"`, which the controller sets)
 * and a floating surface (shadcn's Popover content). The controllers own
 * each popup's focus, keys, ARIA and position; these are only its look.
 */
export const row =
	'h-7 w-full justify-start gap-2 rounded-md px-2 text-left text-sm font-normal whitespace-nowrap hover:bg-transparent data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground dark:hover:bg-transparent';

export const surface =
	'bg-popover text-popover-foreground ring-foreground/10 rounded-lg shadow-md ring-1';

/** Inline styles from a record (a `style:` directive's values on a component): unset ones dropped. */
export const css = (styles: Record<string, string | number | null | undefined>) =>
	Object.entries(styles)
		.filter(([, value]) => value !== undefined && value !== null && value !== '')
		.map(([name, value]) => `${name}: ${value}`)
		.join('; ') || undefined;
