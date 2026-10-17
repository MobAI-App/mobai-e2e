import { describe, expect, it } from 'vitest';
import type { HostSnapshot } from '../src/client.ts';
import { kindOf, projectSnapshot, screenRoot, screenTitle } from '../src/nodes.ts';

function mint(): () => string {
  let n = 0;
  return () => `n${++n}`;
}

const ios: HostSnapshot = {
  platform: 'ios',
  viewport: { width: 393, height: 852 },
  app: { bundleId: 'com.example.app' },
  keyboardShown: false,
  root: {
    type: 'XCUIElementTypeApplication',
    bounds: { x: 0, y: 0, width: 393, height: 852 },
    enabled: true,
    children: [
      {
        type: 'XCUIElementTypeWindow',
        bounds: { x: 0, y: 0, width: 393, height: 852 },
        enabled: true,
        children: [
          {
            type: 'XCUIElementTypeNavigationBar',
            text: 'Settings',
            accessibilityId: 'Settings',
            bounds: { x: 0, y: 44, width: 393, height: 44 },
            enabled: true,
            children: [{ type: 'XCUIElementTypeButton', text: 'Back', bounds: { x: 8, y: 48, width: 60, height: 36 }, enabled: true }],
          },
          { type: 'XCUIElementTypeTextField', text: 'Email', value: 'me@example.com', accessibilityId: 'email', bounds: { x: 20, y: 120, width: 353, height: 44 }, enabled: true, editable: true, focused: true },
          { type: 'XCUIElementTypeSecureTextField', text: 'Password', value: '••••', accessibilityId: 'password', bounds: { x: 20, y: 180, width: 353, height: 44 }, enabled: true, editable: true },
          { type: 'XCUIElementTypeSwitch', text: 'Remember me', value: '1', bounds: { x: 20, y: 240, width: 353, height: 44 }, enabled: true, children: [{ type: 'XCUIElementTypeSwitch', value: '1', bounds: { x: 322, y: 246, width: 51, height: 31 }, enabled: true }] },
          { type: 'XCUIElementTypeButton', text: 'Sign in', bounds: { x: 20, y: 300, width: 353, height: 50 }, enabled: false },
          {
            type: 'XCUIElementTypeTabBar',
            bounds: { x: 0, y: 770, width: 393, height: 82 },
            enabled: true,
            children: [
              { type: 'XCUIElementTypeButton', text: 'Home', bounds: { x: 0, y: 770, width: 196, height: 82 }, enabled: true, selected: true },
              { type: 'XCUIElementTypeButton', text: 'Profile', bounds: { x: 196, y: 770, width: 197, height: 82 }, enabled: true },
            ],
          },
        ],
      },
    ],
  },
};

const android: HostSnapshot = {
  platform: 'android',
  viewport: { width: 1080, height: 2400 },
  app: { bundleId: 'com.example.app', activity: '.MainActivity' },
  keyboardShown: false,
  root: {
    type: 'hierarchy',
    children: [
      {
        type: 'android.widget.FrameLayout',
        bounds: { x: 0, y: 0, width: 1080, height: 2400 },
        enabled: true,
        children: [
          { type: 'androidx.appcompat.widget.Toolbar', bounds: { x: 0, y: 0, width: 1080, height: 150 }, enabled: true, children: [{ type: 'android.widget.TextView', text: 'Checkout', bounds: { x: 40, y: 40, width: 400, height: 70 }, enabled: true }] },
          { type: 'android.widget.EditText', text: 'Promo code', accessibilityId: 'com.example.app:id/promo', bounds: { x: 40, y: 300, width: 1000, height: 120 }, enabled: true, editable: true },
          { type: 'android.widget.EditText', text: 'PIN', password: true, bounds: { x: 40, y: 450, width: 1000, height: 120 }, enabled: true, editable: true },
          { type: 'android.widget.CheckBox', text: 'Gift wrap', contentDesc: 'Add gift wrap', checked: false, bounds: { x: 40, y: 600, width: 1000, height: 100 }, enabled: true },
          { type: 'android.widget.TextView', text: 'Total: $42', bounds: { x: 40, y: 800, width: 1000, height: 80 }, enabled: true },
          { type: 'android.widget.Button', text: 'Pay', accessibilityId: 'com.example.app:id/pay', bounds: { x: 40, y: 1000, width: 1000, height: 140 }, enabled: true, clickable: true },
        ],
      },
    ],
  },
};

describe('kindOf', () => {
  it('reads iOS and Android types as one vocabulary', () => {
    expect(kindOf('XCUIElementTypeNavigationBar')).toBe('navigation-bar');
    expect(kindOf('android.widget.EditText')).toBe('edit-text');
    expect(kindOf('androidx.appcompat.widget.Toolbar')).toBe('toolbar');
    expect(kindOf(undefined)).toBe('');
  });
});

