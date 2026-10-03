/**
 * Below this width a layout stacks its columns (`columns.css`'s container
 * query, D6): no beside band offers a column there and no strip resizes one.
 */
export const STACKS_AT = 480;

/** Whether a layout `width` px wide stacks its columns (`@container (max-width: 480px)`). */
export const stacks = (width: number) => width <= STACKS_AT;
