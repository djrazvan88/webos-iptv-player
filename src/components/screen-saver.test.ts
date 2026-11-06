// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScreenSaver } from './screen-saver';

const MIN = 60_000;

let timeoutMs: number;
let watching: boolean;
let saver: ScreenSaver;
let afterSaver: ReturnType<typeof vi.fn>;

function overlay(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.screen-saver');
}

function pointerMove(x: number, y: number): void {
  document.dispatchEvent(new CustomEvent('nav:pointermove', { detail: { clientX: x, clientY: y } }));
}

describe('ScreenSaver', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    timeoutMs = 5 * MIN;
    watching = false;
    saver = new ScreenSaver({
      timeoutMs: () => timeoutMs,
      isWatching: () => watching,
      random: () => 0.5,
    });
    saver.init();
    // A later bubble-phase listener stands in for KeyHandler.
    afterSaver = vi.fn();
    document.addEventListener('keydown', afterSaver);
  });
  afterEach(() => {
    document.removeEventListener('keydown', afterSaver);
    saver.destroy();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('blacks out a still screen after the idle time with a clock inside the safe area', () => {
    vi.advanceTimersByTime(5 * MIN - 5000);
    expect(saver.active).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(saver.active).toBe(true);
    expect(overlay()!.classList.contains('visible')).toBe(true);
    const clock = overlay()!.querySelector<HTMLElement>('.screen-saver-clock')!;
    expect(clock.querySelector('.screen-saver-time')!.textContent).toMatch(/^\d\d:\d\d$/);
    expect(parseInt(clock.style.left, 10)).toBeGreaterThanOrEqual(80);
    expect(parseInt(clock.style.top, 10)).toBeGreaterThanOrEqual(80);
  });

  it('never covers playing video, and counts it as activity', () => {
    watching = true;
    vi.advanceTimersByTime(30 * MIN);
    expect(saver.active).toBe(false);

    watching = false;
    vi.advanceTimersByTime(4 * MIN);
    expect(saver.active).toBe(false);
    vi.advanceTimersByTime(MIN);
    expect(saver.active).toBe(true);
  });

  it('steps aside when playback resumes underneath it', () => {
    vi.advanceTimersByTime(5 * MIN);
    expect(saver.active).toBe(true);
    watching = true;
    vi.advanceTimersByTime(5000);
    expect(saver.active).toBe(false);
  });

  it('wakes when the app comes back to the foreground', () => {
    vi.advanceTimersByTime(5 * MIN);
    expect(saver.active).toBe(true);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(saver.active).toBe(false);
  });

  it('stays off when the setting is off', () => {
    timeoutMs = 0;
    vi.advanceTimersByTime(60 * MIN);
    expect(saver.active).toBe(false);
  });

  it('swallows the waking key so it acts on nothing below', () => {
    vi.advanceTimersByTime(5 * MIN);
    document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 13, bubbles: true }));
    expect(saver.active).toBe(false);
    expect(overlay()!.classList.contains('visible')).toBe(false);
    expect(afterSaver).not.toHaveBeenCalled();

    document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 13, bubbles: true }));
    expect(afterSaver).toHaveBeenCalledTimes(1);
  });

  it('a key press restarts the idle countdown', () => {
    vi.advanceTimersByTime(4 * MIN);
    document.dispatchEvent(new KeyboardEvent('keydown', { keyCode: 40, bubbles: true }));
    vi.advanceTimersByTime(4 * MIN);
    expect(saver.active).toBe(false);
  });

  it('wakes on a real pointer move but not on a repeat at the same spot', () => {
    pointerMove(100, 100);
    vi.advanceTimersByTime(5 * MIN);
    expect(saver.active).toBe(true);

    pointerMove(100, 100);
    expect(saver.active).toBe(true);
    pointerMove(140, 100);
    expect(saver.active).toBe(false);
  });

  it('poke reports a routed action that only woke the screen', () => {
    expect(saver.poke()).toBe(false);
    vi.advanceTimersByTime(5 * MIN);
    expect(saver.poke()).toBe(true);
    expect(saver.poke()).toBe(false);
  });

  it('moves the clock every minute while shown', () => {
    let r = 0.1;
    saver.destroy();
    saver = new ScreenSaver({ timeoutMs: () => timeoutMs, isWatching: () => false, random: () => r });
    saver.init();
    vi.advanceTimersByTime(5 * MIN);
    const before = overlay()!.querySelector<HTMLElement>('.screen-saver-clock')!.style.left;
    r = 0.9;
    vi.advanceTimersByTime(MIN);
    expect(overlay()!.querySelector<HTMLElement>('.screen-saver-clock')!.style.left).not.toBe(before);
  });
});