describe('projectSnapshot on iOS', () => {
  const projected = projectSnapshot(ios, { mintId: mint() });
  const byTestId = (id: string) => projected.index.find((entry) => entry.node.testId === id)!;

  it('wraps the window content as roots and reports the viewport', () => {
    expect(projected.viewport).toEqual({ width: 393, height: 852 });
    expect(projected.roots.length).toBe(1);
    expect(projected.roots[0]?.role).toBe('group');
    const root = screenRoot(projected.roots, projected.viewport);
    expect(root.ref.id).toBe('root');
    expect(root.rect).toEqual({ x: 0, y: 0, width: 393, height: 852 });
  });

  it('names the location after the app and the navigation bar', () => {
    expect(screenTitle(projected.index)).toBe('Settings');
    expect(projected.location).toBe('com.example.app / Settings');
  });

  it('maps fields, secure fields, and switches', () => {
    const email = byTestId('email').node;
    expect(email.role).toBe('textbox');
    expect(email.value).toBe('me@example.com');
    expect(email.states).toEqual({ focused: true });
    expect(email.attributes).toEqual({ placeholder: 'Email' });
    expect(email.selector).toBe('id=email');

    const password = byTestId('password').node;
    expect(password.states?.secure).toBe(true);
    expect(password.value).toBeUndefined();
    expect(password.inputPurpose).toBe('password');

    const toggle = projected.index.find((entry) => entry.node.name === 'Remember me')!.node;
    expect(toggle.role).toBe('switch');
    expect(toggle.states?.checked).toBe(true);
  });

  it('reports disabled buttons, tabs inside a tab bar, and the selected one', () => {
    const signIn = projected.index.find((entry) => entry.node.name === 'Sign in')!.node;
    expect(signIn.role).toBe('button');
    expect(signIn.states?.disabled).toBe(true);
    const home = projected.index.find((entry) => entry.node.name === 'Home')!.node;
    expect(home.role).toBe('tab');
    expect(home.states?.selected).toBe(true);
    const bar = projected.index.find((entry) => entry.kind === 'tab-bar')!.node;
    expect(bar.role).toBe('tablist');
  });
});

describe('projectSnapshot on Android', () => {
  const projected = projectSnapshot(android, { mintId: mint() });

  it('drops the hierarchy wrapper and titles the screen from the toolbar', () => {
    expect(projected.roots.length).toBe(1);
    expect(projected.location).toBe('com.example.app / Checkout');
  });

  it('maps resource ids to test ids and hints to placeholders', () => {
    const promo = projected.index.find((entry) => entry.node.testId === 'com.example.app:id/promo')!.node;
    expect(promo.role).toBe('textbox');
    expect(promo.attributes).toEqual({ placeholder: 'Promo code' });
    expect(promo.text).toBe('Promo code');
  });

  it('reads the password attribute and the checked attribute', () => {
    const pin = projected.index.find((entry) => entry.node.text === 'PIN')!.node;
    expect(pin.states?.secure).toBe(true);
    const wrap = projected.index.find((entry) => entry.node.role === 'checkbox')!.node;
    expect(wrap.name).toBe('Add gift wrap');
    expect(wrap.text).toBe('Gift wrap');
    expect(wrap.states?.checked).toBe(false);
  });

  it('keeps layout classes as groups and text views as text', () => {
    const total = projected.index.find((entry) => entry.node.text === 'Total: $42')!.node;
    expect(total.role).toBe('text');
    expect(projected.index.find((entry) => entry.kind === 'frame-layout')!.node.role).toBe('group');
  });
});

describe('title bars', () => {
  it('names a navigation bar without a label after its title text', () => {
    const snapshot: HostSnapshot = {
      platform: 'ios',
      viewport: { width: 100, height: 100 },
      app: { bundleId: 'com.apple.Preferences' },
      keyboardShown: false,
      root: {
        type: 'XCUIElementTypeApplication',
        children: [
          {
            type: 'XCUIElementTypeNavigationBar',
            bounds: { x: 0, y: 0, width: 100, height: 40 },
            enabled: true,
            children: [
              { type: 'XCUIElementTypeButton', text: 'Settings', bounds: { x: 0, y: 0, width: 30, height: 40 }, enabled: true },
              { type: 'XCUIElementTypeOther', children: [{ type: 'XCUIElementTypeStaticText', text: 'Camera', bounds: { x: 40, y: 0, width: 30, height: 40 }, enabled: true }] },
            ],
          },
        ],
      },
    };
    const projected = projectSnapshot(snapshot, { mintId: mint() });
    const bar = projected.index.find((entry) => entry.kind === 'navigation-bar')!.node;
    expect(bar.role).toBe('navigation');
    expect(bar.name).toBe('Camera');
    expect(projected.location).toBe('com.apple.Preferences / Camera');
  });
});
