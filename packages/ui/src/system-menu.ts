/**
 * 系统界面（柚子社式）：左侧页签（画面/声音/文本/操作/其他/存档/读档）+ 右侧内容区 + 底栏
 * （返回游戏 / 返回主菜单 / 桌面端退出游戏）。存读档为分页格子。
 */
import type { SaveSlotView, Settings } from './game-ui';

export type SysTab = 'visual' | 'audio' | 'text' | 'controls' | 'misc' | 'save' | 'load';

export const SYS_TABS: { id: SysTab; label: string }[] = [
  { id: 'visual', label: '画 面' },
  { id: 'audio', label: '声 音' },
  { id: 'text', label: '文 本' },
  { id: 'controls', label: '操 作' },
  { id: 'misc', label: '其 他' },
  { id: 'save', label: '存 档' },
  { id: 'load', label: '读 档' },
];

const GRID_PAGE = 8;

/** 桌面端（Tauri）才为 true —— 显示"退出游戏"。 */
function isDesktop(): boolean {
  return typeof (window as unknown as { __TAURI__?: unknown }).__TAURI__ !== 'undefined';
}

export interface SystemMenuHooks {
  settingsChange(s: Settings): void;
  saveSlot(slot: string): void;
  loadSlot(slot: string): void;
  exportSaves(): void;
  importFile(file: File): void;
  systemAction(id: 'resume' | 'toTitle' | 'exit'): void;
}

export class SystemMenu {
  readonly el: HTMLElement;
  private readonly tabsEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private readonly importInput: HTMLInputElement;
  private tab: SysTab = 'visual';
  private slots: SaveSlotView[] = [];
  private gridPage = 0;

  constructor(
    parent: HTMLElement,
    private hooks: SystemMenuHooks,
    private getSettings: () => Settings,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'yg-sys';
    this.el.innerHTML = `
      <div class="yg-sys-panel">
        <div class="yg-sys-tabs"></div>
        <div class="yg-sys-body"></div>
        <div class="yg-sys-foot">
          <button class="yg-btn" data-act="resume">返回游戏</button>
          <button class="yg-btn" data-act="toTitle">返回主菜单</button>
          <button class="yg-btn yg-sys-exit" data-act="exit">退出游戏</button>
        </div>
        <input type="file" accept="application/json,.json" style="display:none">
      </div>`;
    this.tabsEl = this.el.querySelector('.yg-sys-tabs')!;
    this.bodyEl = this.el.querySelector('.yg-sys-body')!;
    this.importInput = this.el.querySelector('input[type="file"]')!;
    if (!isDesktop()) this.el.querySelector('.yg-sys-exit')?.remove();
    parent.appendChild(this.el);

    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.el.querySelector('.yg-sys-foot')!.addEventListener('click', (e) => {
      const act = (e.target as Element).closest('[data-act]')?.getAttribute('data-act');
      if (act) this.hooks.systemAction(act as 'resume' | 'toTitle' | 'exit');
    });
    this.importInput.addEventListener('change', () => {
      const file = this.importInput.files?.[0];
      this.importInput.value = '';
      if (file) this.hooks.importFile(file);
    });
  }

  get open(): boolean {
    return this.el.classList.contains('on');
  }

  get currentTab(): SysTab {
    return this.tab;
  }

  openAt(tab: SysTab, slots: SaveSlotView[]): void {
    this.tab = tab;
    this.slots = slots;
    this.el.classList.add('on');
    this.render();
  }

  close(): void {
    this.el.classList.remove('on');
  }

  setSlots(slots: SaveSlotView[]): void {
    this.slots = slots;
    if (this.open && (this.tab === 'save' || this.tab === 'load')) this.renderGrid();
  }

  // ---------- 渲染 ----------

