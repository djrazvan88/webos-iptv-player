// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SleepPrompt } from './sleep-prompt';
import { Focus } from '../navigation/focus-scope';

let remaining: number;
let onExtend: ReturnType<typeof vi.fn>;
let onSleepNow: ReturnType<typeof vi.fn>;
let prompt: SleepPrompt;

function root(): HTMLElement {
  return document.querySelector<HTMLElement>('.sleep-prompt')!;
}

function show(): void {
  prompt.show({ remainingMs: () => remaining, onExtend, onSleepNow });
}

describe('SleepPrompt', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    remaining = 60_000;
    onExtend = vi.fn();
    onSleepNow = vi.fn();
    prompt = new SleepPrompt();
  });
  afterEach(() => {
    prompt.hide();
    Focus.uninstall();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('counts down the seconds left, focused on the extend button', () => {
    show();
    expect(root().querySelector('.sleep-message')!.textContent).toBe('Turning off in 60 s');
    expect(root().querySelector('[data-key="extend"]')!.textContent).toBe('+30 min');
    expect(root().querySelector('[data-key="extend"]')!.classList.contains('focused')).toBe(true);

    remaining = 42_400;
    vi.advanceTimersByTime(1000);
    expect(root().querySelector('.sleep-message')!.textContent).toBe('Turning off in 43 s');
  });

  it('OK and Back both extend: the viewer is awake', () => {
    show();
    prompt.handleAction('select');
    expect(onExtend).toHaveBeenCalledTimes(1);
    expect(prompt.visible).toBe(false);

    show();
    prompt.handleAction('back');
    expect(onExtend).toHaveBeenCalledTimes(2);
    expect(onSleepNow).not.toHaveBeenCalled();
  });

  it('Right then OK turns off now', () => {
    show();
    prompt.handleAction('right');
    expect(root().querySelector('[data-key="now"]')!.classList.contains('focused')).toBe(true);
    prompt.handleAction('select');
    expect(onSleepNow).toHaveBeenCalledTimes(1);
    expect(onExtend).not.toHaveBeenCalled();
  });

  it('a click on a button acts on it', () => {
    show();
    root().querySelector<HTMLElement>('[data-sleep-action="now"]')!.click();
    expect(onSleepNow).toHaveBeenCalledTimes(1);
  });

  it('stops ticking once hidden', () => {
    show();
    prompt.handleAction('select');
    const text = root().querySelector('.sleep-message')!.textContent;
    remaining = 10_000;
    vi.advanceTimersByTime(3000);
    expect(root().querySelector('.sleep-message')!.textContent).toBe(text);
  });
});
