/** GameUI：所有 DOM UI 的总装。session 通过它驱动一切界面。 */
import type { BacklogEntry, TextNode } from '@yanagi/core';
import { TextWindow, type TextLineView } from './text-window';

export interface Settings {
  /** 每秒字数；0 = 瞬间 */
  textCps: number;
  autoBaseMs: number;
  autoPerCharMs: number;
  vol: { bgm: number; se: number; voice: number; ambient: number };
  /** 文本窗不透明度 0.5–1 */
  windowOpacity: number;
}

export const DEFAULT_SETTINGS: Settings = {
  textCps: 30,
  autoBaseMs: 1100,
  autoPerCharMs: 18,
  vol: { bgm: 0.8, se: 0.8, voice: 0.9, ambient: 0.7 },
  windowOpacity: 1,
};

export interface UIHooks {
  advance(): void;
  titleStart(): void;
  titleContinue(): void;
  titleLoad(): void;
  titleSettings(): void;
  pauseResume(): void;
  pauseSave(): void;
  pauseLoad(): void;
  pauseSettings(): void;
  pauseTitle(): void;
  saveSlot(slot: string): void;
  loadSlot(slot: string): void;
  settingsChange(s: Settings): void;
  replayVoice(voice: string): void;
  /** 面板被用户关闭（用于判断是否回到标题等上下文） */
  panelClosed(): void;
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

interface ChoiceButton {
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
  private readonly pauseEl: HTMLElement;
  private readonly settingsEl: HTMLElement;
  private readonly saveEl: HTMLElement;
  private readonly saveTitle: HTMLElement;
  private readonly saveGrid: HTMLElement;
  private readonly backlogEl: HTMLElement;
  private readonly backlogList: HTMLElement;
  private readonly choicesEl: HTMLElement;
  private readonly choicePromptEl: HTMLElement;
  private readonly choiceListEl: HTMLElement;
  private readonly chapterEl: HTMLElement;
  private readonly errorEl: HTMLElement;
  private readonly errorTextEl: HTMLElement;
  private readonly badgeAuto: HTMLElement;
  private readonly badgeSkip: HTMLElement;

  private choiceButtons: HTMLButtonElement[] = [];
  private choiceSel = 0;
  private choicePick: ((i: number) => void) | null = null;
  private saveMode: 'save' | 'load' = 'save';
  private saveOrigin: 'title' | 'pause' = 'title';
  private settingsOrigin: 'title' | 'pause' = 'title';
  private settings: Settings = { ...DEFAULT_SETTINGS };

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

    this.pauseEl = mk(
      'yg-overlay',
      `<div class="yg-panel">
         <h2>菜 单</h2>
         <button class="yg-btn" data-act="resume">回到游戏</button>
         <button class="yg-btn" data-act="save">保存进度</button>
         <button class="yg-btn" data-act="load">读取进度</button>
         <button class="yg-btn" data-act="settings">设置</button>
         <button class="yg-btn" data-act="title">回到标题</button>
       </div>`,
    );

    this.settingsEl = mk(
      'yg-overlay',
      `<div class="yg-panel">
         <h2>设 置</h2>
         <div class="yg-set-rows"></div>
         <button class="yg-btn yg-close">关 闭</button>
       </div>`,
    );

    this.saveEl = mk(
      'yg-overlay',
      `<div class="yg-panel" style="width:min(680px,94vw)">
         <h2 class="yg-save-title"></h2>
         <div class="yg-save-grid"></div>
         <button class="yg-btn yg-close" style="margin-top:16px">关 闭</button>
       </div>`,
    );
    this.saveTitle = this.saveEl.querySelector('.yg-save-title')!;
    this.saveGrid = this.saveEl.querySelector('.yg-save-grid')!;

    this.backlogEl = mk(
      'yg-backlog',
      `<div class="yg-panel" style="box-shadow:none;background:transparent;border:none;padding:18px 20px 8px;display:flex;align-items:center">
         <h2 style="margin:0;flex:1">想 起</h2>
         <button class="yg-btn yg-close" style="width:auto;margin:0;padding:6px 18px">关闭 (L)</button>
       </div>
       <div class="yg-backlog-list"></div>`,
    );
    this.backlogList = this.backlogEl.querySelector('.yg-backlog-list')!;

    this.errorEl = mk(
      'yg-overlay',
      `<div class="yg-panel">
         <h2>出 错</h2>
         <div class="yg-error-text"></div>
         <button class="yg-btn yg-close">关 闭</button>
       </div>`,
    );
    this.errorTextEl = this.errorEl.querySelector('.yg-error-text')!;

