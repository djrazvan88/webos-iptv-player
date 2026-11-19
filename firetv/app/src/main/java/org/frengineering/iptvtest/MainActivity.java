package org.frengineering.iptvtest;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.view.KeyEvent;
import android.view.SurfaceView;
import android.view.View;
import android.widget.FrameLayout;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.Charset;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * IPTV per Fire TV: interfaccia web (fork webos-iptv-player) + riproduzione nativa ExoPlayer.
 * - interfaccia (build preview del fork) negli asset, servita come http://app.local/
 * - http://app.local/__p/<http|https>/<host>/<percorso>: proxy nativo con header CORS
 * - webhook di Home Assistant: solo quello di questa TV, via FireNative.httpPost (assets/fire.json)
 * - statistiche dell'HUD su logcat (tag IPTVTEST) e in files/iptvtest_log.jsonl
 */
public class MainActivity extends Activity {
  static final String TAG = "IPTVTEST";
  static final String HOST = "app.local";
  static final String HOME = "http://" + HOST + "/index.html";
  private WebView web;
  private String url;
  private FileOutputStream logOut;
  private NativePlayer nativePlayer;

  @Override protected void onCreate(Bundle b) {
    super.onCreate(b);
    getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    WebView.setWebContentsDebuggingEnabled(true);
    try { logOut = openFileOutput("iptvtest_log.jsonl", MODE_APPEND); } catch (Exception e) { /* */ }
    web = new WebView(this);
    // Trasparente: su Fire TV il video MSE può finire in un overlay sotto la WebView
    getWindow().getDecorView().setBackgroundColor(Color.BLACK);
    web.setBackgroundColor(Color.TRANSPARENT);
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setDatabaseEnabled(true);
    s.setMediaPlaybackRequiresUserGesture(false);
    s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
    s.setUseWideViewPort(true);
    s.setLoadWithOverviewMode(true);
    s.setSupportZoom(false);
    s.setBuiltInZoomControls(false);
    s.setCacheMode(WebSettings.LOAD_NO_CACHE);
    web.addJavascriptInterface(new FireLog(), "FireLog");
    web.setWebViewClient(new Client());
    web.setWebChromeClient(new WebChromeClient());
    web.setFocusable(true);
    web.setFocusableInTouchMode(true);
    // Video nativo (ExoPlayer) in una SurfaceView sotto la WebView trasparente
    FrameLayout root = new FrameLayout(this);
    root.setBackgroundColor(Color.BLACK);
    SurfaceView surface = new SurfaceView(this);
    surface.setVisibility(View.INVISIBLE);
    root.addView(surface, new FrameLayout.LayoutParams(1920, 1080));
    root.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
    nativePlayer = new NativePlayer(this, web, surface, s.getUserAgentString());
    web.addJavascriptInterface(nativePlayer, "FireNative");
    nativePlayer.setWebhook(readWebhook());
    SharedPreferences pr = getSharedPreferences("cfg", MODE_PRIVATE);
    if (getIntent() != null && getIntent().hasExtra("debug"))
      pr.edit().putBoolean("debug", getIntent().getBooleanExtra("debug", false)).apply();
    nativePlayer.setDebug(pr.getBoolean("debug", false));
    nativePlayer.setLaunch(params(getIntent()));
    setContentView(root);
    web.requestFocus();
    hideBars();
    load(getIntent());
  }

  class FireLog {
    @JavascriptInterface public void log(String json) {
      if (!nativePlayer.isDebug() && !json.contains("\"ev\"")) return;
      Log.i(TAG, json);
      try { if (logOut != null && nativePlayer.isDebug()) { logOut.write((json + "\n").getBytes("UTF-8")); logOut.flush(); } } catch (Exception e) { /* */ }
    }
  }

