/**
 * Projection of a MobAI snapshot (the host's nested UI tree) onto the
 * contract's `SemanticNode` tree. The host reports platform element types
 * (`XCUIElementTypeButton`, `android.widget.EditText`); this module maps
 * them onto the closed role vocabulary `screen.getByRole` speaks, keeps
 * every node's box in the tap coordinate space, and mints the ids the
 * surface acts on.
 */

import type { SemanticNode, ViewportSize } from 'e2e/engine';
import type { HostElement, HostSnapshot, Rect } from './client.ts';

/** One projected node with what the surface needs to act on it. */
export interface ProjectedNode {
  readonly id: string;
  /** Platform element type, lower-cased kebab (`text-field`, `edit-text`). */
  readonly kind: string;
  readonly raw: HostElement;
  readonly node: SemanticNode;
  readonly parent: ProjectedNode | undefined;
}

export interface ProjectedSnapshot {
  /** The screen's top-level nodes; the surface wraps them in one root. */
  readonly roots: readonly SemanticNode[];
  /** Every node in document order, parents before children. */
  readonly index: readonly ProjectedNode[];
  readonly viewport: ViewportSize;
  /** `<app> / <screen title>`, the opaque location the harness anchors on. */
  readonly location: string | undefined;
}

/** iOS element types onto the role vocabulary; anything else keeps its kind. */
const IOS_ROLE_MAP: Readonly<Record<string, string>> = {
  button: 'button',
  link: 'link',
  'text-field': 'textbox',
  'search-field': 'textbox',
  'text-view': 'textbox',
  'secure-text-field': 'textbox',
  switch: 'switch',
  toggle: 'switch',
  checkbox: 'checkbox',
  'check-box': 'checkbox',
  slider: 'slider',
  image: 'image',
  'static-text': 'text',
  cell: 'listitem',
  table: 'list',
  'collection-view': 'list',
  tab: 'tab',
  'tab-bar': 'tablist',
  'tab-group': 'tablist',
  'segmented-control': 'tablist',
  menu: 'menu',
  'menu-bar': 'menubar',
  'menu-item': 'menuitem',
  'menu-button': 'menuitem',
  toolbar: 'toolbar',
  'radio-group': 'radiogroup',
  'radio-button': 'radio',
  stepper: 'spinbutton',
  'picker-wheel': 'combobox',
  picker: 'combobox',
  alert: 'alert',
  dialog: 'dialog',
  sheet: 'dialog',
  'action-sheet': 'dialog',
  popover: 'dialog',
  heading: 'heading',
  'navigation-bar': 'navigation',
  'activity-indicator': 'status',
  'progress-indicator': 'progressbar',
  'scroll-view': 'group',
  'web-view': 'document',
  window: 'group',
  application: 'group',
  other: 'group',
};

/** Android view classes (simple name in kebab case) onto the role vocabulary. */
const ANDROID_ROLE_MAP: Readonly<Record<string, string>> = {
  'text-view': 'text',
  'edit-text': 'textbox',
  'auto-complete-text-view': 'textbox',
  'text-input-edit-text': 'textbox',
  'search-view': 'textbox',
  button: 'button',
  'image-button': 'button',
  'material-button': 'button',
  'floating-action-button': 'button',
  'image-view': 'image',
  switch: 'switch',
  'switch-compat': 'switch',
  'switch-material': 'switch',
  'toggle-button': 'switch',
  'check-box': 'checkbox',
  'material-check-box': 'checkbox',
  'checked-text-view': 'checkbox',
  'radio-button': 'radio',
  'seek-bar': 'slider',
  slider: 'slider',
  spinner: 'combobox',
  'progress-bar': 'progressbar',
  'radio-group': 'radiogroup',
  'number-picker': 'spinbutton',
  toolbar: 'toolbar',
  'action-bar': 'toolbar',
  'tab-layout': 'tablist',
  'tab-widget': 'tablist',
  'bottom-navigation-view': 'tablist',
  'tab-layout$tab-view': 'tab',
  'bottom-navigation-item-view': 'tab',
  'web-view': 'document',
  'recycler-view': 'list',
  'list-view': 'list',
  'abs-list-view': 'list',
  'grid-view': 'list',
  'scroll-view': 'group',
  'nested-scroll-view': 'group',
  'horizontal-scroll-view': 'group',
  'view-pager': 'group',
  'view-group': 'group',
  view: 'group',
  'compose-view': 'group',
  'card-view': 'group',
  'frame-layout': 'group',
  'linear-layout': 'group',
  'relative-layout': 'group',
  'constraint-layout': 'group',
  'coordinator-layout': 'group',
  'app-bar-layout': 'group',
  'drawer-layout': 'group',
};

