import { test, expect, neuterVideo, type Page } from './helpers';

// Home automation: launch params open a group, a channel, or a catalog
// category; the visible catalog is posted to a Home Assistant webhook.

const M3U = [
  '#EXTM3U',
  '#EXTINF:-1 group-title="Alpha",Channel One',
  'http://host/one.m3u8',
  '#EXTINF:-1 group-title="Alpha",Channel Two',
  'http://host/two.m3u8',
  '#EXTINF:-1 group-title="Bravo (4K)",Channel Three',
  'http://host/three.m3u8',
].join('\n');

const WEBHOOK = 'http://ha.example.com:8123/api/webhook/iptv_t1';

async function seed(page: Page, webhook = ''): Promise<void> {
  await page.route('http://127.0.0.1:8890/**', route => route.abort());
  await page.route('**/get.php*', route => route.fulfill({ contentType: 'application/x-mpegurl', body: M3U }));
  await page.route('**/xmltv.php*', route => route.fulfill({ contentType: 'application/xml', body: '<tv></tv>' }));
  await page.route('**/player_api.php*', route => {
    const url = new URL(route.request().url());
    const action = url.searchParams.get('action');
    let body: unknown = {};
    if (action === 'get_vod_categories') {
      body = [{ category_id: '1', category_name: 'Charlie' }, { category_id: '2', category_name: 'Delta Movies' }];
    } else if (action === 'get_series_categories') {
      body = [{ category_id: '7', category_name: 'Echo' }];
    } else if (action === 'get_vod_streams' || action === 'get_series') {
      body = [{ stream_id: 100, series_id: 200, name: 'Title 1', stream_icon: '', cover: '',
        container_extension: 'mp4', category_id: url.searchParams.get('category_id') ?? '1', added: '1700000000' }];
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.addInitScript((hook) => {
    localStorage.setItem('iptv_playlists', JSON.stringify([{
      id: 'x1', name: 'Account 1', url: 'http://host', source: 'xtream',
      xtream: { username: 'u', password: 'p' },
    }]));
    if (hook) localStorage.setItem('iptv_ha_webhook_url', JSON.stringify(hook));
  }, webhook);
  await neuterVideo(page);
}

async function relaunch(page: Page, params: unknown): Promise<void> {
  await page.evaluate((detail) => {
    document.dispatchEvent(new CustomEvent('webOSRelaunch', { detail }));
  }, params);
}

test('a relaunch opens a group by name, flag and case aside', async ({ page }) => {
  await seed(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  await relaunch(page, { iptv: { open: 'group', group: 'bravo (4k)' } });
  await expect(page.locator('.group-item.active')).toContainText('Bravo (4K)');
  await expect(page.locator('.channel-main .channel-item.focused')).toContainText('Channel Three');
  await expect(page.locator('.focused')).toHaveCount(1);
});

test('a relaunch tunes a channel by name or number, and says so when missing', async ({ page }) => {
  await seed(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  await relaunch(page, { iptv: { open: 'channel', channel: 'Channel Two' } });
  await expect(page.locator('#view-player')).toBeVisible();
  await expect(page.locator('.osd-channel-name')).toHaveText('Channel Two');

  await relaunch(page, { iptv: { open: 'channel', channel: '3' } });
  await expect(page.locator('.osd-channel-name')).toHaveText('Channel Three');

  await relaunch(page, { iptv: { open: 'channel', channel: 'Channel Nine' } });
  await expect(page.locator('.toast')).toContainText('Not found: Channel Nine');
});

test('a relaunch opens a movie category grid, and Back returns to browse', async ({ page }) => {
  await seed(page);
  await page.goto('/');
  await expect(page.locator('#view-channels')).toBeVisible();

  await relaunch(page, { iptv: { open: 'movies', category: 'delta movies' } });
  await expect(page.locator('#view-movies')).toBeVisible();
  await expect(page.locator('#view-movies .catalog-grid-title')).toContainText('Delta Movies');
  await expect(page.locator('#view-movies .catalog-grid-cell').first()).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.locator('#view-movies .catalog-layer-browse')).toBeVisible();
});

test('the visible catalog is posted to the Home Assistant webhook', async ({ page }) => {
  await seed(page, WEBHOOK);
  const posted = new Promise<Record<string, unknown>>((resolve) => {
    void page.route(WEBHOOK, async (route) => {
      resolve(JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>);
      await route.fulfill({ status: 200, body: '' });
    });
  });
  await page.goto('/');

  const body = await posted;
  expect(body.app).toBe('com.lennylxx.iptv');
  expect(body.groups).toEqual([
    { name: 'Alpha', label: 'Alpha', count: 2 },
    { name: 'Bravo (4K)', label: 'Bravo (4K)', count: 1 },
  ]);
  expect((body.channels as { n: string; g: string; num: number }[]).map(c => [c.num, c.n, c.g])).toEqual([
    [1, 'Channel One', 'Alpha'], [2, 'Channel Two', 'Alpha'], [3, 'Channel Three', 'Bravo (4K)'],
  ]);
  expect(body.movies).toEqual([{ id: '1', name: 'Charlie' }, { id: '2', name: 'Delta Movies' }]);
  expect(body.series).toEqual([{ id: '7', name: 'Echo' }]);
});
