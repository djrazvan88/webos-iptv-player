package org.frengineering.iptvtest;

import android.content.Context;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.SurfaceView;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.FrameLayout;

import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.Format;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.PlaybackParameters;
import androidx.media3.common.Player;
import androidx.media3.common.TrackGroup;
import androidx.media3.common.TrackSelectionOverride;
import androidx.media3.common.Tracks;
import androidx.media3.common.VideoSize;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.datasource.HttpDataSource;
import androidx.media3.exoplayer.DecoderCounters;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.extractor.DefaultExtractorsFactory;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Player nativo (Media3 ExoPlayer) sotto la WebView trasparente.
 * JS → Java: window.FireNative.* (load, play, pause, seek, stop, setRect, ...)
 * Java → JS: window.__fireNative.onEvent({...})
 */
@androidx.annotation.OptIn(markerClass = androidx.media3.common.util.UnstableApi.class)
public class NativePlayer implements Player.Listener {
  static final String TAG = "IPTVTEST";
  private final Context ctx;
  private final WebView web;
  private final SurfaceView surface;
  private final Handler main = new Handler(Looper.getMainLooper());
  private ExoPlayer player;
  private String userAgent;
  private int session = 0;
  // rettangolo in pixel CSS e larghezza viewport CSS
  private float rx, ry, rw, rh, cssWidth = 1920;
  private String fit = "contain";
  private boolean firstFrame = false;
  private int lastState = -1;

  NativePlayer(Context ctx, WebView web, SurfaceView surface, String ua) {
    this.ctx = ctx; this.web = web; this.surface = surface; this.userAgent = ua;
  }

