import { describe, expect, it } from 'vitest';
import type { HostSnapshot } from '../src/client.ts';
import { projectSnapshot } from '../src/nodes.ts';
import { matchSelector, parseSelector } from '../src/selector.ts';

const snapshot: HostSnapshot = {
  platform: 'ios',
  viewport: { width: 100, height: 100 },
  app: {},
  keyboardShown: false,
  root: {
    type: 'XCUIElementTypeApplication',
    children: [
      { type: 'XCUIElementTypeButton', text: 'Sign in', accessibilityId: 'login', bounds: { x: 0, y: 0, width: 10, height: 10 }, enabled: true },
      { type: 'XCUIElementTypeButton', text: 'Sign up', bounds: { x: 0, y: 20, width: 10, height: 10 }, enabled: true },
      { type: 'XCUIElementTypeStaticText', text: 'Welcome back', bounds: { x: 0, y: 40, width: 10, height: 10 }, enabled: true },
    ],
  },
};

describe('parseSelector', () => {
  it('reads bare and quoted terms', () => {
    expect(parseSelector('id=login')).toEqual([{ key: 'id', op: '=', value: 'login' }]);
    expect(parseSelector('text="Sign in" role=button')).toEqual([
      { key: 'text', op: '=', value: 'Sign in' },
      { key: 'role', op: '=', value: 'button' },
    ]);
    expect(parseSelector('text~=Sign')).toEqual([{ key: 'text', op: '~=', value: 'Sign' }]);
  });

  it('refuses what is not a term', () => {
    expect(() => parseSelector('just words')).toThrow(/key=value/);
    expect(() => parseSelector('')).toThrow();
  });
});

describe('matchSelector', () => {
  let n = 0;
  const projected = projectSnapshot(snapshot, { mintId: () => `n${++n}` });

  it('matches ids, exact text, substrings, roles and types', () => {
    expect(matchSelector('id=login', projected.index).map((e) => e.node.name)).toEqual(['Sign in']);
    expect(matchSelector('text="Sign up"', projected.index).map((e) => e.node.name)).toEqual(['Sign up']);
    expect(matchSelector('text~=Sign role=button', projected.index).map((e) => e.node.name)).toEqual(['Sign in', 'Sign up']);
    expect(matchSelector('type=XCUIElementTypeStaticText', projected.index).map((e) => e.node.text)).toEqual(['Welcome back']);
    expect(matchSelector('type=static-text', projected.index).length).toBe(1);
  });

  it('refuses an unknown key', () => {
    expect(() => matchSelector('colour=red', projected.index)).toThrow(/unknown/);
  });
});
