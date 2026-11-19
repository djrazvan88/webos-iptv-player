/* IPTV Fire TV — caricato prima dell'app.
 * 1) instrada fetch/XHR verso altri host attraverso il proxy del Mac (/__p/...), per il CORS
 * 2) HUD in alto a destra: risoluzione, fps, frame persi, buffer, lag del thread, codec MSE
 * 3) manda le statistiche al Mac ogni 5 s (/__log)
 */
(function () {
  'use strict';
  var O = location.origin;

  // Fire TV 4K: la WebView riporta dpr 4 e lo schermo largo 960 px → l'interfaccia (1920) usciva ingrandita 2x.
  // Scala = larghezza schermo / 1920 (0,5 sulla TCL).
  var mv = document.querySelector('meta[name=viewport]');
  var sc = Math.min(1, screen.width / 1920);
  if (mv) mv.setAttribute('content', 'width=1920, initial-scale=' + sc + ', minimum-scale=' + sc +
    ', maximum-scale=' + sc + ', user-scalable=no');

  function px(u) {
    try {
      var a = new URL(u, location.href);
      if (a.origin === O) return u;
      if (a.protocol !== 'http:' && a.protocol !== 'https:') return u;
      return O + '/__p/' + a.protocol.slice(0, -1) + '/' + a.host + a.pathname + a.search;
    } catch (e) { return u; }
  }
  window.__fireProxy = px;

  var xo = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function () {
    var args = Array.prototype.slice.call(arguments);
    args[1] = px(String(args[1]));
    return xo.apply(this, args);
  };
  var fo = window.fetch;
  var FN = window.FireNative;
  // Webhook di Home Assistant di questa TV (assets/fire.json): sostituisce quello della LG ripristinato dal backup
  if (FN && FN.webhookUrl) {
    try {
      var wh = FN.webhookUrl();
      if (wh) localStorage.setItem('iptv_ha_webhook_url', JSON.stringify(wh));
      else localStorage.removeItem('iptv_ha_webhook_url');
    } catch (e) { /* */ }
  }
  window.fetch = function (input, init) {
    var method = (init && init.method) || (input && input.method) || 'GET';
    if (FN && FN.httpPost && String(method).toUpperCase() === 'POST') {
      var u = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
      var abs = new URL(u, location.href);
      if (abs.origin !== O) {
        var ct = '';
        var h = init && init.headers;
        if (h) ct = (h.get ? h.get('Content-Type') : (h['Content-Type'] || h['content-type'])) || '';
        var body = init && typeof init.body === 'string' ? init.body : '';
        return new Promise(function (res, rej) {
          setTimeout(function () {
            var st = FN.httpPost(abs.href, body, ct);
            if (!(st >= 200 && st < 600)) { rej(new TypeError('Failed to fetch')); return; }
            res(new Response(null, { status: st }));
          }, 0);
        });
      }
    }
    if (typeof input === 'string' || input instanceof URL) {
      input = px(String(input));
    } else if (input && input.url) {
      var n = px(input.url);
      if (n !== input.url) input = new Request(n, input);
    }
    return fo.call(this, input, init);
  };

  // Codec effettivamente chiesti a MSE (mpegts.js / hls.js)
  var codecs = { v: '', a: '' };
  if (window.MediaSource) {
    var asb = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function (mime) {
      var c = (String(mime).match(/codecs="?([^"]+)"?/) || [])[1] || mime;
      if (/^audio/.test(mime)) codecs.a = c; else if (/^video/.test(mime)) {
        if (/,/.test(c)) { var p = c.split(/\s*,\s*/); codecs.v = p[0]; codecs.a = p[1]; } else codecs.v = c;
      }
      send({ ev: 'mse.addSourceBuffer', detail: mime });
      return asb.apply(this, arguments);
    };
  }

  function send(obj) {
    obj.t = new Date().toISOString();
    try {
      if (window.FireLog) window.FireLog.log(JSON.stringify(obj));
      else fo.call(window, O + '/__log', { method: 'POST', body: JSON.stringify(obj), keepalive: true });
    } catch (e) { /* */ }
  }

  // Supporto dichiarato dal motore
  var support = {};
  var probes = {
    'ac-3': 'audio/mp4; codecs="ac-3"', 'ec-3': 'audio/mp4; codecs="ec-3"',
    'aac': 'audio/mp4; codecs="mp4a.40.2"', 'mp3': 'audio/mpeg',
    'h264': 'video/mp4; codecs="avc1.640028"', 'hevc': 'video/mp4; codecs="hvc1.2.4.L153.B0"',
  };
  for (var k in probes) {
    try { support[k] = !!(window.MediaSource && MediaSource.isTypeSupported(probes[k])); } catch (e) { support[k] = false; }
  }

  // Lag del thread principale (CPU satura → lag alto)
  var lag = 0, last = performance.now();
  setInterval(function () {
    var now = performance.now(); lag = Math.max(lag, now - last - 100); last = now;
  }, 100);

  var stalls = 0, prev = null, hud = null, tick = 0;
  document.addEventListener('waiting', function () { stalls++; }, true);
  document.addEventListener('error', function (e) {
    if (e.target && e.target.tagName === 'VIDEO') {
      var er = e.target.error;
      send({ ev: 'video.error', detail: er ? (er.code + ' ' + (er.message || '')) : '' });
    }
  }, true);

  function srcName(v) {
    var s = v.currentSrc || v.src || '';
    if (/^blob:/.test(s)) return 'MSE';
    return (s.split('?')[0].split('/').pop() || '').slice(0, 30);
  }

  function makeHud() {
    hud = document.createElement('div');
    hud.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;background:rgba(0,0,0,.72);' +
      'color:#9f9;font:20px/1.35 monospace;padding:10px 14px;border-radius:8px;pointer-events:none;white-space:pre';
    document.body.appendChild(hud);
  }

  var DEBUG = !FN || (FN.isDebug && FN.isDebug());
  if (!DEBUG) return;   // versione normale: niente HUD né statistiche
  setInterval(function () {
    if (!document.body) return;
    if (!hud) makeHud();
    var vids = document.querySelectorAll('video'), v = null;
    for (var i = 0; i < vids.length; i++) if (vids[i].videoWidth > 0 && !vids[i].paused) { v = vids[i]; break; }
    var lines = ['FIRE TV TEST  lag ' + Math.round(lag) + ' ms  stalli ' + stalls];
    var stat = null;
    if (v) {
      var q = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : { totalVideoFrames: 0, droppedVideoFrames: 0 };
      var buf = 0;
      for (var b = 0; b < v.buffered.length; b++) {
        if (v.buffered.start(b) <= v.currentTime + 0.1 && v.buffered.end(b) >= v.currentTime) buf = v.buffered.end(b) - v.currentTime;
      }
      var fps = 0, dropS = 0;
      if (prev && prev.el === v && q.totalVideoFrames >= prev.tot) {
        fps = q.totalVideoFrames - prev.tot; dropS = q.droppedVideoFrames - prev.drop;
      }
      prev = { el: v, tot: q.totalVideoFrames, drop: q.droppedVideoFrames };
      var pct = q.totalVideoFrames ? (100 * q.droppedVideoFrames / q.totalVideoFrames).toFixed(1) : '0';
      stat = { res: v.videoWidth + 'x' + v.videoHeight, fps: fps, dropS: dropS, dropPct: pct, buf: buf.toFixed(1) };
      lines.push(stat.res + '  ' + fps + ' fps  persi ' + dropS + '/s (' + pct + '%)');
      lines.push('buffer ' + stat.buf + ' s  ' + srcName(v));
      var ns = window.__fireNative && window.__fireNative.stats();
      if (ns) lines.push('v ' + (ns.vcodec || '-') + ' ' + (ns.fr > 0 ? Math.round(ns.fr) + 'fps' : '') +
        '  a ' + (ns.acodec || '-') + ' ' + (ns.ach > 0 ? ns.ach + 'ch' : ''));
      else lines.push('v ' + (codecs.v || '-') + '  a ' + (codecs.a || '-'));
    } else {
      prev = null;
      lines.push('nessun video in riproduzione');
    }
    lines.push(window.FireNative ? 'ExoPlayer nativo' : 'MSE ac3 ' + (support['ac-3'] ? 'si' : 'NO') + ' eac3 ' +
      (support['ec-3'] ? 'si' : 'NO') + ' hevc ' + (support.hevc ? 'si' : 'NO'));
    hud.textContent = lines.join('\n');

    if (++tick % 5 === 0) {
      var heap = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null;
      var nst = window.__fireNative && window.__fireNative.stats();
      send({ v: stat, lag: Math.round(lag), stalls: stalls, vc: nst ? nst.vcodec : codecs.v, ac: nst ? nst.acodec + '/' + nst.ach : codecs.a,
        src: v ? srcName(v) : '', heapMB: heap });
      lag = 0;
    }
  }, 1000);

  send({ ev: 'avvio', detail: navigator.userAgent + ' | supporto MSE ' + JSON.stringify(support) +
    ' | schermo ' + screen.width + 'x' + screen.height + ' dpr ' + devicePixelRatio });
})();