  private render(): void {
    this.tabsEl.replaceChildren();
    for (const t of SYS_TABS) {
      const b = document.createElement('button');
      b.className = 'yg-sys-tab' + (t.id === this.tab ? ' on' : '');
      b.textContent = t.label;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.tab = t.id;
        this.gridPage = 0;
        this.render();
      });
      this.tabsEl.appendChild(b);
    }
    this.bodyEl.replaceChildren();
    switch (this.tab) {
      case 'visual':
        this.buildVisual();
        break;
      case 'audio':
        this.buildAudio();
        break;
      case 'text':
        this.buildText();
        break;
      case 'controls':
        this.buildControls();
        break;
      case 'misc':
        this.buildMisc();
        break;
      case 'save':
      case 'load':
        this.buildGrid(this.tab);
        break;
    }
  }

  private page(): HTMLElement {
    const p = document.createElement('div');
    p.className = 'yg-sys-page';
    this.bodyEl.appendChild(p);
    return p;
  }

  private slider(
    host: HTMLElement,
    label: string,
    min: number,
    max: number,
    step: number,
    get: () => number,
    fmt: (v: number) => string,
    set: (v: number) => void,
  ): void {
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
      this.hooks.settingsChange({ ...this.getSettings(), vol: { ...this.getSettings().vol } });
    });
    host.appendChild(row);
  }

  private toggle(host: HTMLElement, label: string, get: () => boolean, set: (v: boolean) => void): void {
    this.slider(host, label, 0, 1, 1, () => (get() ? 1 : 0), (v) => (v ? '开' : '关'), (v) => set(v === 1));
  }

  private buildVisual(): void {
    const p = this.page();
    p.innerHTML = `<h3>画面</h3>`;
    const fsRow = document.createElement('div');
    fsRow.className = 'yg-set-row';
    fsRow.innerHTML = `<label>全屏</label><button class="yg-btn" style="grid-column:2/4">切换全屏 (F)</button>`;
    fsRow.querySelector('button')!.addEventListener('click', () => {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void document.documentElement.requestFullscreen().catch(() => undefined);
    });
    p.appendChild(fsRow);
    const s = this.getSettings();
    this.slider(p, '文本窗不透明度', 50, 100, 1, () => s.windowOpacity * 100, (v) => `${v}%`, (v) => (s.windowOpacity = v / 100));
    this.slider(p, '粒子密度', 20, 100, 5, () => s.particleDensity * 100, (v) => `${v}%`, (v) => (s.particleDensity = v / 100));
  }

  private buildAudio(): void {
    const p = this.page();
    p.innerHTML = `<h3>声音</h3>`;
    const s = this.getSettings();
    const pct = (v: number) => `${Math.round(v * 100)}`;
    this.slider(p, '主音量', 0, 100, 1, () => s.vol.master * 100, pct, (v) => (s.vol.master = v / 100));
    this.slider(p, 'BGM', 0, 100, 1, () => s.vol.bgm * 100, pct, (v) => (s.vol.bgm = v / 100));
    this.slider(p, '语音', 0, 100, 1, () => s.vol.voice * 100, pct, (v) => (s.vol.voice = v / 100));
    this.slider(p, '音效', 0, 100, 1, () => s.vol.se * 100, pct, (v) => (s.vol.se = v / 100));
    this.slider(p, '环境音', 0, 100, 1, () => s.vol.ambient * 100, pct, (v) => (s.vol.ambient = v / 100));
  }

  private buildText(): void {
    const p = this.page();
    p.innerHTML = `<h3>文本</h3>`;
    const s = this.getSettings();
    this.slider(p, '文字速度', 0, 60, 1, () => s.textCps, (v) => (v === 0 ? '瞬间' : `${v} 字/秒`), (v) => (s.textCps = v));
    this.slider(p, '自动等待', 300, 3000, 50, () => s.autoBaseMs, (v) => `${(v / 1000).toFixed(1)}s`, (v) => (s.autoBaseMs = v));
    this.slider(p, '自动逐字附加', 0, 60, 1, () => s.autoPerCharMs, (v) => `${v}ms`, (v) => (s.autoPerCharMs = v));
    this.toggle(p, '回想中已读浅色', () => s.backlogReadDim, (v) => (s.backlogReadDim = v));
  }

  private buildControls(): void {
    const p = this.page();
    const s = this.getSettings();
    p.innerHTML = `
      <h3>操作</h3>
      <table class="yg-keymap">
        <tr><td>前进</td><td>鼠标左键 / Enter / 滚轮下</td></tr>
        <tr><td>补全当前行</td><td>前进键首次触发</td></tr>
        <tr><td>自动模式</td><td>A</td></tr>
        <tr><td>快进（全部）</td><td>Tab ×2 / Ctrl 按住</td></tr>
        <tr><td>对话记录</td><td>滚轮上 / L</td></tr>
        <tr><td>系统界面</td><td>Esc / 右键</td></tr>
        <tr><td>全屏</td><td>F</td></tr>
      </table>
      <h3 class="yg-keymap-h">按键功能自定义</h3>`;
    const optRow = (label: string, options: { id: string; name: string }[], cur: () => string, apply: (v: string) => void): void => {
      const row = document.createElement('div');
      row.className = 'yg-opt-row';
      row.innerHTML = `<label>${label}</label><span class="yg-opt-btns"></span>`;
      const wrap = row.querySelector('.yg-opt-btns')!;
      for (const opt of options) {
        const b = document.createElement('button');
        b.className = 'yg-btn' + (cur() === opt.id ? ' on' : '');
        b.textContent = opt.name;
        b.addEventListener('click', () => {
          apply(opt.id);
          wrap.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
          this.hooks.settingsChange({ ...this.getSettings(), vol: { ...this.getSettings().vol } });
        });
        wrap.appendChild(b);
      }
      p.appendChild(row);
    };
    optRow(
      '空格键',
      [
        { id: 'hideWindow', name: '隐藏对话框' },
        { id: 'advance', name: '下一句' },
      ],
      () => s.spaceAction,
      (v) => (s.spaceAction = v as Settings['spaceAction']),
    );
    optRow(
      '右键',
      [
        { id: 'menu', name: '打开菜单' },
        { id: 'hideWindow', name: '隐藏对话框' },
      ],
      () => s.rightAction,
      (v) => (s.rightAction = v as Settings['rightAction']),
    );
  }

  private buildMisc(): void {
    const p = this.page();
    p.innerHTML = `<h3>其他</h3>`;
    const s = this.getSettings();
    this.toggle(p, '失焦时静音', () => s.muteOnBlur, (v) => (s.muteOnBlur = v));
    const row = document.createElement('div');
    row.className = 'yg-set-row';
    row.innerHTML = `<label>存储持久化</label><output style="grid-column:2/4;text-align:left">检测中…</output>`;
    p.appendChild(row);
    void navigator.storage?.persisted?.().then((ok) => {
      row.querySelector('output')!.textContent = ok ? '已授予（数据不易被浏览器清理）' : '未授予（可在浏览器站点设置中允许）';
    });
  }

  private buildGrid(mode: 'save' | 'load'): void {
    const p = this.page();
    const pages = Math.max(1, Math.ceil(this.slots.length / GRID_PAGE));
    if (this.gridPage >= pages) this.gridPage = 0;
    const head = document.createElement('div');
    head.className = 'yg-grid-head';
    head.innerHTML = `<h3>${mode === 'save' ? '存档' : '读档'}</h3>
      <div class="yg-grid-nav"><button data-nav="-1">◀</button><span>${this.gridPage + 1} / ${pages}</span><button data-nav="1">▶</button></div>`;
    head.querySelectorAll('button').forEach((b) =>
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.gridPage = (this.gridPage + Number(b.dataset.nav) + pages) % pages;
        this.render();
      }),
    );
    p.appendChild(head);

    const grid = document.createElement('div');
    grid.className = 'yg-save-grid';
    const slice = this.slots.slice(this.gridPage * GRID_PAGE, (this.gridPage + 1) * GRID_PAGE);
    for (const slot of slice) {
      const system = slot.slot.startsWith('auto:') || slot.slot === 'quick';
      const btn = document.createElement('button');
      btn.className = 'yg-save-slot';
      btn.disabled = (mode === 'save' && system) || (mode === 'load' && slot.empty);
      const time = slot.empty ? '' : new Date(slot.savedAt).toLocaleString('zh-CN', { hour12: false });
      btn.innerHTML = slot.thumbUrl
        ? `<img class="yg-save-thumb" src="${slot.thumbUrl}" alt="">`
        : `<div class="yg-save-thumb"></div>`;
      const meta = document.createElement('div');
      meta.className = 'yg-save-meta';
      const emptyText = mode === 'save' ? (system ? '系统槽位' : '— 空 —') : '— 空 —';
      meta.innerHTML = `<b>${slot.label}</b>${slot.empty ? emptyText : `${esc(slot.chapterTitle || '序章')}<br>${esc(slot.lineSummary)}<br>${time}`}`;
      btn.appendChild(meta);
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (mode === 'save') this.hooks.saveSlot(slot.slot);
        else this.hooks.loadSlot(slot.slot);
      });
      grid.appendChild(btn);
    }
    p.appendChild(grid);

    const tools = document.createElement('div');
    tools.className = 'yg-save-tools';
    tools.innerHTML = `<button class="yg-btn yg-sys-export">导出存档</button><button class="yg-btn yg-sys-import">导入存档</button>`;
    tools.querySelector('.yg-sys-export')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.hooks.exportSaves();
    });
    tools.querySelector('.yg-sys-import')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.importInput.click();
    });
    p.appendChild(tools);
  }

  /** 重绘当前存/读档页的格子（存档后刷新数据用） */
  private renderGrid(): void {
    if (this.tab === 'save' || this.tab === 'load') this.render();
  }
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
