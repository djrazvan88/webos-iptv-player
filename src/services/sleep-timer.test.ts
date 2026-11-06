import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SLEEP_TIMER_WARNING_MS, SleepTimer } from './sleep-timer';

const MIN = 60_000;

function setup() {
  const onWarn = vi.fn();
  const onExpire = vi.fn();
  const onChange = vi.fn();
  const timer = new SleepTimer({ onWarn, onExpire, onChange });
  return { timer, onWarn, onExpire, onChange };
}

describe('SleepTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('warns a minute before the deadline and expires at it', () => {
    const { timer, onWarn, onExpire } = setup();
    timer.start(15);

    vi.advanceTimersByTime(14 * MIN - 1);
    expect(onWarn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onWarn).toHaveBeenCalledWith(SLEEP_TIMER_WARNING_MS);
    expect(onExpire).not.toHaveBeenCalled();

    vi.advanceTimersByTime(SLEEP_TIMER_WARNING_MS);
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(timer.state()).toEqual({ active: false, choice: null, remainingMs: 0 });
  });

  it('reports the choice and the time left', () => {
    const { timer } = setup();
    timer.start(30);
    vi.advanceTimersByTime(10 * MIN);
    expect(timer.state()).toEqual({ active: true, choice: 30, remainingMs: 20 * MIN });
  });

  it('runs until the end of the program and warns at once when it ends within a minute', () => {
    const { timer, onWarn, onExpire } = setup();
    expect(timer.startUntil(Date.now() + 40_000)).toBe(true);
    expect(timer.state().choice).toBe('program');

    vi.advanceTimersByTime(0);
    expect(onWarn).toHaveBeenCalledWith(40_000);
    vi.advanceTimersByTime(40_000);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('refuses a program that has already ended', () => {
    const { timer, onChange } = setup();
    expect(timer.startUntil(Date.now())).toBe(false);
    expect(timer.state().active).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('extends from the deadline and reschedules the warning', () => {
    const { timer, onWarn, onExpire } = setup();
    timer.start(15);
    vi.advanceTimersByTime(14 * MIN);
    expect(onWarn).toHaveBeenCalledTimes(1);

    timer.extend(30);
    expect(timer.remainingMs()).toBe(31 * MIN);
    vi.advanceTimersByTime(MIN);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(29 * MIN);
    expect(onWarn).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(MIN);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('cancels without firing and notifies the change once', () => {
    const { timer, onWarn, onExpire, onChange } = setup();
    timer.start(15);
    onChange.mockClear();
    timer.cancel();
    timer.cancel();
    vi.advanceTimersByTime(20 * MIN);
    expect(onWarn).not.toHaveBeenCalled();
    expect(onExpire).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('ignores extend while inactive and rejects a non-positive duration', () => {
    const { timer, onChange } = setup();
    timer.extend();
    expect(timer.state().active).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(() => timer.start(0)).toThrow(RangeError);
  });

  it('logs the choice for diagnostics', () => {
    const { timer } = setup();
    timer.start(45);
    expect(console.log).toHaveBeenCalledWith(
      '[SleepTimer]', 'Sleep timer set', 'event=sleep.set', 'choice=45', 'minutes=45',
    );
  });
});
