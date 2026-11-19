// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { isFireTvNative, isWebOS } from './platform';

const w = window as unknown as { FireNative?: unknown };

describe('platform', () => {
  afterEach(() => { delete w.FireNative; });

  it('treats the Fire TV shell as the native (webOS) playback path', () => {
    expect(isFireTvNative()).toBe(false);
    w.FireNative = {};
    expect(isFireTvNative()).toBe(true);
    expect(isWebOS()).toBe(true);
  });
});
