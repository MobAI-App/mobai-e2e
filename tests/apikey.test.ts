import { describe, expect, it } from 'vitest';
import { resolveApiKey } from '../src/host.ts';

describe('engine API key', () => {
  it('takes the option over MOBAI_API_KEY, and ignores blanks', () => {
    expect(resolveApiKey({ apiKey: 'mobai_opt' }, { MOBAI_API_KEY: 'mobai_env' })).toBe('mobai_opt');
    expect(resolveApiKey({}, { MOBAI_API_KEY: ' mobai_env ' })).toBe('mobai_env');
    expect(resolveApiKey({ apiKey: ' ' }, {})).toBeUndefined();
  });
});
