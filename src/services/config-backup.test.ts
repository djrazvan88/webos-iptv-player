// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConfigBackup,
  isUsableSnapshot,
  loadBackupSettings,
  markRestoreSkipped,
  readSnapshot,
  restoreIfEmpty,
  type ConfigSnapshot,
} from './config-backup';
import { openPersistenceDb, requestResult, transactionDone } from './idb-database';

const WEBHOOK = 'http://host/api/webhook/hook1';
const RESTORE = 'http://host/local/b1.json';
const SETTINGS = { restoreUrl: RESTORE, webhookUrl: WEBHOOK };

function snapshotWith(playlists: unknown[]): ConfigSnapshot {
  return {
    app: 'com.example.app',
    savedAt: '2026-01-01T00:00:00.000Z',
    idbVersion: 7,
    localStorage: { iptv_playlists: JSON.stringify(playlists), iptv_theme: '"t1"' },
    indexedDB: {
      favorites: { keyPath: 'key', keys: ['favorite:ch1'], values: [{ key: 'favorite:ch1', value: 'ch1' }] },
      'user-meta': { keyPath: 'key', keys: ['migration:m1'], values: [{ key: 'migration:m1', migratedAt: 1 }] },
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function clearStores(): Promise<void> {
  const db = await openPersistenceDb();
  if (!db) return;
  const names = Array.from(db.objectStoreNames);
  const tx = db.transaction(names, 'readwrite');
  const done = transactionDone(tx);
  for (const name of names) tx.objectStore(name).clear();
  await done;
}

describe('config backup', () => {
  beforeEach(async () => {
    localStorage.clear();
    await clearStores();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('reads backup addresses from the packaged file and ignores bad ones', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ restoreUrl: RESTORE, webhookUrl: 'not a url' })));
    expect(await loadBackupSettings()).toEqual({ restoreUrl: RESTORE, webhookUrl: '' });
  });

  it('turns itself off when the packaged file is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    expect(await loadBackupSettings()).toEqual({ restoreUrl: '', webhookUrl: '' });
  });

  it('accepts only snapshots that carry a source', () => {
    expect(isUsableSnapshot(snapshotWith([{ id: 'p1' }]))).toBe(true);
    expect(isUsableSnapshot(snapshotWith([]))).toBe(false);
    expect(isUsableSnapshot({ localStorage: {}, indexedDB: {} })).toBe(false);
    expect(isUsableSnapshot(null)).toBe(false);
  });

  it('refills a wiped app from the backup', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(snapshotWith([{ id: 'p1' }])));
    vi.stubGlobal('fetch', fetchMock);

    expect(await restoreIfEmpty(SETTINGS)).toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(RESTORE, expect.objectContaining({ cache: 'no-store' }));
    expect(localStorage.getItem('iptv_theme')).toBe('"t1"');
    const db = await openPersistenceDb();
    const favorites = await requestResult(db!.transaction('favorites').objectStore('favorites').getAll());
    expect(favorites).toEqual([{ key: 'favorite:ch1', value: 'ch1' }]);
  });

  it('leaves an app that still has its data alone', async () => {
    localStorage.setItem('iptv_theme', '"t2"');
    const fetchMock = vi.fn(async () => jsonResponse(snapshotWith([{ id: 'p1' }])));
    vi.stubGlobal('fetch', fetchMock);

    expect(await restoreIfEmpty(SETTINGS)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not refill an app the user reset on purpose', async () => {
    markRestoreSkipped();
    const fetchMock = vi.fn(async () => jsonResponse(snapshotWith([{ id: 'p1' }])));
    vi.stubGlobal('fetch', fetchMock);

    expect(await restoreIfEmpty(SETTINGS)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not restore an empty backup', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(snapshotWith([]))));
    expect(await restoreIfEmpty(SETTINGS)).toBe(false);
    expect(localStorage.length).toBe(0);
  });

  it('starts normally when the backup cannot be downloaded', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    expect(await restoreIfEmpty(SETTINGS)).toBe(false);
  });

  it('snapshots localStorage and user stores in the restore format', async () => {
    localStorage.setItem('iptv_playlists', JSON.stringify([{ id: 'p1' }]));
    markRestoreSkipped();
    const db = await openPersistenceDb();
    const tx = db!.transaction('favorites', 'readwrite');
    const done = transactionDone(tx);
    tx.objectStore('favorites').put({ key: 'favorite:ch2', value: 'ch2' });
    await done;

    const snapshot = await readSnapshot();

    expect(Object.keys(snapshot.localStorage)).toEqual(['iptv_playlists']);
    expect(snapshot.indexedDB.favorites).toEqual({
      keyPath: 'key', keys: ['favorite:ch2'], values: [{ key: 'favorite:ch2', value: 'ch2' }],
    });
    expect(snapshot.indexedDB['epg-cache']).toBeUndefined();
  });

  it('sends a changed configuration once and never an empty one', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    let current = snapshotWith([]);
    const backup = new ConfigBackup({ webhookUrl: () => WEBHOOK, appVersion: '1.0.0', snapshot: async () => current });

    expect(await backup.check()).toBe('empty');
    current = snapshotWith([{ id: 'p1' }]);
    expect(await backup.check()).toBe('sent');
    current = { ...current, savedAt: '2026-01-02T00:00:00.000Z' };
    expect(await backup.check()).toBe('unchanged');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string) as {
      event: string; backup: ConfigSnapshot;
    };
    expect(body.event).toBe('backup');
    expect(body.backup.localStorage.iptv_playlists).toBe(JSON.stringify([{ id: 'p1' }]));
  });

  it('retries after a failed post', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue(new Response('', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const snap = snapshotWith([{ id: 'p1' }]);
    const backup = new ConfigBackup({ webhookUrl: () => WEBHOOK, appVersion: '1.0.0', snapshot: async () => snap });

    expect(await backup.check()).toBe('failed');
    expect(await backup.check()).toBe('sent');
  });

  it('stays off without a webhook', async () => {
    const backup = new ConfigBackup({ webhookUrl: () => '', appVersion: '1.0.0', snapshot: async () => snapshotWith([{ id: 'p1' }]) });
    expect(await backup.check()).toBe('off');
  });
});