  @Override protected void onNewIntent(Intent i) {
    super.onNewIntent(i); setIntent(i);
    if (i.hasExtra("debug")) {
      boolean d = i.getBooleanExtra("debug", false);
      getSharedPreferences("cfg", MODE_PRIVATE).edit().putBoolean("debug", d).apply();
      nativePlayer.setDebug(d);
    }
    String p = params(i);
    if (p != null && url != null) { nativePlayer.relaunch(p); return; }
    if (p != null) nativePlayer.setLaunch(p);
    load(i);
  }

  /** Parametri di apertura da Home Assistant: --es params64 <base64 JSON> oppure --es params <JSON>. */
  private static String params(Intent i) {
    if (i == null) return null;
    String b64 = i.getStringExtra("params64");
    if (b64 != null && !b64.isEmpty()) {
      try { return new String(android.util.Base64.decode(b64, android.util.Base64.DEFAULT), "UTF-8"); }
      catch (Exception e) { Log.w(TAG, "params64 non valido"); }
    }
    String p = i.getStringExtra("params");
    return p == null || p.isEmpty() ? null : p;
  }

  private String readWebhook() {
    try {
      String json = readAll(getAssets().open("fire.json"));
      return new org.json.JSONObject(json).optString("webhookUrl", "");
    } catch (Exception e) { return ""; }
  }

  private void load(Intent i) {
    SharedPreferences p = getSharedPreferences("cfg", MODE_PRIVATE);
    String u = i != null ? i.getStringExtra("url") : null;
    if (u != null && u.length() > 0) p.edit().putString("url2", u).apply(); else u = p.getString("url2", HOME);
    boolean reload = i != null && i.getBooleanExtra("reload", false);
    if (reload || !u.equals(url)) { url = u; web.loadUrl(u); }
  }

  // ---------------------------------------------------------------- intercettazione

