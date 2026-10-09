/* Pure geometry helpers for floating layers (popovers, menus). No React/DOM
   imports so they are unit-testable in the node vitest environment. */

/** Minimum gap kept between a floating layer and the viewport edge (matches the 16px page gutter). */
export const VIEWPORT_GUTTER = 16;

/**
 * Horizontal correction (px) that keeps a floating box inside the viewport.
 *
 * Given the box's current `left` and `width` (from getBoundingClientRect) it
 * returns how far to move it so it spans `[gutter, viewportWidth - gutter]`.
 * A box wider than the available space is pinned to the left gutter (its
 * consumers cap width with `calc(100vw - 2rem)`). Returns 0 when it fits.
 */
export function horizontalClampShift(
  left: number,
  width: number,
  viewportWidth: number,
  gutter: number = VIEWPORT_GUTTER,
): number {
  const min = gutter;
  const max = viewportWidth - gutter - width;
  if (max < min) return min - left;
  if (left < min) return min - left;
  if (left > max) return max - left;
  return 0;
}
