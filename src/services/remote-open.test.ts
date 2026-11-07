import { describe, expect, it } from 'vitest';
import type { Channel } from '../types';
import { channelKey } from '../utils/channel';
import { matchName, parseRemoteOpen, resolveRemoteChannel } from './remote-open';

function ch(id: string, name: string): Channel {
  return { id, name, logo: '', group: 'g1', url: `http://host/${id}`, extras: null, playlistIds: [], catchupDays: 0 } as Channel;
}

describe('parseRemoteOpen', () => {
  it('reads the spec from a cold-launch JSON string and a relaunch object', () => {
    expect(parseRemoteOpen('{"iptv":{"open":"group","group":"Alpha"}}'))
      .toEqual({ kind: 'group', group: 'Alpha' });
    expect(parseRemoteOpen({ iptv: { open: 'channel', channel: 12 } }))
      .toEqual({ kind: 'channel', channel: '12' });
    expect(parseRemoteOpen({ iptv: { open: 'movies', category: ' Bravo ' } }))
      .toEqual({ kind: 'movies', category: 'Bravo' });
    expect(parseRemoteOpen({ iptv: { open: 'series' } })).toEqual({ kind: 'series', category: null });
    expect(parseRemoteOpen({ iptv: { open: 'live' } })).toEqual({ kind: 'live' });
  });

  it('ignores anything else, reminder launches included', () => {
    expect(parseRemoteOpen(undefined)).toBeNull();
    expect(parseRemoteOpen('not json')).toBeNull();
    expect(parseRemoteOpen({ reminderChannelKey: 'k1' })).toBeNull();
    expect(parseRemoteOpen({ iptv: { open: 'group' } })).toBeNull();
    expect(parseRemoteOpen({ iptv: { open: 'channel', channel: '  ' } })).toBeNull();
    expect(parseRemoteOpen({ iptv: { open: 'elsewhere' } })).toBeNull();
    expect(parseRemoteOpen({ iptv: 'group' })).toBeNull();
  });
});

describe('matchName', () => {
  const names = ['🇮🇹 Alpha (4K)', 'Bravo Charlie', 'Delta'];

  it('prefers the exact name, then ignores case and spacing, then symbols', () => {
    expect(matchName('Delta', names)).toBe('Delta');
    expect(matchName('bravo   charlie', names)).toBe('Bravo Charlie');
    expect(matchName('Alpha (4K)', names)).toBe('🇮🇹 Alpha (4K)');
    expect(matchName('alpha 4k', names)).toBe('🇮🇹 Alpha (4K)');
  });

  it('finds nothing for an unknown or symbol-only name', () => {
    expect(matchName('Echo', names)).toBeNull();
    expect(matchName('🇮🇹', names)).toBeNull();
  });
});

describe('resolveRemoteChannel', () => {
  const channels = [ch('a', 'Alpha'), ch('b', 'Bravo'), ch('c', 'Charlie')];

  it('resolves a stable key, a 1-based number, or a name', () => {
    expect(resolveRemoteChannel(channelKey(channels[2]), channels)).toBe(2);
    expect(resolveRemoteChannel('2', channels)).toBe(1);
    expect(resolveRemoteChannel('alpha', channels)).toBe(0);
  });

  it('returns -1 for a number out of range or an unknown channel', () => {
    expect(resolveRemoteChannel('0', channels)).toBe(-1);
    expect(resolveRemoteChannel('4', channels)).toBe(-1);
    expect(resolveRemoteChannel('Delta', channels)).toBe(-1);
  });
});
