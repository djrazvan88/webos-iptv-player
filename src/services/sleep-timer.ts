import { createLogger } from '../utils/logger';

const log = createLogger('SleepTimer');

export const SLEEP_TIMER_MINUTES: readonly number[] = [15, 30, 45, 60, 90, 120];
export const SLEEP_TIMER_WARNING_MS = 60_000;
export const SLEEP_TIMER_EXTEND_MINUTES = 30;

// A number of minutes, or the end of the program on air when it was set.
export type SleepTimerChoice = number | 'program';

export interface SleepTimerHandlers {
  onWarn: (remainingMs: number) => void;
  onExpire: () => void;
  onChange?: () => void;
}

export interface SleepTimerState {
  active: boolean;
  choice: SleepTimerChoice | null;
  remainingMs: number;
}

export class SleepTimer {
  private deadline: number | null = null;
  private choice: SleepTimerChoice | null = null;
  private warnTimer: ReturnType<typeof setTimeout> | null = null;
  private expireTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly handlers: SleepTimerHandlers,
    private readonly now: () => number = () => Date.now(),
  ) {}

  state(): SleepTimerState {
    return {
      active: this.deadline !== null,
      choice: this.choice,
      remainingMs: this.remainingMs(),
    };
  }

  remainingMs(): number {
    return this.deadline === null ? 0 : Math.max(0, this.deadline - this.now());
  }

  start(minutes: number): void {
    if (!(minutes > 0)) throw new RangeError(`Invalid sleep timer minutes: ${String(minutes)}`);
    this.arm(this.now() + minutes * 60_000, minutes);
  }

  // Returns false when the program has already ended, so the caller can say so.
  startUntil(endMs: number): boolean {
    if (!(endMs > this.now())) return false;
    this.arm(endMs, 'program');
    return true;
  }

  extend(minutes = SLEEP_TIMER_EXTEND_MINUTES): void {
    if (this.deadline === null) return;
    this.arm(Math.max(this.deadline, this.now()) + minutes * 60_000, minutes);
  }

  cancel(): void {
    if (this.deadline === null) return;
    this.clearTimers();
    this.deadline = null;
    this.choice = null;
    this.handlers.onChange?.();
  }

  private arm(deadline: number, choice: SleepTimerChoice): void {
    this.clearTimers();
    this.deadline = deadline;
    this.choice = choice;
    const remaining = deadline - this.now();
    log.info('Sleep timer set', 'event=sleep.set',
      `choice=${String(choice)}`, `minutes=${String(Math.ceil(remaining / 60_000))}`);
    const warnIn = remaining - SLEEP_TIMER_WARNING_MS;
    this.warnTimer = setTimeout(() => {
      this.warnTimer = null;
      this.handlers.onWarn(this.remainingMs());
    }, Math.max(0, warnIn));
    this.expireTimer = setTimeout(() => this.expire(), remaining);
    this.handlers.onChange?.();
  }

  private expire(): void {
    this.clearTimers();
    this.deadline = null;
    this.choice = null;
    this.handlers.onChange?.();
    this.handlers.onExpire();
  }

  private clearTimers(): void {
    if (this.warnTimer) clearTimeout(this.warnTimer);
    if (this.expireTimer) clearTimeout(this.expireTimer);
    this.warnTimer = null;
    this.expireTimer = null;
  }
}
