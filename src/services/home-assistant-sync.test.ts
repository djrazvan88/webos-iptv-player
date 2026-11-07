import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HomeAssistantSync, isValidWebhookUrl, type HaCatalog } from './home-assistant-sync';

const URL_A = 'http://host:8123/api/webhook/iptv_a1';

function catalog(groups = 1): HaCatalog {
  return {
    groups: Array.from({ length: groups }, (_, i) => ({ name: `g${String(i)}`, label: `g${String(i)}`, count: 1 })),
    channels: [{ k: 'k1', n: 'Alpha', g: 'g0', num: 1 }],
    movies: [{ id: '1', name: 'Bravo' }],
    series: [],
  };
}

describe('HomeAssistantSync', () => {
  let url: string;
  let signature: unknown[];
  let current: HaCatalog | null;
  let fetchMock: ReturnType<typeof vi.fn>;
  let sync: HomeAssistantSync;

  beforeEach(() => {
    url = URL_A;
    signature = [1];
    current = catalog();
    fetchMock = vi.fn(() => Promise.resolve(new Response('', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    sync = new HomeAssistantSync({
      webhookUrl: () => url,
      signature: () => signature,
      catalog: () => Promise.resolve(current),
      appVersion: '9.9.9',
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('posts the catalog as JSON to the webhook', async () => {
    expect(await sync.check()).toBe('sent');
    const [target, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(target).toBe(URL_A);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ app: 'com.lennylxx.iptv', version: '9.9.9', ...catalog() });
    expect(console.log).toHaveBeenCalledWith('[HaSync]', 'Catalog sent to Home Assistant',
      'event=ha.sync.sent', 'groups=1', 'channels=1', 'movies=1', 'series=0');
  });

  it('stays quiet while nothing changed, and resends only a changed catalog', async () => {
    await sync.check();
    expect(await sync.check()).toBe('unchanged');

    signature = [2];
    expect(await sync.check()).toBe('unchanged');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    signature = [3];
    current = catalog(2);
    expect(await sync.check()).toBe('sent');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a failed post on the next check and logs the failure once', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response('', { status: 503 })));
    expect(await sync.check()).toBe('failed');
    expect(await sync.check()).toBe('failed');
    expect(console.warn).toHaveBeenCalledTimes(1);

    fetchMock.mockImplementation(() => Promise.resolve(new Response('', { status: 200 })));
    expect(await sync.check()).toBe('sent');
  });

  it('does nothing without a valid webhook URL, and resends after the URL changes', async () => {
    url = '';
    expect(await sync.check()).toBe('off');
    url = 'http://host:8123/api/states';
    expect(await sync.check()).toBe('off');
    expect(fetchMock).not.toHaveBeenCalled();

    url = URL_A;
    await sync.check();
    url = 'http://host:8123/api/webhook/iptv_b2';
    expect(await sync.check()).toBe('sent');
  });

  it('skips a check while the catalog is not ready', async () => {
    current = null;
    expect(await sync.check()).toBe('unchanged');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('isValidWebhookUrl', () => {
  it('accepts only a Home Assistant webhook endpoint', () => {
    expect(isValidWebhookUrl(URL_A)).toBe(true);
    expect(isValidWebhookUrl('https://host/api/webhook/x-1_2')).toBe(true);
    expect(isValidWebhookUrl('http://host:8123/api/webhook/')).toBe(false);
    expect(isValidWebhookUrl('ftp://host/api/webhook/x')).toBe(false);
    expect(isValidWebhookUrl('http://host/api/webhook/x?y=1')).toBe(false);
  });
});

describe('notifyHomeAssistant', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('posts the event and reports whether Home Assistant took it', async () => {
    const { notifyHomeAssistant } = await import('./home-assistant-sync');
    const fetchMock = vi.fn(() => Promise.resolve(new Response('', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    expect(await notifyHomeAssistant(URL_A, 'sleep', '9.9.9')).toBe(true);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(init.body as string)).toEqual({ app: 'com.lennylxx.iptv', version: '9.9.9', event: 'sleep' });

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockImplementation(() => Promise.resolve(new Response('', { status: 500 })));
    expect(await notifyHomeAssistant(URL_A, 'sleep', '9.9.9')).toBe(false);
    expect(await notifyHomeAssistant('', 'sleep', '9.9.9')).toBe(false);
  });
});
