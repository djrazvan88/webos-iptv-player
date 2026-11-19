# IPTV Player per Fire TV — creato da Filip Razvan

Guscio Android (Fire OS / Android TV) per questa stessa app: l'interfaccia è la build normale del fork,
la riproduzione passa da Media3 ExoPlayer (decodifica hardware, audio Dolby AC3/E-AC3 verso la TV).

- `web/firetv-shim.js` — scala 1920 px, proxy CORS verso il guscio, POST solo verso il webhook HA della TV
- `web/firetv-native.js` — `<video>` virtuale pilotato da ExoPlayer, parametri d'avvio, `window.close`, SHA-256 per il PIN
- `app/` — progetto Gradle (WebView trasparente sopra una SurfaceView, `NativePlayer`, proxy `http://app.local/__p/...`)
- `ha/iptv_fire.yaml` — package Home Assistant (apertura gruppi/canali/film/serie, timer → spegnimento)

## Build
Richiede JDK 17+, Gradle 8.9, Android SDK (platform 34). File locali non versionati:
- `test.keystore` (alias `fr`): `keytool -genkeypair -keystore test.keystore -alias fr -keyalg RSA -keysize 2048 -validity 10000`
  (password come in `app/build.gradle`); con una chiave diversa l'aggiornamento su TV richiede di disinstallare prima.
- `ha-backup.json` (facoltativo): `{"restoreUrl": "..."}` per il ripristino automatico della configurazione
- `app/src/main/assets/fire.json` (facoltativo): `{"webhookUrl": "http://<HA>:8123/api/webhook/<id>"}`

```
cd firetv && bash build_fire.sh
adb connect <ip-tv>:5555 && adb install -r iptv-player-fire.apk
```

## Comandi utili
- statistiche a schermo: `adb shell am start -n org.frengineering.iptvtest/.MainActivity --ez debug true`
- aprire un canale: `--es params '{"iptv":{"open":"channel","channel":"Rai 1 FHD"}}'` (oppure `--es params64 <base64>`)