  private ExoPlayer ensurePlayer() {
    if (player != null) return player;
    DefaultRenderersFactory rf = new DefaultRenderersFactory(ctx)
      .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_OFF)
      .setEnableDecoderFallback(true);
    HttpDataSource.Factory http = new DefaultHttpDataSource.Factory()
      .setAllowCrossProtocolRedirects(true)
      .setConnectTimeoutMs(15000)
      .setReadTimeoutMs(20000)
      .setUserAgent(userAgent);
    DefaultExtractorsFactory ef = new DefaultExtractorsFactory()
      .setConstantBitrateSeekingEnabled(true);
    DefaultMediaSourceFactory msf = new DefaultMediaSourceFactory(http, ef);
    DefaultLoadControl lc = new DefaultLoadControl.Builder()
      .setBufferDurationsMs(15000, 50000, 1500, 3000)
      .build();
    player = new ExoPlayer.Builder(ctx, rf)
      .setMediaSourceFactory(msf)
      .setLoadControl(lc)
      .setAudioAttributes(new AudioAttributes.Builder()
        .setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(), true)
      .build();
    player.setVideoSurfaceView(surface);
    player.addListener(this);
    main.post(tick);
    main.post(stats);
    return player;
  }

  // ------------------------------------------------------------------ bridge JS

  @JavascriptInterface public void load(final String url, final String mime, final double startSec, final boolean autoplay) {
    main.post(() -> {
      ExoPlayer p = ensurePlayer();
      session++;
      firstFrame = false;
      lastState = -1;
      MediaItem.Builder b = new MediaItem.Builder().setUri(Uri.parse(url));
      String m = mapMime(mime, url);
      if (m != null) b.setMimeType(m);
      p.setMediaItem(b.build(), startSec > 0 ? (long) (startSec * 1000) : C.TIME_UNSET);
      p.setPlayWhenReady(autoplay);
      p.prepare();
      surface.setVisibility(View.VISIBLE);
      Log.i(TAG, "{\"ev\":\"native.load\",\"detail\":\"" + (m == null ? "auto" : m) + " " + redact(url) + "\"}");
    });
  }

  @JavascriptInterface public void play() { main.post(() -> { if (player != null) { if (player.getPlaybackState() == Player.STATE_IDLE) player.prepare(); player.setPlayWhenReady(true); } }); }
  @JavascriptInterface public void pause() { main.post(() -> { if (player != null) player.setPlayWhenReady(false); }); }
  @JavascriptInterface public void seek(final double sec) { main.post(() -> { if (player != null) player.seekTo((long) (sec * 1000)); }); }
  @JavascriptInterface public void setVolume(final double v) { main.post(() -> { if (player != null) player.setVolume((float) v); }); }
  @JavascriptInterface public void setRate(final double r) { main.post(() -> { if (player != null) player.setPlaybackParameters(new PlaybackParameters((float) r)); }); }

  @JavascriptInterface public void stop() {
    main.post(() -> {
      session++;
      if (player != null) { player.stop(); player.clearMediaItems(); }
      surface.setVisibility(View.INVISIBLE);
    });
  }

  @JavascriptInterface public void setRect(final double x, final double y, final double w, final double h, final double vw, final String objectFit) {
    main.post(() -> {
      rx = (float) x; ry = (float) y; rw = (float) w; rh = (float) h; cssWidth = (float) vw;
      fit = objectFit == null ? "contain" : objectFit;
      layoutSurface();
    });
  }

  @JavascriptInterface public void selectAudio(final int index) {
    main.post(() -> {
      if (player == null) return;
      int n = 0;
      for (Tracks.Group g : player.getCurrentTracks().getGroups()) {
        if (g.getType() != C.TRACK_TYPE_AUDIO) continue;
        for (int i = 0; i < g.length; i++) {
          if (n == index) {
            player.setTrackSelectionParameters(player.getTrackSelectionParameters().buildUpon()
              .setOverrideForType(new TrackSelectionOverride(g.getMediaTrackGroup(), i)).build());
            return;
          }
          n++;
        }
      }
    });
  }

  // ------------------------------------------------------------------ avvio con parametri, debug, webhook

  private String coldParams;
  private boolean debug;
  private String webhookUrl = "";

  void setLaunch(final String params) {
    coldParams = params;
    // resta disponibile anche a un eventuale ricaricamento della pagina (ripristino), poi scade
    if (params != null) main.postDelayed(() -> { if (params.equals(coldParams)) coldParams = null; }, 20000);
  }
  void setDebug(boolean d) { debug = d; }
  void setWebhook(String url) { webhookUrl = url == null ? "" : url; }

  /** Parametri di avvio a freddo (stesso formato di PalmSystem.launchParams su webOS). */
  @JavascriptInterface public String launchParams() { String p = coldParams; return p == null ? "" : p; }
  @JavascriptInterface public boolean isDebug() { return debug; }
  @JavascriptInterface public String webhookUrl() { return webhookUrl; }

  /** Rilancio con app aperta: stesso evento di webOS (webOSRelaunch). */
  void relaunch(final String params) {
    main.post(() -> web.evaluateJavascript("(function(p){try{document.dispatchEvent(new CustomEvent('webOSRelaunch',"
      + "{detail:JSON.parse(p)}))}catch(e){}})(" + JSONObject.quote(params) + ")", null));
  }

  /** POST nativo (la WebView non passa il corpo al proxy): solo verso il webhook di questa TV. */
  @JavascriptInterface public int httpPost(String url, String body, String contentType) {
    if (url == null || !url.equals(webhookUrl) || webhookUrl.isEmpty()) {
      Log.i(TAG, "{\"ev\":\"post bloccato\"}");
      return 204;
    }
    java.net.HttpURLConnection c = null;
    try {
      c = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
      c.setConnectTimeout(3000); c.setReadTimeout(5000);
      c.setRequestMethod("POST"); c.setDoOutput(true);
      c.setRequestProperty("Content-Type", contentType == null || contentType.isEmpty() ? "application/json" : contentType);
      byte[] b = (body == null ? "" : body).getBytes("UTF-8");
      c.setFixedLengthStreamingMode(b.length);
      c.getOutputStream().write(b);
      int code = c.getResponseCode();
      if (debug) Log.i(TAG, "{\"ev\":\"webhook\",\"detail\":\"" + code + " " + b.length + " B\"}");
      return code;
    } catch (Exception e) {
      Log.w(TAG, "{\"ev\":\"webhook errore\",\"detail\":\"" + e.getClass().getSimpleName() + "\"}");
      return 0;
    } finally { if (c != null) c.disconnect(); }
  }

  /** SHA-256 per il PIN genitori: la pagina http://app.local non è un contesto sicuro, quindi niente crypto.subtle. */
  @JavascriptInterface public String sha256(String b64) {
    try {
      byte[] in = android.util.Base64.decode(b64, android.util.Base64.NO_WRAP);
      byte[] out = java.security.MessageDigest.getInstance("SHA-256").digest(in);
      return android.util.Base64.encodeToString(out, android.util.Base64.NO_WRAP);
    } catch (Exception e) { return ""; }
  }

  /** window.close() dell'app (uscita, fine timer): chiude l'attività. */
  @JavascriptInterface public void exit() {
    main.post(() -> {
      if (player != null) player.stop();
      if (ctx instanceof android.app.Activity) ((android.app.Activity) ctx).finish();
    });
  }

  void release() {
    main.removeCallbacksAndMessages(null);
    if (player != null) { player.release(); player = null; }
  }

  // ------------------------------------------------------------------ layout

  private void layoutSurface() {
    int W = web.getWidth(), H = web.getHeight();
    if (W == 0 || cssWidth <= 0) return;
    float s = W / cssWidth;
    float x = rx * s, y = ry * s, w = rw * s, h = rh * s;
    if (w < 2 || h < 2) { surface.setVisibility(View.INVISIBLE); return; }
    if (player != null && player.getCurrentMediaItem() != null) surface.setVisibility(View.VISIBLE);
    VideoSize vs = player != null ? player.getVideoSize() : VideoSize.UNKNOWN;
    if (vs.width > 0 && vs.height > 0 && !"fill".equals(fit)) {
      float ar = vs.width * vs.pixelWidthHeightRatio / vs.height;
      float boxAr = w / h;
      boolean wider = ar > boxAr;
      if ("cover".equals(fit)) wider = !wider;
      float nw = wider ? w : h * ar, nh = wider ? w / ar : h;
      x += (w - nw) / 2; y += (h - nh) / 2; w = nw; h = nh;
    }
    FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(Math.round(w), Math.round(h));
    lp.leftMargin = Math.round(x); lp.topMargin = Math.round(y);
    surface.setLayoutParams(lp);
  }

  // ------------------------------------------------------------------ eventi

  private void emit(JSONObject o) {
    final String js = "window.__fireNative&&window.__fireNative.onEvent(" + o.toString() + ")";
    main.post(() -> web.evaluateJavascript(js, null));
  }

  private JSONObject ev(String type) {
    JSONObject o = new JSONObject();
    try { o.put("type", type); o.put("session", session); } catch (Exception e) { /* */ }
    return o;
  }

  private final Runnable tick = new Runnable() {
    @Override public void run() {
      if (player != null && player.getCurrentMediaItem() != null) {
        try {
          JSONObject o = ev("pos");
          o.put("pos", player.getCurrentPosition() / 1000.0);
          long d = player.getDuration();
          o.put("dur", d == C.TIME_UNSET ? -1 : d / 1000.0);
          o.put("buf", player.getBufferedPosition() / 1000.0);
          o.put("live", player.isCurrentMediaItemLive() || d == C.TIME_UNSET);
          o.put("playing", player.isPlaying());
          emit(o);
        } catch (Exception e) { /* */ }
      }
      main.postDelayed(this, 250);
    }
  };

  private final Runnable stats = new Runnable() {
    @Override public void run() {
      if (player != null && player.getCurrentMediaItem() != null) {
        try {
          JSONObject o = ev("stats");
          Format vf = player.getVideoFormat(), af = player.getAudioFormat();
          DecoderCounters vc = player.getVideoDecoderCounters();
          if (vc != null) {
            vc.ensureUpdated();
            o.put("rendered", vc.renderedOutputBufferCount);
            o.put("dropped", vc.droppedBufferCount);
          }
          if (vf != null) {
            o.put("vcodec", vf.codecs != null ? vf.codecs : vf.sampleMimeType);
            o.put("w", vf.width); o.put("h", vf.height); o.put("fr", vf.frameRate);
          }
          if (af != null) {
            o.put("acodec", af.codecs != null ? af.codecs : af.sampleMimeType);
            o.put("ach", af.channelCount);
          }
          o.put("bufMs", player.getTotalBufferedDuration());
          emit(o);
        } catch (Exception e) { /* */ }
      }
      main.postDelayed(this, 1000);
    }
  };

  @Override public void onPlaybackStateChanged(int state) {
    if (state == lastState) return;
    lastState = state;
    String s = state == Player.STATE_BUFFERING ? "buffering" : state == Player.STATE_READY ? "ready"
      : state == Player.STATE_ENDED ? "ended" : "idle";
    try { JSONObject o = ev("state"); o.put("state", s); emit(o); } catch (Exception e) { /* */ }
  }

  @Override public void onIsPlayingChanged(boolean isPlaying) {
    try { JSONObject o = ev("playing"); o.put("playing", isPlaying); emit(o); } catch (Exception e) { /* */ }
  }

  @Override public void onRenderedFirstFrame() {
    firstFrame = true;
    emit(ev("firstframe"));
  }

  @Override public void onVideoSizeChanged(VideoSize vs) {
    layoutSurface();
    try { JSONObject o = ev("size"); o.put("w", vs.width); o.put("h", vs.height); emit(o); } catch (Exception e) { /* */ }
  }

  @Override public void onTracksChanged(Tracks tracks) {
    try {
      JSONObject o = ev("tracks");
      JSONArray audio = new JSONArray();
      for (Tracks.Group g : tracks.getGroups()) {
        if (g.getType() != C.TRACK_TYPE_AUDIO) continue;
        TrackGroup tg = g.getMediaTrackGroup();
        for (int i = 0; i < g.length; i++) {
          Format f = tg.getFormat(i);
          JSONObject a = new JSONObject();
          a.put("id", f.id == null ? String.valueOf(audio.length()) : f.id);
          a.put("label", f.label == null ? "" : f.label);
          a.put("lang", f.language == null ? "" : f.language);
          a.put("codec", f.codecs != null ? f.codecs : (f.sampleMimeType == null ? "" : f.sampleMimeType));
          a.put("ch", f.channelCount);
          a.put("sel", g.isTrackSelected(i));
          a.put("ok", g.isTrackSupported(i));
          audio.put(a);
        }
      }
      o.put("audio", audio);
      emit(o);
    } catch (Exception e) { /* */ }
  }

  @Override public void onPlayerError(PlaybackException e) {
    int code = 4;
    int c = e.errorCode;
    if (c >= 2000 && c < 3000) code = 2;          // IO / rete
    else if (c >= 4000 && c < 5000) code = 3;     // decodifica
    Log.w(TAG, "{\"ev\":\"native.error\",\"detail\":\"" + e.getErrorCodeName() + " " + String.valueOf(e.getMessage()).replace('"', '\'') + "\"}");
    try { JSONObject o = ev("error"); o.put("code", code); o.put("name", e.getErrorCodeName()); o.put("msg", String.valueOf(e.getMessage())); emit(o); } catch (Exception x) { /* */ }
  }

  // ------------------------------------------------------------------ util

  static String mapMime(String mime, String url) {
    String m = mime == null ? "" : mime.toLowerCase();
    String u = url.toLowerCase();
    if (m.contains("mpegurl") || u.contains(".m3u8")) return MimeTypes.APPLICATION_M3U8;
    if (m.contains("dash") || u.contains(".mpd")) return MimeTypes.APPLICATION_MPD;
    if (m.contains("mp2t")) return MimeTypes.VIDEO_MP2T;
    return null;
  }

  static String redact(String url) {
    return url.replaceAll("/(live|movie|series|timeshift)/[^/]+/[^/]+/", "/$1/***/***/")
      .replaceAll("(?i)([?&](username|password|token)=)[^&]*", "$1***")
      .replaceAll("^(https?://)[^/]+", "$1<host>");
  }
}
