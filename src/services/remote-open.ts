import type { Channel } from '../types';
import { channelKey } from '../utils/channel';

// A launch parameter that opens a place in the app, sent by home automation
// (Home Assistant's webOS integration launches the app with params):
//   { "iptv": { "open": "group",   "group": "<group name>" } }
//   { "iptv": { "open": "channel", "channel": "<key | number | name>" } }
//   { "iptv": { "open": "movies" | "series", "category": "<id | name>" } }
//   { "iptv": { "open": "live" | "movies" | "series" } }
export type RemoteOpen =
  | { kind: 'live' }
  | { kind: 'group'; group: string }
  | { kind: 'channel'; channel: string }
  | { kind: 'movies' | 'series'; category: string | null };

function text(value: unknown): string | null {
  if (typeof value === 'number' && isFinite(value)) return String(value);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// A cold launch hands a JSON string, a relaunch an object.
export function parseRemoteOpen(raw: unknown): RemoteOpen | null {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object') return null;
  const spec = (obj as { iptv?: unknown }).iptv;
  if (!spec || typeof spec !== 'object') return null;
  const s = spec as Record<string, unknown>;
  switch (s.open) {
    case 'live': return { kind: 'live' };
    case 'group': {
      const group = text(s.group);
      return group ? { kind: 'group', group } : null;
    }
    case 'channel': {
      const channel = text(s.channel);
      return channel ? { kind: 'channel', channel } : null;
    }
    case 'movies':
    case 'series':
      return { kind: s.open, category: text(s.category) };
    default:
      return null;
  }
}

export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, ' ').trim();
}

// Group names come from the provider, often with a flag emoji in front: match
// the exact name first, then ignoring case, then ignoring everything but
// letters and digits, so "Sky Cinema (4K)" finds "🇮🇹 Sky Cinema (4K)".
export function matchName(wanted: string, names: readonly string[]): string | null {
  if (names.indexOf(wanted) !== -1) return wanted;
  const norm = normalizeName(wanted);
  for (const name of names) if (normalizeName(name) === norm) return name;
  const bare = (value: string): string => normalizeName(value).replace(/[^a-z0-9]+/g, '');
  const wantedBare = bare(wanted);
  if (!wantedBare) return null;
  for (const name of names) if (bare(name) === wantedBare) return name;
  return null;
}

// The channel by its stable key, else by its 1-based number in the list,
// else by name. Returns the index in `channels`, or -1.
export function resolveRemoteChannel(ref: string, channels: readonly Channel[]): number {
  for (let i = 0; i < channels.length; i++) {
    if (channelKey(channels[i]) === ref) return i;
  }
  if (/^\d+$/.test(ref)) {
    const index = parseInt(ref, 10) - 1;
    return index >= 0 && index < channels.length ? index : -1;
  }
  const name = matchName(ref, channels.map(channel => channel.name));
  if (name === null) return -1;
  for (let i = 0; i < channels.length; i++) if (channels[i].name === name) return i;
  return -1;
}