const SECURE_KINDS: ReadonlySet<string> = new Set(['secure-text-field']);
const TEXT_INPUT_ROLES: ReadonlySet<string> = new Set(['textbox', 'searchbox', 'combobox']);
const CHECKABLE_ROLES: ReadonlySet<string> = new Set(['switch', 'checkbox', 'radio']);
const CHECKED_VALUES: ReadonlySet<string> = new Set(['1', 'on', 'true', 'checked', 'selected']);
const UNCHECKED_VALUES: ReadonlySet<string> = new Set(['0', 'off', 'false', 'unchecked']);
/** iOS containers whose button children a browser would call tabs. */
const TAB_CONTAINER_KINDS: ReadonlySet<string> = new Set(['tab-bar', 'segmented-control']);
/** Kinds whose own label is the screen's title. */
const TITLE_BAR_KINDS: ReadonlySet<string> = new Set(['navigation-bar', 'toolbar', 'action-bar']);

/** One element-type spelling for `XCUIElementTypeNavigationBar` and `android.widget.NavigationBar` alike. */
export function kindOf(type: string | undefined): string {
  if (type === undefined || type === '') return '';
  const simple = type.startsWith('XCUIElementType') ? type.slice('XCUIElementType'.length) : type.slice(type.lastIndexOf('.') + 1);
  return simple
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replaceAll(/[\s_]+/g, '-')
    .toLowerCase();
}

function isAndroidClass(type: string | undefined): boolean {
  return type !== undefined && type.includes('.');
}

function roleOf(kind: string, android: boolean, parentKind: string | undefined): string | undefined {
  if (kind === '') return undefined;
  if (android) return ANDROID_ROLE_MAP[kind] ?? (kind.endsWith('layout') ? 'group' : kind);
  if (kind === 'button' && parentKind !== undefined && TAB_CONTAINER_KINDS.has(parentKind)) return 'tab';
  return IOS_ROLE_MAP[kind] ?? kind;
}

/** A node the platform reports as editable takes typed text whatever its class. */
function editableRole(role: string | undefined, editable: boolean | undefined): string | undefined {
  if (editable !== true) return role;
  return role !== undefined && TEXT_INPUT_ROLES.has(role) ? role : 'textbox';
}

function checkedOf(role: string | undefined, raw: HostElement): boolean | undefined {
  if (raw.checked !== undefined) return raw.checked;
  if (role === undefined || !CHECKABLE_ROLES.has(role) || raw.value === undefined) return undefined;
  const lowered = raw.value.trim().toLowerCase();
  if (CHECKED_VALUES.has(lowered)) return true;
  if (UNCHECKED_VALUES.has(lowered)) return false;
  return undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}

/** The first static text under an element, depth first. */
function firstText(raw: HostElement): string | undefined {
  for (const child of raw.children ?? []) {
    const kind = kindOf(child.type);
    if ((kind === 'static-text' || kind === 'text-view') && nonEmpty(child.text) !== undefined) return child.text;
    const deeper = firstText(child);
    if (deeper !== undefined) return deeper;
  }
  return undefined;
}

