/** `device.collectList`: which list to scroll, and the rows it read. */

import type { CollectedElement, HostElement, Rect } from './client.ts';

/** Screen chrome the host meets inside a full-screen list's bounds; never a row. */
const CHROME_TYPES = new Set([
  'XCUIElementTypeApplication',
  'XCUIElementTypeWindow',
  'XCUIElementTypeNavigationBar',
  'XCUIElementTypeToolbar',
  'XCUIElementTypeTabBar',
  'XCUIElementTypeStatusBar',
]);

/** iOS reads the scroll indicator as text ("Vertical scroll bar, 2 pages"). */
const SCROLL_BAR = /^(vertical|horizontal) scroll bar\b/i;

function scrollables(root: HostElement): HostElement[] {
  const found: HostElement[] = [];
  const walk = (element: HostElement): void => {
    if (element.scrollable === true && element.index !== undefined && element.bounds !== undefined) found.push(element);
    for (const child of element.children ?? []) walk(child);
  };
  walk(root);
  return found;
}

function area(rect: Rect): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

/** How much two rects overlap, as a share of both together (0 to 1). */
function overlap(a: Rect, b: Rect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (width <= 0 || height <= 0) return 0;
  const shared = width * height;
  return shared / (area(a) + area(b) - shared);
}

/**
 * The scrollable element to collect: the one that best covers `box` (a
 * locator's bounding box), else the largest on screen.
 */
export function findList(root: HostElement, box?: Rect): HostElement | undefined {
  const lists = scrollables(root);
  let best: HostElement | undefined;
  let score = 0;
  for (const list of lists) {
    const value = box === undefined ? area(list.bounds as Rect) : overlap(list.bounds as Rect, box);
    if (value > score) {
      best = list;
      score = value;
    }
  }
  return best;
}

/** The texts of a list's rows, in the order the scroll met them, each once. */
export function listTexts(elements: readonly CollectedElement[]): string[] {
  const seen = new Set<string>();
  const texts: string[] = [];
  for (const element of elements) {
    if (CHROME_TYPES.has(element.type)) continue;
    const text = element.text.trim();
    if (text === '' || SCROLL_BAR.test(text) || seen.has(text)) continue;
    seen.add(text);
    texts.push(text);
  }
  return texts;
}
