#!/bin/bash
# Build completo IPTV Player per Fire TV
#  1) interfaccia: fork webos-iptv-player (build normale, non preview)
#  2) asset: dist + firetv-shim.js + firetv-native.js + ha-backup.json (solo restoreUrl)
#  3) APK Gradle (Media3 ExoPlayer), firmato con test.keystore
# Uso: FORK=/percorso/webos-iptv-player HA_BACKUP=/percorso/ha-backup.json bash build_fire.sh
set -e
cd "$(dirname "$0")"
FORK=${FORK:-..}
HA_BACKUP=${HA_BACKUP:-ha-backup.json}
(cd "$FORK" && node esbuild.config.mjs)
A=app/src/main/assets/www
rm -rf "$A" && cp -r "$FORK/dist" "$A"
cp web/firetv-shim.js web/firetv-native.js "$A/js/"
python3 - "$A" "$HA_BACKUP" <<'P'
import sys, json
a, hb = sys.argv[1], sys.argv[2]
h = open(a + '/index.html').read()
meta = '<meta name="viewport" content="width=1920, height=1080, initial-scale=1.0">'
h = h.replace(meta, meta + '\n  <script src="js/firetv-shim.js"></script>\n  <script src="js/firetv-native.js"></script>', 1)
h = h.replace('<title>webOS IPTV Player</title>', '<title>IPTV Player</title>')
open(a + '/index.html', 'w').write(h)
try:
    j = json.load(open(hb))
    json.dump({'restoreUrl': j.get('restoreUrl', ''), 'webhookUrl': ''}, open(a + '/ha-backup.json', 'w'))
except Exception as e:
    print('ha-backup.json non trovato: niente ripristino automatico', e)
P
[ -f app/src/main/assets/fire.json ] || echo '{"webhookUrl":""}' > app/src/main/assets/fire.json
gradle :app:assembleRelease -q
cp app/build/outputs/apk/release/app-release.apk iptv-player-fire.apk
echo "APK: $(pwd)/iptv-player-fire.apk"
