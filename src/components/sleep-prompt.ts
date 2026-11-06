import type { Action } from '../types';
import { Focus, type FocusScope, type Via } from '../navigation/focus-scope';
import { html, raw } from '../utils/dom';
import { morph } from '../utils/morph';
import { t } from '../i18n';
import { MOON_ICON } from './icons';
import { SLEEP_TIMER_EXTEND_MINUTES } from '../services/sleep-timer';

interface SleepPromptHandlers {
  remainingMs: () => number;
  onExtend: () => void;
  onSleepNow: () => void;
}

type SleepFocus = 'extend' | 'now';

// The sleep timer's last-minute warning. OK on the focused default (or Back)
// means the viewer is awake, so it extends; only "Turn off now" ends early.
export class SleepPrompt {
  private el: HTMLElement | null = null;
  private handlers: SleepPromptHandlers | null = null;
  private focus: SleepFocus = 'extend';
  private scope: FocusScope | null = null;
  private tick: ReturnType<typeof setInterval> | null = null;

  get visible(): boolean {
    return this.el !== null && !this.el.classList.contains('hidden');
  }

  show(handlers: SleepPromptHandlers): void {
    if (!this.scope) {
      this.scope = Focus.register({
        id: 'prompt.sleep',
        root: () => this.el,
        restrict: 'self-only',
        onAction: (action) => this.handleAction(action),
        defaultKey: () => this.focus,
      });
    }
    const wasVisible = this.visible;
    this.handlers = handlers;
    this.focus = 'extend';
    if (!this.el) {
      this.el = document.createElement('div');
      this.el.className = 'sleep-prompt';
      this.el.setAttribute('data-self-activate', '');
      this.bindEvents();
    }
    document.body.appendChild(this.el);
    this.el.classList.remove('hidden');
    this.render();
    if (!wasVisible) Focus.push(this.scope);
    this.moveTo(this.focus, 'key');
    if (this.tick) clearInterval(this.tick);
    this.tick = setInterval(() => this.render(), 1000);
  }

  hide(): void {
    if (this.tick) clearInterval(this.tick);
    this.tick = null;
    const wasVisible = this.visible;
    this.el?.classList.add('hidden');
    this.handlers = null;
    if (wasVisible && this.scope) Focus.pop(this.scope);
  }

  handleAction(action: Action): void {
    if (!this.visible) return;
    switch (action) {
      case 'left': this.moveTo('extend', 'key'); break;
      case 'right': this.moveTo('now', 'key'); break;
      case 'select': this.focus === 'extend' ? this.extend() : this.sleepNow(); break;
      case 'back': this.extend(); break;
      default: break;
    }
  }

  private moveTo(focus: SleepFocus, via: Via): void {
    this.focus = focus;
    this.scope?.focus(focus, via);
    Focus.flush();
  }

  private extend(): void { const h = this.handlers; this.hide(); h?.onExtend(); }
  private sleepNow(): void { const h = this.handlers; this.hide(); h?.onSleepNow(); }

  private render(): void {
    if (!this.el || !this.handlers) return;
    const seconds = Math.max(0, Math.ceil(this.handlers.remainingMs() / 1000));
    morph(this.el, html`
      <div class="sleep-dialog">
        <span class="sleep-icon">${raw(MOON_ICON)}</span>
        <h2 class="sleep-title">${t('sleep.title')}</h2>
        <p class="sleep-message">${t('sleep.countdown', { seconds })}</p>
        <div class="sleep-buttons">
          <button class="sleep-btn" data-focusable data-key="extend"
                  data-sleep-action="extend">${t('sleep.extend', { minutes: SLEEP_TIMER_EXTEND_MINUTES })}</button>
          <button class="sleep-btn" data-focusable data-key="now"
                  data-sleep-action="now">${t('sleep.turnOffNow')}</button>
        </div>
      </div>
    `);
  }

  private bindEvents(): void {
    this.el!.addEventListener('nav:hover', (e: Event) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-sleep-action]');
      if (!btn) return;
      this.moveTo(btn.dataset.sleepAction === 'now' ? 'now' : 'extend', 'pointer');
    });

    this.el!.addEventListener('click', (e: MouseEvent) => {
      const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-sleep-action]');
      if (!btn) return;
      btn.dataset.sleepAction === 'now' ? this.sleepNow() : this.extend();
    });
  }
}
