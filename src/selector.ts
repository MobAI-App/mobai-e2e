/**
 * The platform selector `device.locator(selector)` and `LocatorExpression`'s
 * `selector` kind take: space-separated `key=value` terms, every one of
 * which must match. Values with spaces or quotes are JSON-quoted.
 *
 *   id=login_button          the accessibility identifier or resource id
 *   text="Sign in"           the visible text or name, exactly
 *   text~=Sign               the visible text or name, as a substring
 *   role=button              the contract role
 *   type=XCUIElementTypeCell the platform element type, as the host reports it
 *   value=1                  the node's value
 */

import { EngineError, type SemanticNode } from 'e2e/engine';
import { kindOf, type ProjectedNode } from './nodes.ts';

type Term = { readonly key: string; readonly op: '=' | '~='; readonly value: string };

export function parseSelector(selector: string): Term[] {
  const terms: Term[] = [];
  const pattern = /([A-Za-z][A-Za-z0-9_-]*)(~?=)("(?:[^"\\]|\\.)*"|\S+)/gy;
  let position = 0;
  const trimmed = selector.trim();
  while (position < trimmed.length) {
    pattern.lastIndex = position;
    const match = pattern.exec(trimmed);
    if (match === null) {
      throw new EngineError('ENGINE_FAILURE', `selector "${selector}" is not key=value terms (id=, text=, text~=, role=, type=, value=)`, { retryable: false });
    }
    const [whole, key, op, rawValue] = match;
    const value = rawValue!.startsWith('"') ? (JSON.parse(rawValue!) as string) : rawValue!;
    terms.push({ key: key!, op: op as Term['op'], value });
    position += whole.length;
    while (position < trimmed.length && /\s/.test(trimmed.charAt(position))) position += 1;
  }
  if (terms.length === 0) {
    throw new EngineError('ENGINE_FAILURE', 'selector is empty', { retryable: false });
  }
  return terms;
}

/** Resolves a selector to the projected nodes it matches, in document order. */
export function matchSelector(selector: string, index: readonly ProjectedNode[]): ProjectedNode[] {
  const terms = parseSelector(selector);
  return index.filter((entry) => terms.every((term) => matchesTerm(entry, term)));
}

function matchesTerm(entry: ProjectedNode, term: Term): boolean {
  const node = entry.node;
  const fields = fieldsFor(term.key, entry, node);
  if (fields === undefined) {
    throw new EngineError('ENGINE_FAILURE', `selector key "${term.key}" is unknown; use id, text, role, type, or value`, { retryable: false });
  }
  return fields.some((field) => (term.op === '=' ? field === term.value : field.includes(term.value)));
}

function fieldsFor(key: string, entry: ProjectedNode, node: SemanticNode): string[] | undefined {
  switch (key) {
    case 'id':
      return node.testId === undefined ? [] : [node.testId];
    case 'text':
    case 'label':
      return [node.name, node.text].filter((v): v is string => v !== undefined);
    case 'role':
      return node.role === undefined ? [] : [node.role];
    case 'type':
      return [entry.raw.type ?? '', entry.kind, kindOf(entry.raw.type)];
    case 'value':
      return node.value === undefined ? [] : [node.value];
    default:
      return undefined;
  }
}
