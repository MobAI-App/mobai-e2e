/**
 * `expect(device).toChangeScreen(action)`: whether the screen after an
 * action differs from the one before it. Elements are compared by what they
 * are and show (type, text, value, state), not where they sit, so a layout
 * that settles a pixel does not pass for a change and a tap that only flips
 * a switch does.
 */

import type { HostElement } from './client.ts';

/** Every element of a tree as one comparable line, counted, so a duplicated row is a change too. */
export function screenSignature(root: HostElement): Map<string, number> {
  const lines = new Map<string, number>();
  const walk = (element: HostElement): void => {
    const line = [
      element.type ?? '',
      element.text ?? '',
      element.value ?? '',
      element.contentDesc ?? '',
      element.accessibilityId ?? '',
      element.checked === true ? 'checked' : '',
      element.selected === true ? 'selected' : '',
      element.focused === true ? 'focused' : '',
      element.enabled === false ? 'disabled' : '',
    ].join('|');
    lines.set(line, (lines.get(line) ?? 0) + 1);
    for (const child of element.children ?? []) walk(child);
  };
  walk(root);
  return lines;
}

/** How many elements differ between two signatures: gone, new, or a different count. */
export function changedElements(before: ReadonlyMap<string, number>, after: ReadonlyMap<string, number>): number {
  let changed = 0;
  for (const [line, count] of after) changed += Math.abs(count - (before.get(line) ?? 0));
  for (const [line, count] of before) if (!after.has(line)) changed += count;
  return changed;
}
