export function isWebOS(): boolean {
  // Fire TV (guscio Android con ExoPlayer): stesso percorso di riproduzione nativa di webOS.
  if (typeof window !== 'undefined' && (window as unknown as { FireNative?: unknown }).FireNative) return true;
  return typeof navigator !== 'undefined' && /webOS|Web0S/i.test(navigator.userAgent);
}

export function isFireTvNative(): boolean {
  return typeof window !== 'undefined' && !!(window as unknown as { FireNative?: unknown }).FireNative;
}
