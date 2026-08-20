/** 右缘快速存档栏：默认收缩在屏幕外，鼠标靠近右缘弹出；竖排槽位 + 翻页 + 存/读模式切换。 */
import type { SaveSlotView } from './game-ui';

const PAGE_SIZE = 4;

export class QuickBar {
  readonly el: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly pageEl: HTMLElement;
  private slots: SaveSlotView[] = [];
  private page = 0;
  private mode: 'save' | 'load' = 'save';

  constructor(
    parent: HTMLElement,
    private onAction: (slot: string, mode: 'save' | 'load') => void,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'yg-qbar';
    this.el.innerHTML = `
      <div class="yg-qbar-hotzone"></div>
      <div class="yg-qbar-panel">
        <div class="yg-qbar-mode">
          <button data-mode="save" class="on">存档</button>
          <button data-mode="load">读档</button>
        </div>
        <div class="yg-qbar-list"></div>
        <div class="yg-qbar-nav">
          <button data-nav="-1">▲</button>
          <span class="yg-qbar-page"></span>
          <button data-nav="1">▼</button>
        </div>
      </div>`;
    this.listEl = this.el.querySelector('.yg-qbar-list')!;
    this.pageEl = this.el.querySelector('.yg-qbar-page')!;
    parent.appendChild(this.el);

    this.el.querySelectorAll<HTMLButtonElement>('.yg-qbar-mode button').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.mode = b.dataset.mode as 'save' | 'load';
        this.el.querySelectorAll('.yg-qbar-mode button').forEach((x) => x.classList.toggle('on', x === b));
        this.render();
      });
    });
    this.el.querySelectorAll<HTMLButtonElement>('.yg-qbar-nav button').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const dir = Number(b.dataset.nav);
        const pages = Math.max(1, Math.ceil(this.slots.length / PAGE_SIZE));
        this.page = (this.page + dir + pages) % pages;
        this.render();
      });
    });
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  setSlots(slots: SaveSlotView[]): void {
    this.slots = slots;
    const pages = Math.max(1, Math.ceil(slots.length / PAGE_SIZE));
    if (this.page >= pages) this.page = 0;
    this.render();
  }

  private render(): void {
    const pages = Math.max(1, Math.ceil(this.slots.length / PAGE_SIZE));
    this.pageEl.textContent = `${this.page + 1} / ${pages}`;
    this.listEl.replaceChildren();
    const slice = this.slots.slice(this.page * PAGE_SIZE, (this.page + 1) * PAGE_SIZE);
    for (const slot of slice) {
      const card = document.createElement('button');
      card.className = 'yg-qbar-slot';
      const system = slot.slot.startsWith('auto:') || slot.slot === 'quick';
      if (this.mode === 'save' && system) card.disabled = true;
      if (this.mode === 'load' && slot.empty) card.disabled = true;
      card.innerHTML = slot.thumbUrl
        ? `<img src="${slot.thumbUrl}" alt="">`
        : `<div class="yg-qbar-thumb-empty"></div>`;
      const meta = document.createElement('div');
      meta.className = 'yg-qbar-meta';
      meta.innerHTML = `<b>${slot.label}</b>${slot.empty ? '— 空 —' : escapeHtml(slot.lineSummary || slot.chapterTitle)}`;
      card.appendChild(meta);
      card.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onAction(slot.slot, this.mode);
      });
      this.listEl.appendChild(card);
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
