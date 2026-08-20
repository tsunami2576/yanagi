/** GameUI：DOM UI 总装。session 通过它驱动一切界面。 */
import type { BacklogEntry } from '@yanagi/core';
import { BacklogPanel, type BacklogViewEntry } from './backlog-panel';
import { ConfirmBox } from './confirm';
import { DockBar, type DockAction } from './dock';
import { QuickBar } from './quick-bar';
import { SystemMenu, type SysTab } from './system-menu';
import { TextWindow, type TextLineView } from './text-window';

export interface Settings {
  /** 每秒字数；0 = 瞬间 */
  textCps: number;
  autoBaseMs: number;
  autoPerCharMs: number;
  vol: { master: number; bgm: number; se: number; voice: number; ambient: number };
  /** 文本窗不透明度 0.5–1 */
  windowOpacity: number;
  /** 失焦时静音 */
  muteOnBlur: boolean;
  /** 天气粒子总密度 0.2–1 */
  particleDensity: number;
  /** 想起中"以前读过"浅色标注 */
  backlogReadDim: boolean;
  /** 空格键功能（默认隐藏对话框，可在设置改为下一句） */
  spaceAction: 'hideWindow' | 'advance';
  /** 右键功能（默认打开菜单） */
  rightAction: 'menu' | 'hideWindow';
}

export const DEFAULT_SETTINGS: Settings = {
  textCps: 30,
  autoBaseMs: 1100,
  autoPerCharMs: 18,
  vol: { master: 1, bgm: 0.8, se: 0.8, voice: 0.9, ambient: 0.7 },
  windowOpacity: 1,
  muteOnBlur: true,
  particleDensity: 1,
  backlogReadDim: true,
  spaceAction: 'hideWindow',
  rightAction: 'menu',
};

export interface UIHooks {
  advance(): void;
  titleStart(): void;
  titleContinue(): void;
  titleLoad(): void;
  titleSettings(): void;
  dock(id: DockAction): void;
  quickBar(slot: string, mode: 'save' | 'load'): void;
  systemAction(id: 'resume' | 'toTitle' | 'exit'): void;
  saveSlot(slot: string): void;
  loadSlot(slot: string): void;
  settingsChange(s: Settings): void;
  replayVoice(voice: string): void;
  rollback(uid: string): void;
  exportSaves(): void;
  importFile(file: File): void;
}

export interface SaveSlotView {
  slot: string;
  label: string;
  chapterTitle: string;
  lineSummary: string;
  savedAt: number;
  thumbUrl: string | null;
  empty: boolean;
}

export interface ChoiceButton {
  index: number;
  text: string;
  disabled: boolean;
}

export class GameUI {
  readonly stageMount: HTMLElement;
  private readonly textWindow: TextWindow;
  private readonly titleEl: HTMLElement;
  private readonly titleMain: HTMLElement;
  private readonly titleContBtn: HTMLButtonElement;
  private readonly choicesEl: HTMLElement;
  private readonly choicePromptEl: HTMLElement;
  private readonly choiceListEl: HTMLElement;
  private readonly chapterEl: HTMLElement;
  private readonly errorEl: HTMLElement;
  private readonly errorTextEl: HTMLElement;
  private readonly badgeAuto: HTMLElement;
  private readonly badgeSkip: HTMLElement;
  private readonly dock: DockBar;
  readonly quickBar: QuickBar;
  readonly systemMenu: SystemMenu;
  readonly backlog: BacklogPanel;
  readonly confirmBox: ConfirmBox;

  private choiceButtons: HTMLButtonElement[] = [];
  private choiceSel = 0;
  private choicePick: ((i: number) => void) | null = null;
  private settings: Settings = { ...DEFAULT_SETTINGS, vol: { ...DEFAULT_SETTINGS.vol } };

