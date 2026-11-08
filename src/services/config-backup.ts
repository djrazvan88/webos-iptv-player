import { createLogger } from '../utils/logger';
import { fetchWithTimeout } from '../utils/fetch-helper';
import { isValidWebhookUrl } from './home-assistant-sync';
import {
  openPersistenceDb,
  requestResult,
  transactionDone,
  USER_DATA_STORES,
  USER_META_STORE,
} from './idb-database';

const log = createLogger('ConfigBackup');

// Optional file packaged next to index.html by a local build. It holds the
// addresses only; without it nothing is backed up or restored.
const SETTINGS_FILE = 'ha-backup.json';
// Set after an in-app reset so a deliberately emptied app is not refilled.
export const RESTORE_SKIP_KEY = 'iptv_restore_skip';
export const BACKUP_FIRST_CHECK_MS = 30_000;
export const BACKUP_CHECK_MS = 5 * 60_000;
const SETTINGS_TIMEOUT_MS = 3000;
const RESTORE_TIMEOUT_MS = 8000;
const SEND_TIMEOUT_MS = 10_000;
const BACKUP_STORES: readonly string[] = [...USER_DATA_STORES, USER_META_STORE];

export interface BackupSettings {
  restoreUrl: string;
  webhookUrl: string;
}

export interface ConfigSnapshot {
  app: string;
  savedAt: string;
  idbVersion?: number;
  localStorage: Record<string, string>;
  indexedDB: Record<string, { keyPath: string | null; keys: IDBValidKey[]; values: unknown[] }>;
}

const NO_SETTINGS: BackupSettings = { restoreUrl: '', webhookUrl: '' };

function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\/[^\s/]+\/\S+$/.test(value);
}

export async function loadBackupSettings(): Promise<BackupSettings> {
  try {
    const raw = await (await fetchWithTimeout(SETTINGS_FILE, {}, SETTINGS_TIMEOUT_MS)).json() as {
      restoreUrl?: unknown; webhookUrl?: unknown;
    };
    return {
      restoreUrl: isHttpUrl(raw.restoreUrl) ? raw.restoreUrl : '',
      webhookUrl: typeof raw.webhookUrl === 'string' && isValidWebhookUrl(raw.webhookUrl) ? raw.webhookUrl : '',
    };
  } catch {
    return NO_SETTINGS;
  }
}

/** True when the snapshot carries at least one source, so an emptied app
 *  never overwrites a good backup and an empty backup is never restored. */
export function isUsableSnapshot(value: unknown): value is ConfigSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<ConfigSnapshot>;
  if (!snapshot.localStorage || typeof snapshot.localStorage !== 'object') return false;
  if (!snapshot.indexedDB || typeof snapshot.indexedDB !== 'object') return false;
  try {
    const playlists = JSON.parse(snapshot.localStorage.iptv_playlists ?? '[]') as unknown;
    return Array.isArray(playlists) && playlists.length > 0;
  } catch {
    return false;
  }
}

export async function readSnapshot(): Promise<ConfigSnapshot> {
  const ls: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key === null || key === RESTORE_SKIP_KEY) continue;
    ls[key] = localStorage.getItem(key) ?? '';
  }
  const snapshot: ConfigSnapshot = {
    app: __APP_ID__,
    savedAt: new Date().toISOString(),
    localStorage: ls,
    indexedDB: {},
  };
  const db = await openPersistenceDb();
  if (!db) return snapshot;
  snapshot.idbVersion = db.version;
  const stores = BACKUP_STORES.filter(name => db.objectStoreNames.contains(name));
  if (!stores.length) return snapshot;
  const tx = db.transaction(stores, 'readonly');
  await Promise.all(stores.map(async (name) => {
    const store = tx.objectStore(name);
    const [keys, values] = await Promise.all([
      requestResult(store.getAllKeys()),
      requestResult(store.getAll()),
    ]);
    const keyPath = typeof store.keyPath === 'string' ? store.keyPath : null;
    snapshot.indexedDB[name] = { keyPath, keys, values };
  }));
  return snapshot;
}