    this.bindCommon();
    this.bindChoicesKeys();
  }

  // ---------- 状态查询 ----------

  get textPlaying(): boolean {
    return this.textWindow.isPlaying;
  }

  /** 任何遮住舞台、需要屏蔽"前进"输入的面板 */
  get overlayOpen(): boolean {
    return (
      this.titleEl.classList.contains('on') ||
      this.pauseEl.classList.contains('on') ||
      this.settingsEl.classList.contains('on') ||
      this.saveEl.classList.contains('on') ||
      this.choicesEl.classList.contains('on')
    );
  }

  get titleOpen(): boolean {
    return this.titleEl.classList.contains('on');
  }

  get backlogOpen(): boolean {
    return this.backlogEl.classList.contains('on');
  }

  // ---------- 文本窗 ----------

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
      const enabled = this.choiceButtons.filter((b) => !b.disabled);
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
      void enabled;
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
    this.titleEl.querySelector('.yg-panel-foot')!.textContent = footNote || 'Yanagi Engine 0.1 · M0';
    this.titleEl.classList.add('on');
    this.hideText();
  }

  hideTitle(): void {
    this.titleEl.classList.remove('on');
  }

  // ---------- 暂停菜单 ----------

  get pauseOpen(): boolean {
    return this.pauseEl.classList.contains('on');
  }

  openPause(): void {
    this.pauseEl.classList.add('on');
  }

  closePause(): void {
    this.pauseEl.classList.remove('on');
  }

  // ---------- 设置 ----------

  openSettings(origin: 'title' | 'pause'): void {
    this.settingsOrigin = origin;
    this.buildSettingsRows();
    this.settingsEl.classList.add('on');
  }

  closeSettings(): void {
    this.settingsEl.classList.remove('on');
  }

  get settingsOpen(): boolean {
    return this.settingsEl.classList.contains('on');
  }

  applySettings(s: Settings): void {
    this.settings = { ...s, vol: { ...s.vol } };
    this.textWindow.setOpacity(s.windowOpacity);
  }

  private buildSettingsRows(): void {
    const rows = this.settingsEl.querySelector('.yg-set-rows')!;
    rows.replaceChildren();
    const slider = (
      label: string,
      min: number,
      max: number,
      step: number,
      get: () => number,
      fmt: (v: number) => string,
      set: (v: number) => void,
    ): void => {
      const row = document.createElement('div');
      row.className = 'yg-set-row';
      row.innerHTML = `<label>${label}</label><input type="range"><output></output>`;
      const input = row.querySelector('input')!;
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(get());
      const out = row.querySelector('output')!;
      out.textContent = fmt(get());
      input.addEventListener('input', () => {
        const v = Number(input.value);
        out.textContent = fmt(v);
        set(v);
        this.hooks.settingsChange({ ...this.settings, vol: { ...this.settings.vol } });
      });
      rows.appendChild(row);
    };
    const s = this.settings;
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    slider('文字速度', 0, 60, 1, () => s.textCps, (v) => (v === 0 ? '瞬间' : `${v} 字/秒`), (v) => (s.textCps = v));
    slider('自动模式等待', 300, 3000, 50, () => s.autoBaseMs, (v) => `${(v / 1000).toFixed(1)}s`, (v) => (s.autoBaseMs = v));
    slider('BGM 音量', 0, 100, 1, () => s.vol.bgm * 100, (v) => `${v}`, (v) => (s.vol.bgm = v / 100));
    slider('语音音量', 0, 100, 1, () => s.vol.voice * 100, (v) => `${v}`, (v) => (s.vol.voice = v / 100));
    slider('音效音量', 0, 100, 1, () => s.vol.se * 100, (v) => `${v}`, (v) => (s.vol.se = v / 100));
    slider('环境音量', 0, 100, 1, () => s.vol.ambient * 100, (v) => `${v}`, (v) => (s.vol.ambient = v / 100));
    slider('文本窗不透明度', 50, 100, 1, () => s.windowOpacity * 100, (v) => `${v}`, (v) => (s.windowOpacity = v / 100));
  }

  // ---------- 存档 ----------

  openSaveMenu(mode: 'save' | 'load', origin: 'title' | 'pause', slots: SaveSlotView[]): void {
    this.saveMode = mode;
    this.saveOrigin = origin;
    this.saveTitle.textContent = mode === 'save' ? '保存进度' : '读取进度';
    this.saveGrid.replaceChildren();
    for (const slot of slots) {
      const btn = document.createElement('button');
      btn.className = 'yg-save-slot';
      const time = slot.empty ? '' : new Date(slot.savedAt).toLocaleString('zh-CN', { hour12: false });
      btn.innerHTML = slot.thumbUrl
        ? `<img class="yg-save-thumb" src="${slot.thumbUrl}" alt="">`
        : `<div class="yg-save-thumb"></div>`;
      const meta = document.createElement('div');
      meta.className = 'yg-save-meta';
      meta.innerHTML = `<b>${slot.label}</b>${slot.empty ? '— 空 —' : `${escapeHtml(slot.chapterTitle || '序章')}<br>${escapeHtml(slot.lineSummary)}<br>${time}`}`;
      btn.appendChild(meta);
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.saveMode === 'save') this.hooks.saveSlot(slot.slot);
        else this.hooks.loadSlot(slot.slot);
      });
      this.saveGrid.appendChild(btn);
    }
    this.saveEl.classList.add('on');
  }

  closeSaveMenu(): void {
    this.saveEl.classList.remove('on');
  }

  get saveOpen(): boolean {
    return this.saveEl.classList.contains('on');
  }

  // ---------- 想起 ----------

  openBacklog(entries: BacklogEntry[]): void {
    this.backlogList.replaceChildren();
    const frag = document.createDocumentFragment();
    for (const e of entries) {
      const item = document.createElement('div');
      item.className = 'yg-backlog-item' + (e.speaker ? '' : ' narration');
      const name = document.createElement('span');
      name.className = 'yg-backlog-name';
      name.textContent = e.name ?? '';
      const text = document.createElement('span');
      text.textContent = e.text;
      item.append(name, text);
      if (e.voice) {
        const btn = document.createElement('button');
        btn.className = 'yg-voice-btn';
        btn.textContent = '▶ 语音';
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this.hooks.replayVoice(e.voice!);
        });
        item.appendChild(btn);
      }
      frag.appendChild(item);
    }
    this.backlogList.appendChild(frag);
    this.backlogList.scrollTop = this.backlogList.scrollHeight;
    this.backlogEl.classList.add('on');
  }

  closeBacklog(): void {
    this.backlogEl.classList.remove('on');
  }

  toggleBacklog(entries: BacklogEntry[]): void {
    if (this.backlogOpen) this.closeBacklog();
    else this.openBacklog(entries);
  }

  // ---------- 章节题字 / 错误 ----------

  chapterTitle(text: string): void {
    const span = this.chapterEl.querySelector('span')!;
    span.textContent = text;
    this.chapterEl.classList.remove('on');
    void this.chapterEl.offsetWidth; // 重触发动画
    this.chapterEl.classList.add('on');
  }

  /** 右上角状态徽标（AUTO / SKIP） */
  setBadge(name: 'auto' | 'skip', on: boolean, text?: string): void {
    const el = name === 'auto' ? this.badgeAuto : this.badgeSkip;
    if (text !== undefined) el.textContent = text;
    el.classList.toggle('on', on);
  }

  showError(message: string): void {
    this.errorTextEl.textContent = message;
    this.errorEl.classList.add('on');
  }

  // ---------- 事件绑定 ----------

  private bindCommon(): void {
    this.root.addEventListener('pointerdown', (e) => {
      const t = e.target as Element;
      if (t.closest('button, input, .yg-panel, .yg-backlog, .yg-title')) return;
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

    this.pauseEl.addEventListener('click', (e) => {
      const act = (e.target as Element).closest('[data-act]')?.getAttribute('data-act');
      switch (act) {
        case 'resume': this.hooks.pauseResume(); break;
        case 'save': this.hooks.pauseSave(); break;
        case 'load': this.hooks.pauseLoad(); break;
        case 'settings': this.hooks.pauseSettings(); break;
        case 'title': this.hooks.pauseTitle(); break;
      }
    });

    for (const el of [this.settingsEl, this.saveEl]) {
      el.querySelector('.yg-close')?.addEventListener('click', (e) => {
        e.stopPropagation();
        el.classList.remove('on');
        this.hooks.panelClosed();
      });
    }
    this.backlogEl.querySelector('.yg-close')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.closeBacklog();
    });
    this.errorEl.querySelector('.yg-close')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.errorEl.classList.remove('on');
    });
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