  constructor(
    private readonly root: HTMLElement,
    private readonly hooks: UIHooks,
  ) {
    root.classList.add('yg-root');
    root.replaceChildren();

    const mk = (cls: string, html = ''): HTMLElement => {
      const el = document.createElement('div');
      el.className = cls;
      if (html) el.innerHTML = html;
      root.appendChild(el);
      return el;
    };

    this.stageMount = mk('yg-stage');
    this.textWindow = new TextWindow(root);
    this.dock = new DockBar(this.textWindow.el, (id) => this.hooks.dock(id));
    this.chapterEl = mk('yg-chapter', '<span></span>');
    const badges = mk('yg-badges', '<span class="yg-badge yg-badge-auto">AUTO</span><span class="yg-badge yg-badge-skip">SKIP</span>');
    this.badgeAuto = badges.querySelector('.yg-badge-auto')!;
    this.badgeSkip = badges.querySelector('.yg-badge-skip')!;

    this.choicesEl = mk('yg-choices', '<div class="yg-choice-prompt"></div><div class="yg-choice-list"></div>');
    this.choicePromptEl = this.choicesEl.querySelector('.yg-choice-prompt')!;
    this.choiceListEl = this.choicesEl.querySelector('.yg-choice-list')!;

    this.titleEl = mk(
      'yg-title',
      `<div class="yg-title-main"></div>
       <div class="yg-title-sub">— 柳 YANAGI —</div>
       <div class="yg-title-menu">
         <button class="yg-btn" data-act="start">开 始</button>
         <button class="yg-btn" data-act="continue">继 续</button>
         <button class="yg-btn" data-act="load">读 档</button>
         <button class="yg-btn" data-act="settings">设 置</button>
       </div>
       <div class="yg-panel-foot"></div>`,
    );
    this.titleMain = this.titleEl.querySelector('.yg-title-main')!;
    this.titleContBtn = this.titleEl.querySelector('[data-act="continue"]')!;

    this.errorEl = mk(
      'yg-overlay',
      `<div class="yg-panel">
         <h2>出 错</h2>
         <div class="yg-error-text"></div>
         <button class="yg-btn yg-close">关 闭</button>
       </div>`,
    );
    this.errorTextEl = this.errorEl.querySelector('.yg-error-text')!;

    this.backlog = new BacklogPanel(
      root,
      {
        onRollback: (uid) => this.hooks.rollback(uid),
        onReplayVoice: (v) => this.hooks.replayVoice(v),
        onClose: () => this.closeBacklog(),
      },
      (charId) => this.avatarFor?.(charId),
    );
    this.systemMenu = new SystemMenu(
      root,
      {
        settingsChange: (s) => this.hooks.settingsChange(s),
        saveSlot: (slot) => this.hooks.saveSlot(slot),
        loadSlot: (slot) => this.hooks.loadSlot(slot),
        exportSaves: () => this.hooks.exportSaves(),
        importFile: (f) => this.hooks.importFile(f),
        systemAction: (id) => this.hooks.systemAction(id),
      },
      () => this.settings,
    );
    this.confirmBox = new ConfirmBox(root);
    this.quickBar = new QuickBar(root, (slot, mode) => this.hooks.quickBar(slot, mode));

    this.bindCommon();
    this.bindChoicesKeys();
  }

  /** 想起头像解析（session 注入） */
  avatarFor: ((charId: string | null) => string | undefined) | null = null;

  // ---------- 状态查询 ----------

  get textPlaying(): boolean {
    return this.textWindow.isPlaying;
  }

  private get uiHidden(): boolean {
    return this.root.classList.contains('yg-ui-hidden');
  }

  /** 任何遮住舞台、需要屏蔽"前进"输入的面板 */
  get overlayOpen(): boolean {
    return (
      this.titleEl.classList.contains('on') ||
      this.systemMenu.open ||
      this.backlog.open ||
      this.confirmBox.open ||
      this.choicesEl.classList.contains('on')
    );
  }

  get titleOpen(): boolean {
    return this.titleEl.classList.contains('on');
  }

  get backlogOpen(): boolean {
    return this.backlog.open;
  }

  get confirmOpen(): boolean {
    return this.confirmBox.open;
  }

  // ---------- 文本窗 / 控制条 ----------

  showDialogue(line: TextLineView, opts: { cps: number; instant: boolean }): void {
    this.textWindow.setOpacity(this.settings.windowOpacity);
    this.textWindow.show(line, opts);
  }

  completeText(): void {
    this.textWindow.complete();
  }

  hideText(): void {
    this.textWindow.hide();
  }

  /** 隐藏全部游戏 UI（对话框/控制条/徽标），任意输入恢复 */
  setUIHidden(hidden: boolean): void {
    this.root.classList.toggle('yg-ui-hidden', hidden);
  }

  get isUIHidden(): boolean {
    return this.uiHidden;
  }

  setDockActive(id: 'auto' | 'skip', on: boolean): void {
    this.dock.setActive(id, on);
  }

  // ---------- 确认弹窗 ----------

  confirm(message: string): Promise<boolean> {
    return this.confirmBox.ask(message);
  }

  // ---------- 选择肢 ----------