  class Client extends WebViewClient {
    @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
      Uri u = r.getUrl();
      if (!HOST.equals(u.getHost())) return null;
      String path = u.getEncodedPath() == null ? "/" : u.getEncodedPath();
      try {
        if (path.startsWith("/__p/")) return proxy(r, path, u.getEncodedQuery());
        return asset(path);
      } catch (Exception e) {
        Log.w(TAG, "intercept " + path + ": " + e);
        return error(502, e.toString());
      }
    }
  }

  private static final Map<String, String> MIME = new HashMap<>();
  static {
    MIME.put("html", "text/html"); MIME.put("js", "text/javascript"); MIME.put("css", "text/css");
    MIME.put("json", "application/json"); MIME.put("png", "image/png"); MIME.put("svg", "image/svg+xml");
    MIME.put("woff2", "font/woff2"); MIME.put("woff", "font/woff"); MIME.put("ttf", "font/ttf");
    MIME.put("jpg", "image/jpeg"); MIME.put("webp", "image/webp"); MIME.put("wasm", "application/wasm");
  }

  private Map<String, String> cors() {
    Map<String, String> h = new HashMap<>();
    h.put("Access-Control-Allow-Origin", "*");
    h.put("Access-Control-Allow-Headers", "*");
    h.put("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
    h.put("Access-Control-Expose-Headers", "Content-Length, Content-Range, Content-Type, Accept-Ranges");
    h.put("Cache-Control", "no-store");
    return h;
  }

  private WebResourceResponse error(int code, String msg) {
    return new WebResourceResponse("text/plain", "utf-8", code, code == 204 ? "No Content" : "Error", cors(),
      new ByteArrayInputStream(msg.getBytes(Charset.forName("UTF-8"))));
  }

  private WebResourceResponse asset(String path) throws Exception {
    if (path.equals("/")) path = "/index.html";
    String file = "www" + Uri.decode(path);
    String ext = file.substring(file.lastIndexOf('.') + 1).toLowerCase();
    String mime = MIME.containsKey(ext) ? MIME.get(ext) : "application/octet-stream";
    InputStream in;
    try { in = getAssets().open(file); } catch (Exception e) { return error(404, "not found"); }
    return new WebResourceResponse(mime, mime.startsWith("text") || ext.equals("json") ? "utf-8" : null,
      200, "OK", cors(), in);
  }

  private WebResourceResponse proxy(WebResourceRequest r, String path, String query) throws Exception {
    // /__p/<scheme>/<host[:port]>/<resto>
    String[] parts = path.split("/", 5);
    if (parts.length < 4) return error(400, "bad proxy path");
    String scheme = parts[2], host = parts[3], rest = parts.length > 4 ? "/" + parts[4] : "/";
    if (rest.contains("/api/webhook/")) { Log.i(TAG, "{\"ev\":\"webhook bloccato\"}"); return error(204, ""); }
    String method = r.getMethod();
    if ("OPTIONS".equals(method)) return error(204, "");
    if (!"GET".equals(method) && !"HEAD".equals(method)) return error(204, ""); // nessun corpo disponibile
    String target = scheme + "://" + host + rest + (query != null ? "?" + query : "");

    HttpURLConnection c = null;
    String cur = target;
    for (int hop = 0; hop < 6; hop++) {
      c = (HttpURLConnection) new URL(cur).openConnection();
      c.setInstanceFollowRedirects(false);
      c.setConnectTimeout(15000);
      c.setReadTimeout(30000);
      c.setRequestMethod(method);
      for (Map.Entry<String, String> h : r.getRequestHeaders().entrySet()) {
        String k = h.getKey().toLowerCase();
        if (k.equals("range") || k.equals("user-agent") || k.equals("accept") || k.equals("if-range"))
          c.setRequestProperty(h.getKey(), h.getValue());
      }
      int code = c.getResponseCode();
      if (code >= 300 && code < 400 && c.getHeaderField("Location") != null) {
        cur = new URL(new URL(cur), c.getHeaderField("Location")).toString();
        c.disconnect();
        continue;
      }
      break;
    }
    int code = c.getResponseCode();
    InputStream in = code >= 400 ? c.getErrorStream() : c.getInputStream();
    if (in == null) in = new ByteArrayInputStream(new byte[0]);
    Map<String, String> h = cors();
    for (String k : new String[]{"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Last-Modified", "ETag"}) {
      String val = c.getHeaderField(k);
      if (val != null) h.put(k, val);
    }
    String ct = c.getContentType() == null ? "application/octet-stream" : c.getContentType();
    String mime = ct.split(";")[0].trim();
    // Playlist HLS dopo un redirect: rendo assoluti gli URI relativi (la WebView vede ancora l'URL originale)
    boolean hls = mime.contains("mpegurl") || cur.contains(".m3u8");
    if (hls && !cur.equals(target) && code < 300) {
      String text = readAll(in);
      String fixed = absolutize(text, new URL(cur));
      byte[] bytes = fixed.getBytes("UTF-8");
      h.put("Content-Length", String.valueOf(bytes.length));
      return new WebResourceResponse(mime, "utf-8", code, reason(code), h, new ByteArrayInputStream(bytes));
    }
    final String label = rest.replaceAll("/(live|movie|series|timeshift)/[^/]+/[^/]+/", "/$1/***/***/");
    Log.i(TAG, "{\"ev\":\"proxy.open\",\"detail\":\"" + code + " " + mime + " " + label + "\"}");
    return new WebResourceResponse(mime, null, code, reason(code), h, new Counted(in, label));
  }

  /** Conta i byte e scrive su logcat quando il flusso finisce o viene chiuso. */
  static class Counted extends java.io.FilterInputStream {
    final String label; final long t0 = System.currentTimeMillis(); long n = 0; boolean done = false;
    Counted(InputStream in, String label) { super(in); this.label = label; }
    void end(String why) {
      if (done) return; done = true;
      Log.i(TAG, "{\"ev\":\"proxy." + why + "\",\"detail\":\"" + label + " " + n / 1024 + " KB in "
        + (System.currentTimeMillis() - t0) / 1000.0 + " s\"}");
    }
    @Override public int read() throws java.io.IOException {
      try { int b = super.read(); if (b < 0) end("eof"); else n++; return b; }
      catch (java.io.IOException e) { end("errore " + e.getClass().getSimpleName()); throw e; }
    }
    @Override public int read(byte[] b, int o, int l) throws java.io.IOException {
      try { int r = super.read(b, o, l); if (r < 0) end("eof"); else n += r; return r; }
      catch (java.io.IOException e) { end("errore " + e.getClass().getSimpleName() + " " + e.getMessage()); throw e; }
    }
    @Override public void close() throws java.io.IOException { end("chiuso"); super.close(); }
  }

  private static String reason(int code) {
    switch (code) {
      case 200: return "OK"; case 206: return "Partial Content"; case 204: return "No Content";
      case 404: return "Not Found"; case 403: return "Forbidden"; default: return "Status";
    }
  }

  private static String readAll(InputStream in) throws Exception {
    ByteArrayOutputStream o = new ByteArrayOutputStream();
    byte[] buf = new byte[16384]; int n;
    while ((n = in.read(buf)) > 0) o.write(buf, 0, n);
    in.close();
    return o.toString("UTF-8");
  }

  private static String absolutize(String m3u, URL base) throws Exception {
    StringBuilder sb = new StringBuilder();
    for (String line : m3u.split("\n", -1)) {
      String t = line.trim();
      if (t.length() > 0 && !t.startsWith("#")) {
        sb.append(new URL(base, t).toString());
      } else if (t.contains("URI=\"")) {
        int a = line.indexOf("URI=\"") + 5, z = line.indexOf('"', a);
        sb.append(line, 0, a).append(new URL(base, line.substring(a, z)).toString()).append(line.substring(z));
      } else {
        sb.append(line);
      }
      sb.append('\n');
    }
    return sb.substring(0, sb.length() - 1);
  }

  // ---------------------------------------------------------------- tasti

  private void hideBars() {
    getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_FULLSCREEN
      | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
  }

  // Tasto Android -> keyCode atteso dall'app (codici webOS)
  private int map(int kc) {
    switch (kc) {
      case KeyEvent.KEYCODE_BACK: return 27;               // Escape = Back
      case KeyEvent.KEYCODE_MEDIA_REWIND: return 412;
      case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD: return 417;
      case KeyEvent.KEYCODE_MEDIA_PLAY: return 415;
      case KeyEvent.KEYCODE_MEDIA_PAUSE: return 19;
      case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE: return -1;   // deciso in JS: play o pausa
      case KeyEvent.KEYCODE_MENU: return 48;               // tasto 0 = canale precedente
      default: return 0;
    }
  }

  @Override public boolean dispatchKeyEvent(KeyEvent e) {
    int c = map(e.getKeyCode());
    if (c == 0) return super.dispatchKeyEvent(e);
    if (e.getAction() == KeyEvent.ACTION_DOWN && e.getRepeatCount() == 0) {
      String code = c == -1
        ? "(function(){var v=document.querySelector('video');return v&&!v.paused?19:415})()"
        : String.valueOf(c);
      web.evaluateJavascript("(function(c){var t=document.activeElement||document.body;"
        + "['keydown','keyup'].forEach(function(ty){var e=new KeyboardEvent(ty,{bubbles:true,cancelable:true,"
        + "key:c==27?'Escape':'Unidentified'});Object.defineProperty(e,'keyCode',{get:function(){return c}});"
        + "Object.defineProperty(e,'which',{get:function(){return c}});t.dispatchEvent(e);});})(" + code + ")", null);
    }
    return true;
  }

  @Override protected void onResume() { super.onResume(); web.onResume(); hideBars(); }
  @Override protected void onPause() { if (nativePlayer != null) nativePlayer.pause(); web.onPause(); super.onPause(); }
  @Override protected void onDestroy() { if (nativePlayer != null) nativePlayer.release(); web.destroy(); super.onDestroy(); }
}
