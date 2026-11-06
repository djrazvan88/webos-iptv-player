import { html } from '../utils/dom';
import { morph } from '../utils/morph';
import { formatDayLabel, formatTime } from '../utils/time';

const TICK_MS = 5000;
// The clock hops to a new spot every minute, so no pixel holds the same glyph.
const MOVE_MS = 60_000;
const CLOCK_W = 360;
const CLOCK_H = 150;
const SAFE_MARGIN = 80;

export interface ScreenSaverOptions {
  // 0 turns the screen saver off.
  timeoutMs: () => number;
  // Moving video on screen counts as activity: a film is never covered.
  isWatching: () => boolean;
  random?: () => number;
  now?: () => number;
}

// An OLED-friendly idle screen: after a stretch of no input on a static
// screen (lists, the guide, a paused frame) everything goes black but a small
// drifting clock. The first key, click, or pointer move only wakes it.
export class ScreenSaver {
  private el: HTMLElement | null = null;
  private lastInput: number;
  private isActive = false;
  private moveTimer: ReturnType<typeof setInterval> | null = null;
  private teardown: (() => void) | null = null;
  private pointerX: number | null = null;
  private pointerY: number | null = null;
  private readonly random: () => number;
  private readonly now: () => number;

  constructor(private readonly options: ScreenSaverOptions) {
    this.random = options.random ?? Math.random;
    this.now = options.now ?? (() => Date.now());
    this.lastInput = this.now();
  }

  get active(): boolean {
    return this.isActive;
  }

  init(): void {
    const swallowKey = (e: KeyboardEvent): void => {
      this.lastInput = this.now();
      if (!this.isActive) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this.wake();
    };
    const swallowClick = (e: MouseEvent): void => {
      this.lastInput = this.now();
      if (!this.isActive) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this.wake();
    };
    // A repeat at the same spot is the cursor resting or pushed against an
    // edge, the screen saver's own appearance included: only a move counts.
    const onMove = (event: Event): void => {
      const e = (event as CustomEvent<{ clientX: number; clientY: number }>).detail;
      const moved = this.pointerX !== null
        && (e.clientX !== this.pointerX || e.clientY !== this.pointerY);
      this.pointerX = e.clientX;
      this.pointerY = e.clientY;
      if (!moved) return;
      this.lastInput = this.now();
      if (this.isActive) this.wake();
    };
    const swallowKeyUp = (e: KeyboardEvent): void => {
      if (this.isActive) e.stopImmediatePropagation();
    };
    document.addEventListener('keydown', swallowKey, true);
    document.addEventListener('keyup', swallowKeyUp, true);
    document.addEventListener('mousedown', swallowClick, true);
    document.addEventListener('click', swallowClick, true);
    const onVisible = (): void => {
      if (!document.hidden) this.wake();
    };
    document.addEventListener('nav:pointermove', onMove);
    document.addEventListener('visibilitychange', onVisible);
    const tick = setInterval(() => this.tick(), TICK_MS);
    this.teardown = () => {
      document.removeEventListener('keydown', swallowKey, true);
      document.removeEventListener('keyup', swallowKeyUp, true);
      document.removeEventListener('mousedown', swallowClick, true);
      document.removeEventListener('click', swallowClick, true);
      document.removeEventListener('nav:pointermove', onMove);
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(tick);
    };
  }

  destroy(): void {
    this.wake();
    this.teardown?.();
    this.teardown = null;
    this.el?.remove();
    this.el = null;
  }

  // Every routed action pokes it (wheel steps included); returns whether the
  // action only woke the screen and must go no further.
  poke(): boolean {
    this.lastInput = this.now();
    if (!this.isActive) return false;
    this.wake();
    return true;
  }

  // A prompt that needs the viewer (a reminder, the sleep warning) wakes it too.
  wake(): void {
    this.lastInput = this.now();
    if (!this.isActive) return;
    this.isActive = false;
    if (this.moveTimer) clearInterval(this.moveTimer);
    this.moveTimer = null;
    this.el?.classList.remove('visible');
  }

  tick(): void {
    const timeout = this.options.timeoutMs();
    if (this.isActive) {
      // Playback came back under it (a resume from the background, a reminder tune-in).
      if (timeout <= 0 || this.options.isWatching()) this.wake();
      return;
    }
    if (timeout <= 0) return;
    if (this.options.isWatching()) {
      this.lastInput = this.now();
      return;
    }
    if (this.now() - this.lastInput >= timeout) this.activate();
  }

  private activate(): void {
    if (!this.el) {
      this.el = document.createElement('div');
      this.el.className = 'screen-saver';
      this.el.setAttribute('aria-hidden', 'true');
      document.body.appendChild(this.el);
    }
    this.isActive = true;
    this.render();
    this.el.classList.add('visible');
    this.moveTimer = setInterval(() => this.render(), MOVE_MS);
  }

  private render(): void {
    if (!this.el) return;
    const width = window.innerWidth || 1920;
    const height = window.innerHeight || 1080;
    const x = SAFE_MARGIN + Math.floor(this.random() * Math.max(1, width - CLOCK_W - 2 * SAFE_MARGIN));
    const y = SAFE_MARGIN + Math.floor(this.random() * Math.max(1, height - CLOCK_H - 2 * SAFE_MARGIN));
    const now = new Date(this.now());
    const day = formatDayLabel(now);
    morph(this.el, html`
      <div class="screen-saver-clock" style="left: ${String(x)}px; top: ${String(y)}px">
        <div class="screen-saver-time">${formatTime(now)}</div>
        <div class="screen-saver-date">${day.weekday} ${day.date}</div>
      </div>
    `);
  }
}