async function writeSnapshot(snapshot: ConfigSnapshot): Promise<number> {
  let records = 0;
  const db = await openPersistenceDb();
  if (db) {
    const stores = Object.keys(snapshot.indexedDB)
      .filter(name => BACKUP_STORES.includes(name) && db.objectStoreNames.contains(name));
    if (stores.length) {
      const tx = db.transaction(stores, 'readwrite');
      const done = transactionDone(tx);
      for (const name of stores) {
        const store = tx.objectStore(name);
        const data = snapshot.indexedDB[name];
        data.values.forEach((value, i) => {
          if (store.keyPath) store.put(value);
          else store.put(value, data.keys[i]);
          records++;
        });
      }
      await done;
    }
  }
  // localStorage last: until it is written the app still counts as empty,
  // so a failure above leaves the next launch free to try again.
  for (const key of Object.keys(snapshot.localStorage)) {
    if (key !== RESTORE_SKIP_KEY) localStorage.setItem(key, snapshot.localStorage[key]);
  }
  return records;
}

/** Refills an app whose storage webOS wiped. Resolves true when the caller
 *  must reload so every service starts from the restored data. */
export async function restoreIfEmpty(settings: BackupSettings): Promise<boolean> {
  if (!settings.restoreUrl || localStorage.length > 0) return false;
  let snapshot: unknown;
  try {
    snapshot = await (await fetchWithTimeout(settings.restoreUrl, { cache: 'no-store' }, RESTORE_TIMEOUT_MS)).json();
  } catch (err) {
    log.warn('Backup download failed', 'event=backup.restore.failed', 'reason=download', err);
    return false;
  }
  if (!isUsableSnapshot(snapshot)) {
    log.warn('Backup has no sources', 'event=backup.restore.failed', 'reason=empty');
    return false;
  }
  try {
    const records = await writeSnapshot(snapshot);
    log.info('Configuration restored from backup', 'event=backup.restore.completed',
      `keys=${String(Object.keys(snapshot.localStorage).length)}`, `records=${String(records)}`);
    return true;
  } catch (err) {
    log.error('Backup restore failed', 'event=backup.restore.failed', 'reason=write', err);
    return false;
  }
}

export function markRestoreSkipped(): void {
  try {
    localStorage.setItem(RESTORE_SKIP_KEY, '1');
  } catch {
    // Storage unavailable: the next launch simply offers the restore again.
  }
}

// Asks the engine to keep this app's storage out of automatic eviction.
export async function requestPersistentStorage(): Promise<boolean | null> {
  // eslint-disable-next-line compat/compat
  const storage = navigator.storage as StorageManager | undefined;
  if (!storage || typeof storage.persist !== 'function') return null;
  try {
    const granted = await storage.persist();
    log.info('Persistent storage requested', 'event=storage.persist', `granted=${String(granted)}`);
    return granted;
  } catch (err) {
    log.warn('Persistent storage request failed', 'event=storage.persist.failed', err);
    return null;
  }
}

export interface ConfigBackupDeps {
  webhookUrl: () => string;
  appVersion: string;
  snapshot?: () => Promise<ConfigSnapshot>;
}

// Posts the configuration to the Home Assistant webhook whenever it changes.
// An empty configuration is never sent, so it cannot replace a good backup.
export class ConfigBackup {
  private lastSent = '';
  private lastUrl = '';
  private running = false;
  private failureLogged = false;

  constructor(private readonly deps: ConfigBackupDeps) {}

  start(): void {
    setTimeout(() => {
      void this.check();
      setInterval(() => { void this.check(); }, BACKUP_CHECK_MS);
    }, BACKUP_FIRST_CHECK_MS);
  }

  async check(): Promise<'off' | 'empty' | 'unchanged' | 'sent' | 'failed'> {
    const url = this.deps.webhookUrl();
    if (!url || !isValidWebhookUrl(url)) return 'off';
    if (this.running) return 'unchanged';
    this.running = true;
    try {
      const snapshot = await (this.deps.snapshot ?? readSnapshot)();
      if (!isUsableSnapshot(snapshot)) return 'empty';
      const content = JSON.stringify([snapshot.localStorage, snapshot.indexedDB]);
      if (url === this.lastUrl && content === this.lastSent) return 'unchanged';
      await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app: __APP_ID__, version: this.deps.appVersion, event: 'backup', backup: snapshot }),
      }, SEND_TIMEOUT_MS);
      this.lastSent = content;
      this.lastUrl = url;
      this.failureLogged = false;
      log.info('Configuration backed up', 'event=backup.sent',
        `keys=${String(Object.keys(snapshot.localStorage).length)}`);
      return 'sent';
    } catch (err) {
      if (!this.failureLogged) {
        log.warn('Configuration backup failed', 'event=backup.failed', err);
        this.failureLogged = true;
      }
      return 'failed';
    } finally {
      this.running = false;
    }
  }
}
