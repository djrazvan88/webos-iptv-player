/* IPTV Fire TV — <video> virtuale pilotato da ExoPlayer (window.FireNative).
 * L'app gira sul percorso "nativo webOS" (src / <source> + load() + play()); qui le proprietà e gli eventi
 * di HTMLMediaElement vengono emulati con lo stato che arriva da Java, e il rettangolo del <video>
 * viene copiato sulla SurfaceView che sta sotto la WebView trasparente.
 */
(function () {
  'use strict';
  var N = window.FireNative;
  if (!N) return;

  // Parametri di avvio (da Home Assistant via ADB): l'app li legge come su webOS
  try {
    var lp = N.launchParams && N.launchParams();
    if (lp) window.PalmSystem = { launchParams: lp };
  } catch (e) { /* */ }

  window.close = function () { N.exit(); };

  // crypto.subtle manca fuori dai contesti sicuri (http://app.local): l'app lo usa solo per lo SHA-256 del PIN genitori
  if (window.crypto && !window.crypto.subtle && N.sha256) {
    var subtle = {
      digest: function (alg, data) {
        var name = typeof alg === 'string' ? alg : alg && alg.name;
        if (String(name).toUpperCase() !== 'SHA-256') return Promise.reject(new Error('NotSupportedError'));
        var u8 = data instanceof Uint8Array ? data : new Uint8Array(data.buffer || data);
        var bin = ''; for (var i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
        var out = atob(N.sha256(btoa(bin)));
        var res = new Uint8Array(out.length); for (var j = 0; j < out.length; j++) res[j] = out.charCodeAt(j);
        return Promise.resolve(res.buffer);
      },
    };
    try { Object.defineProperty(Crypto.prototype, 'subtle', { configurable: true, get: function () { return subtle; } }); }
    catch (e) { /* */ }
  }

  var P = HTMLVideoElement.prototype;
  var states = new WeakMap();
  var active = null;
  var jsSession = 0;       // conta load()/stop() inviati: Java incrementa allo stesso modo
  var lastRect = '';
  var stats = null;

  function S(el) {
    var s = states.get(el);
    if (!s) {
      s = { src: '', type: '', paused: true, ct: 0, dur: NaN, ready: 0, net: 0, bufEnd: 0, vw: 0, vh: 0,
        err: null, ended: false, seeking: false, vol: 1, muted: false, rate: 1, live: false, sess: -1,
        loadedData: false, audio: null };
      states.set(el, s);
    }
    return s;
  }

  function fire(el, type) {
    try { el.dispatchEvent(new Event(type)); } catch (e) { /* */ }
  }

  function ranges(list) {
    return {
      length: list.length,
      start: function (i) { if (i >= list.length) throw new DOMException('IndexSizeError'); return list[i][0]; },
      end: function (i) { if (i >= list.length) throw new DOMException('IndexSizeError'); return list[i][1]; },
    };
  }

  // ---------------------------------------------------------------- AudioTrackList emulata
  function TrackList(el) {
    this._el = el; this._t = []; this._l = {}; this.length = 0;
    this.onchange = null; this.onaddtrack = null; this.onremovetrack = null;
  }
  TrackList.prototype.addEventListener = function (t, f) { (this._l[t] = this._l[t] || []).push(f); };
  TrackList.prototype.removeEventListener = function (t, f) {
    var a = this._l[t]; if (a) { var i = a.indexOf(f); if (i >= 0) a.splice(i, 1); }
  };
  TrackList.prototype._emit = function (t, track) {
    var e = { type: t, track: track || null, target: this };
    var h = this['on' + t]; if (typeof h === 'function') { try { h.call(this, e); } catch (x) { /* */ } }
    (this._l[t] || []).slice().forEach(function (f) { try { f.call(this, e); } catch (x) { /* */ } }, this);
  };
  TrackList.prototype.getTrackById = function (id) {
    for (var i = 0; i < this._t.length; i++) if (this._t[i].id === id) return this._t[i];
    return null;
  };
  TrackList.prototype._set = function (arr) {
    var self = this, old = this._t.length;
    for (var i = 0; i < Math.max(old, arr.length); i++) delete this[i];
    this._t = arr.map(function (a, idx) {
      var t = { id: a.id || String(idx), kind: idx === 0 ? 'main' : 'translation', label: a.label || '',
        language: a.lang || '', _codec: a.codec, _ch: a.ch, _enabled: !!a.sel };
      Object.defineProperty(t, 'enabled', {
        get: function () { return t._enabled; },
        set: function (v) {
          v = !!v; if (v === t._enabled) return;
          if (v) {
            self._t.forEach(function (o) { o._enabled = (o === t); });
            N.selectAudio(idx);
            self._emit('change');
          } else { t._enabled = false; }
        },
      });
      return t;
    });
    this.length = this._t.length;
    for (var j = 0; j < this._t.length; j++) this[j] = this._t[j];
    if (this._t.length !== old) this._t.forEach(function (t) { self._emit('addtrack', t); });
    else this._emit('change');
  };

  // ---------------------------------------------------------------- proprietà
  function prop(name, get, set) {
    Object.defineProperty(P, name, { configurable: true, enumerable: true, get: get, set: set });
  }

  prop('currentTime', function () { return S(this).ct; }, function (v) {
    var s = S(this); v = Number(v) || 0;
    if (!s.src) return;
    s.ct = v; s.seeking = true; s.ended = false;
    fire(this, 'seeking');
    N.seek(v);
  });
  prop('duration', function () { var s = S(this); return s.live ? Infinity : s.dur; });
  prop('paused', function () { return S(this).paused; });
  prop('ended', function () { return S(this).ended; });
  prop('seeking', function () { return S(this).seeking; });
  prop('readyState', function () { return S(this).ready; });
  prop('networkState', function () { return S(this).net; });
  prop('error', function () { return S(this).err; });
  prop('videoWidth', function () { return S(this).vw; });
  prop('videoHeight', function () { return S(this).vh; });
  prop('currentSrc', function () { return S(this).src; });
  prop('buffered', function () {
    var s = S(this); return ranges(s.src && s.bufEnd > s.ct ? [[s.ct, s.bufEnd]] : []);
  });
  prop('seekable', function () {
    var s = S(this); return ranges(s.src && !s.live && s.dur > 0 ? [[0, s.dur]] : []);
  });
  prop('volume', function () { return S(this).vol; }, function (v) {
    var s = S(this); s.vol = Math.max(0, Math.min(1, Number(v))); N.setVolume(s.muted ? 0 : s.vol); fire(this, 'volumechange');
  });
  prop('muted', function () { return S(this).muted; }, function (v) {
    var s = S(this); s.muted = !!v; N.setVolume(s.muted ? 0 : s.vol); fire(this, 'volumechange');
  });
  prop('playbackRate', function () { return S(this).rate; }, function (v) {
    var s = S(this); s.rate = Number(v) || 1; N.setRate(s.rate); fire(this, 'ratechange');
  });
  prop('audioTracks', function () { var s = S(this); if (!s.audio) s.audio = new TrackList(this); return s.audio; });
  prop('src', function () { return this.getAttribute('src') || ''; }, function (v) {
    this.setAttribute('src', v); this.load();
  });

  P.getVideoPlaybackQuality = function () {
    var st = this === active && stats ? stats : null;
    return {
      totalVideoFrames: st ? (st.rendered || 0) + (st.dropped || 0) : 0,
      droppedVideoFrames: st ? st.dropped || 0 : 0,
      corruptedVideoFrames: 0, creationTime: performance.now(),
    };
  };

  // ---------------------------------------------------------------- metodi
  P.load = function () {
    var el = this, s = S(el);
    var url = el.getAttribute('src'), type = '';
    if (!url) {
      var so = el.querySelector('source');
      if (so) { url = so.getAttribute('src'); type = so.getAttribute('type') || ''; }
    }
    var had = !!s.src;
    s.ct = 0; s.dur = NaN; s.ready = 0; s.bufEnd = 0; s.vw = 0; s.vh = 0; s.err = null; s.ended = false;
    s.seeking = false; s.live = false; s.loadedData = false;
    if (s.audio) s.audio._set([]);
    if (had) fire(el, 'emptied');
    if (!url || /^blob:/.test(url)) {
      s.src = ''; s.net = 0; s.paused = true;
      if (active === el || !active) { jsSession++; N.stop(); active = null; lastRect = ''; }
      return;
    }
    try { url = new URL(url, location.href).href; } catch (e) { /* */ }
    if (active && active !== el) { var o = S(active); o.paused = true; o.src = ''; }
    active = el;
    s.src = url; s.type = type; s.net = 2;
    s.paused = !el.autoplay;
    jsSession++; s.sess = jsSession;
    N.load(url, type, 0, !s.paused);
    lastRect = ''; syncRect();
    fire(el, 'loadstart');
    if (!s.paused) fire(el, 'play');
  };

  P.play = function () {
    var s = S(this);
    if (!s.src) return Promise.resolve();
    if (s.paused) { s.paused = false; fire(this, 'play'); }
    if (s.ended) { s.ended = false; N.seek(0); }
    N.play();
    if (s.ready >= 3) fire(this, 'playing');
    return Promise.resolve();
  };

  P.pause = function () {
    var s = S(this);
    if (!s.src) return;
    if (!s.paused) { s.paused = true; fire(this, 'pause'); }
    N.pause();
  };

  // ---------------------------------------------------------------- eventi da Java
  window.__fireNative = {
    onEvent: function (e) {
      if (!active || e.session !== jsSession) return;
      var el = active, s = S(el);
      switch (e.type) {
        case 'state':
          if (e.state === 'buffering') {
            if (s.ready >= 3) { s.ready = 2; fire(el, 'waiting'); }
          } else if (e.state === 'ready') {
            if (s.ready < 1) { s.ready = 1; fire(el, 'durationchange'); fire(el, 'loadedmetadata'); }
            if (!s.loadedData) { s.loadedData = true; s.ready = 2; fire(el, 'loadeddata'); }
            if (s.ready < 4) { s.ready = 4; fire(el, 'canplay'); fire(el, 'canplaythrough'); }
            if (s.seeking) { s.seeking = false; fire(el, 'seeked'); fire(el, 'timeupdate'); }
          } else if (e.state === 'ended') {
            if (!s.live) {
              s.ended = true;
              if (!s.paused) { s.paused = true; fire(el, 'pause'); }
              fire(el, 'ended');
            }
          }
          break;
        case 'playing':
          if (e.playing && !s.paused) fire(el, 'playing');
          break;
        case 'pos':
          var live = !!e.live;
          if (live !== s.live) { s.live = live; fire(el, 'durationchange'); }
          if (!live && e.dur > 0 && e.dur !== s.dur) { s.dur = e.dur; fire(el, 'durationchange'); }
          s.bufEnd = e.buf;
          if (!s.seeking && e.pos !== s.ct) { s.ct = e.pos; fire(el, 'timeupdate'); }
          fire(el, 'progress');
          break;
        case 'size':
          if (e.w !== s.vw || e.h !== s.vh) { s.vw = e.w; s.vh = e.h; fire(el, 'resize'); }
          break;
        case 'firstframe':
          lastRect = ''; syncRect();
          break;
        case 'tracks':
          S(el); el.audioTracks._set(e.audio || []);
          break;
        case 'stats':
          stats = e;
          break;
        case 'error':
          s.err = { code: e.code, message: (e.name || '') + ' ' + (e.msg || ''),
            MEDIA_ERR_ABORTED: 1, MEDIA_ERR_NETWORK: 2, MEDIA_ERR_DECODE: 3, MEDIA_ERR_SRC_NOT_SUPPORTED: 4 };
          s.net = 3;
          fire(el, 'error');
          break;
      }
    },
    stats: function () { return stats; },
  };

  // ---------------------------------------------------------------- rettangolo video → SurfaceView
  function hidden(el) {
    if (!el.isConnected || el.getClientRects().length === 0) return true;
    var cs = getComputedStyle(el);
    return cs.visibility === 'hidden' || Number(cs.opacity) === 0;
  }
  function syncRect() {
    if (!active) return;
    if (!active.isConnected) { jsSession++; N.stop(); active = null; lastRect = ''; return; }
    var r = active.getBoundingClientRect();
    var fit = getComputedStyle(active).objectFit || 'contain';
    var key = hidden(active) ? 'hidden' : [r.left, r.top, r.width, r.height, innerWidth, fit].map(String).join(',');
    if (key === lastRect) return;
    lastRect = key;
    if (key === 'hidden') N.setRect(0, 0, 0, 0, innerWidth, fit);
    else N.setRect(r.left, r.top, r.width, r.height, innerWidth, fit);
  }
  setInterval(syncRect, 150);
  window.addEventListener('resize', function () { lastRect = ''; syncRect(); });

  // Il <video> non deve coprire la SurfaceView
  var st = document.createElement('style');
  st.textContent = 'html,body,video{background:transparent!important}';
  (document.head || document.documentElement).appendChild(st);
})();