/** Quotes one selector value the way `parseSelector` reads it back. */
export function quoteTerm(value: string): string {
  return /[\s"=]/.test(value) ? JSON.stringify(value) : value;
}

/**
 * Projects one snapshot. `mintId` is called once per node in document
 * order, so the surface's id space stays unique across observations.
 */
export function projectSnapshot(snapshot: HostSnapshot, options: { readonly mintId: () => string }): ProjectedSnapshot {
  const index: ProjectedNode[] = [];
  const build = (raw: HostElement, parent: ProjectedNode | undefined): SemanticNode => {
    const id = options.mintId();
    const kind = kindOf(raw.type);
    const android = isAndroidClass(raw.type);
    const role = editableRole(roleOf(kind, android, parent?.kind), raw.editable);
    const editable = raw.editable === true || (role !== undefined && TEXT_INPUT_ROLES.has(role));
    const secure = SECURE_KINDS.has(kind) || raw.password === true;
    const checked = checkedOf(role, raw);
    const text = nonEmpty(raw.text);
    const description = nonEmpty(raw.contentDesc);
    // A device label is the node's visible text and, unless the platform
    // carries an accessible name beside it, its name too.
    const name = description ?? text;
    const identifier = nonEmpty(raw.accessibilityId);
    const value = nonEmpty(raw.value);
    // A title bar with no label of its own is named after its title text, so
    // `getByRole('navigation', { name })` reads the screen the way a person does.
    const barTitle = name === undefined && TITLE_BAR_KINDS.has(kind) ? firstText(raw) : undefined;
    const states = {
      ...(raw.enabled === false ? { disabled: true } : {}),
      ...(raw.selected === true ? { selected: true } : {}),
      ...(raw.focused === true ? { focused: true } : {}),
      ...(secure ? { secure: true } : {}),
      ...(checked === undefined ? {} : { checked }),
    };
    const entry: { node: SemanticNode | undefined } = { node: undefined };
    const projected: ProjectedNode = {
      id,
      kind,
      raw,
      parent,
      get node(): SemanticNode {
        return entry.node as SemanticNode;
      },
    };
    index.push(projected);
    const children = (raw.children ?? []).map((child) => build(child, projected));
    // An empty field shows its placeholder as its label; the typed content is
    // the value. The label of an editable node therefore answers
    // `getByPlaceholder` too.
    const placeholder = editable ? text : undefined;
    const node: SemanticNode = {
      ref: { id, revision: '' },
      ...(role === undefined ? {} : { role }),
      ...(name === undefined ? (barTitle === undefined ? {} : { name: barTitle }) : { name }),
      ...(text === undefined ? {} : { text }),
      // A secure field's value is never observed. Android echoes a text
      // view's label as its value; that echo is dropped.
      ...(secure || value === undefined || (android && !editable && value === text) ? {} : { value }),
      ...(secure ? { inputPurpose: 'password' as const } : {}),
      ...(Object.keys(states).length === 0 ? {} : { states }),
      ...(placeholder === undefined ? {} : { attributes: { placeholder } }),
      ...(identifier === undefined ? {} : { testId: identifier }),
      ...(raw.bounds === undefined ? {} : { rect: { ...raw.bounds } }),
      ...(identifier === undefined ? {} : { selector: `id=${quoteTerm(identifier)}` }),
      ...(children.length === 0 ? {} : { children }),
    };
    entry.node = node;
    return node;
  };

  const top = topLevel(snapshot.root);
  const roots = top.map((raw) => build(raw, undefined));
  const viewport = viewportOf(snapshot);
  return { roots, index, viewport, location: screenLocation(snapshot, index) };
}

/**
 * The screen's top-level elements. The host's root is the application (iOS)
 * or the hierarchy (Android), one wrapper the contract's own root replaces;
 * a root that carries content of its own stays.
 */
function topLevel(root: HostElement): readonly HostElement[] {
  const kind = kindOf(root.type);
  const wrapper = kind === '' || kind === 'root' || kind === 'application' || kind === 'hierarchy' || kind === 'window';
  if (wrapper && (root.children?.length ?? 0) > 0) return root.children ?? [];
  if (wrapper && nonEmpty(root.text) === undefined && nonEmpty(root.contentDesc) === undefined) return [];
  return [root];
}

/** The viewport the host reported, else the extent of every rect. */
function viewportOf(snapshot: HostSnapshot): ViewportSize {
  const { width, height } = snapshot.viewport;
  if (width > 0 && height > 0) return { width, height };
  let w = 0;
  let h = 0;
  const walk = (e: HostElement): void => {
    if (e.bounds !== undefined) {
      w = Math.max(w, e.bounds.x + e.bounds.width);
      h = Math.max(h, e.bounds.y + e.bounds.height);
    }
    for (const child of e.children ?? []) walk(child);
  };
  walk(snapshot.root);
  return { width: w, height: h };
}

/**
 * The screen's title: the navigation bar's or toolbar's own label, else the
 * first text inside it. Undefined when the screen has no title bar.
 */
export function screenTitle(index: readonly ProjectedNode[]): string | undefined {
  const bar = index.find((entry) => TITLE_BAR_KINDS.has(entry.kind));
  if (bar === undefined) return undefined;
  const own = nonEmpty(bar.raw.text) ?? nonEmpty(bar.raw.contentDesc);
  if (own !== undefined) return own;
  const text = index.find((entry) => entry.node.role === 'text' && nonEmpty(entry.raw.text) !== undefined && isWithin(entry, bar));
  if (text !== undefined) return text.raw.text;
  return nonEmpty(bar.raw.accessibilityId);
}

/**
 * `<app> / <title>`: an opaque address the harness shows the model and
 * anchors replay on. Deliberately not a URL, so no origin policy applies.
 */
function screenLocation(snapshot: HostSnapshot, index: readonly ProjectedNode[]): string | undefined {
  const app = nonEmpty(snapshot.app.bundleId) ?? nonEmpty(snapshot.app.activity);
  const parts = [app, screenTitle(index)]
    .map((part) => (part === undefined ? '' : part.replaceAll(/\s+/g, ' ').trim()))
    .filter((part) => part !== '');
  return parts.length === 0 ? undefined : parts.join(' / ');
}

/** True when `entry` is a strict descendant of `ancestor`. */
export function isWithin(entry: ProjectedNode, ancestor: ProjectedNode): boolean {
  for (let current = entry.parent; current !== undefined; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

/** The id of the root node every observation is reported under; stable across observations. */
export const ROOT_ID = 'root';

/** The one root the contract wants over the device's top-level elements. */
export function screenRoot(roots: readonly SemanticNode[], viewport: ViewportSize): SemanticNode {
  return {
    ref: { id: ROOT_ID, revision: '' },
    role: 'screen',
    rect: { x: 0, y: 0, width: viewport.width, height: viewport.height },
    ...(roots.length === 0 ? {} : { children: roots }),
  };
}

export function centreOf(rect: Rect): { x: number; y: number } {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}