  showChoices(prompt: string | null, options: ChoiceButton[], onPick: (i: number) => void): void {
    this.choicePick = onPick;
    this.choicePromptEl.textContent = prompt ?? '';
    this.choiceListEl.replaceChildren();
    this.choiceButtons = [];
    let firstEnabled = 0;
    options.forEach((o, i) => {
      const btn = document.createElement('button');
      btn.className = 'yg-choice-btn' + (o.disabled ? ' dis' : '');
      btn.textContent = o.text;
      btn.disabled = o.disabled;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.pickChoice(i);
      });
      this.choiceListEl.appendChild(btn);
      this.choiceButtons.push(btn);
      if (o.disabled && i === firstEnabled) firstEnabled = i + 1;
    });
    this.choiceSel = Math.min(firstEnabled, this.choiceButtons.length - 1);
    this.syncChoiceSel();
    this.choicesEl.classList.add('on');
  }

  private pickChoice(i: number): void {
    const cb = this.choicePick;
    this.choicesEl.classList.remove('on');
    this.choicePick = null;
    cb?.(i);
  }

  private bindChoicesKeys(): void {
    document.addEventListener('keydown', (e) => {
      if (!this.choicesEl.classList.contains('on')) return;
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const dir = e.key === 'ArrowUp' ? -1 : 1;
        for (let step = 0; step < this.choiceButtons.length; step++) {
          this.choiceSel = (this.choiceSel + dir + this.choiceButtons.length) % this.choiceButtons.length;
          if (!this.choiceButtons[this.choiceSel]!.disabled) break;
        }
        this.syncChoiceSel();
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const btn = this.choiceButtons[this.choiceSel];
        if (btn && !btn.disabled) this.pickChoice(this.choiceSel);
      }
    });
  }

  private syncChoiceSel(): void {
    this.choiceButtons.forEach((b, i) => b.classList.toggle('sel', i === this.choiceSel));
    this.choiceButtons[this.choiceSel]?.scrollIntoView({ block: 'nearest' });
  }

  // ---------- 标题 ----------

  showTitle(title: string, canContinue: boolean, footNote = ''): void {
    this.titleMain.textContent = title;
    this.titleContBtn.disabled = !canContinue;
    this.titleEl.querySelector('.yg-panel-foot')!.textContent = footNote || 'Yanagi Engine 0.1 · M1';
    this.titleEl.classList.add('on');
    this.hideText();
  }

  hideTitle(): void {
    this.titleEl.classList.remove('on');
  }

  // ---------- 系统界面 ----------

  openSystem(tab: SysTab, slots: SaveSlotView[]): void {
    this.systemMenu.openAt(tab, slots);
  }

  closeSystem(): void {
    this.systemMenu.close();
  }

  get systemOpen(): boolean {
    return this.systemMenu.open;
  }

  get systemTab(): SysTab {
    return this.systemMenu.currentTab;
  }

  setSystemSlots(slots: SaveSlotView[]): void {
    this.systemMenu.setSlots(slots);
    this.quickBar.setSlots(slots);
  }

  /** 游戏内才显示右缘快速栏 */
  setQuickBarActive(inGame: boolean): void {
    this.quickBar.el.classList.toggle('in-game', inGame);
  }

  // ---------- 想起 ----------

  openBacklog(entries: BacklogViewEntry[]): void {
    this.backlog.show(entries);
  }

  closeBacklog(): void {
    this.backlog.hide();
  }

  // ---------- 章节题字 / 徽标 / 错误 ----------

  chapterTitle(text: string): void {
    const span = this.chapterEl.querySelector('span')!;
    span.textContent = text;
    this.chapterEl.classList.remove('on');
    void this.chapterEl.offsetWidth; // 重触发动画
    this.chapterEl.classList.add('on');
  }

  setBadge(name: 'auto' | 'skip', on: boolean, text?: string): void {
    const el = name === 'auto' ? this.badgeAuto : this.badgeSkip;
    if (text !== undefined) el.textContent = text;
    el.classList.toggle('on', on);
  }

  showError(message: string): void {
    this.errorTextEl.textContent = message;
    this.errorEl.classList.add('on');
  }

  // ---------- 设置 ----------

  applySettings(s: Settings): void {
    this.settings = { ...s, vol: { ...s.vol } };
    this.textWindow.setOpacity(s.windowOpacity);
  }

  // ---------- 事件绑定 ----------

  private bindCommon(): void {
    this.root.addEventListener('pointerdown', (e) => {
      const t = e.target as Element;
      if (t.closest('button, input, .yg-panel, .yg-log-panel, .yg-sys-panel, .yg-qbar, .yg-confirm-panel, .yg-title')) return;
      this.hooks.advance();
    });

    this.titleEl.addEventListener('click', (e) => {
      const act = (e.target as Element).closest('[data-act]')?.getAttribute('data-act');
      switch (act) {
        case 'start': this.hooks.titleStart(); break;
        case 'continue': this.hooks.titleContinue(); break;
        case 'load': this.hooks.titleLoad(); break;
        case 'settings': this.hooks.titleSettings(); break;
      }
    });

    this.errorEl.querySelector('.yg-close')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.errorEl.classList.remove('on');
    });
  }
}

export type { BacklogViewEntry, SysTab, DockAction };
export type { BacklogEntry } from '@yanagi/core';
