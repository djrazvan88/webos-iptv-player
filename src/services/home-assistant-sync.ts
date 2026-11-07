import { createLogger } from '../utils/logger';
import { fetchWithTimeout } from '../utils/fetch-helper';

const log = createLogger('HaSync');

export const HA_SYNC_CHECK_MS = 15_000;
const HA_SYNC_TIMEOUT_MS = 10_000;

// What the app shows, so home automation offers only what is on screen. Short
// keys keep a few thousand channels small.
export interface HaCatalog {
  groups: { name: string; label: string; count: number }[];
  // k: stable channel key, n: name, g: group name, num: 1-based list number.
  channels: { k: string; n: string; g: string; num: number }[];
  movies: { id: string; name: string }[];
  series: { id: string; name: string }[];
}

export interface HaSyncDeps {
  webhookUrl: () => string;
  // Cheap to compute; the catalog is rebuilt and posted only when it changes.
  signature: () => readonly unknown[];
  catalog: () => Promise<HaCatalog | null>;
  appVersion: string;
}

export function isValidWebhookUrl(url: string): boolean {
  return /^https?:\/\/[^\s/]+\/api\/webhook\/[A-Za-z0-9_-]+$/.test(url);
}

// Posts the catalog to a Home Assistant webhook whenever it changes. A failed
// post is retried on the next check; an unchanged catalog is never resent.
export class HomeAssistantSync {
  private lastSignature: readonly unknown[] | null = null;
  private lastSent = '';
  private lastUrl = '';
  private running = false;
  private failureLogged = false;

  constructor(private readonly deps: HaSyncDeps) {}

  start(): void {
    setInterval(() => { void this.check(); }, HA_SYNC_CHECK_MS);
    void this.check();
  }

  async check(): Promise<'off' | 'unchanged' | 'sent' | 'failed'> {
    const url = this.deps.webhookUrl();
    if (!url || !isValidWebhookUrl(url)) return 'off';
    if (this.running) return 'unchanged';
    const signature = this.deps.signature();
    if (url === this.lastUrl && this.lastSignature && sameSignature(signature, this.lastSignature)) {
      return 'unchanged';
    }
    this.running = true;
    try {
      const catalog = await this.deps.catalog();
      if (!catalog) return 'unchanged';
      const body = JSON.stringify({ app: 'com.lennylxx.iptv', version: this.deps.appVersion, ...catalog });
      if (url === this.lastUrl && body === this.lastSent) {
        this.lastSignature = signature;
        return 'unchanged';
      }
      await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }, HA_SYNC_TIMEOUT_MS);
      this.lastSent = body;
      this.lastUrl = url;
      this.lastSignature = signature;
      this.failureLogged = false;
      log.info('Catalog sent to Home Assistant', 'event=ha.sync.sent',
        `groups=${String(catalog.groups.length)}`, `channels=${String(catalog.channels.length)}`,
        `movies=${String(catalog.movies.length)}`, `series=${String(catalog.series.length)}`);
      return 'sent';
    } catch (err) {
      // Home Assistant down or restarting: say so once, keep retrying quietly.
      if (!this.failureLogged) {
        log.warn('Home Assistant sync failed', 'event=ha.sync.failed', err);
        this.failureLogged = true;
      }
      return 'failed';
    } finally {
      this.running = false;
    }
  }
}

// A one-off event for Home Assistant to act on (the sleep timer asks it to
// power the TV off, which an app in Developer Mode may not be allowed to).
export async function notifyHomeAssistant(url: string, event: string, appVersion: string): Promise<boolean> {
  if (!url || !isValidWebhookUrl(url)) return false;
  try {
    await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app: 'com.lennylxx.iptv', version: appVersion, event }),
    }, 3000);
    return true;
  } catch (err) {
    log.warn('Home Assistant event failed', 'event=ha.notify.failed', `name=${event}`, err);
    return false;
  }
}

function sameSignature(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
