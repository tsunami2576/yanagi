/** 风险操作确认弹窗：默认聚焦"是"（Enter 确认 / Esc 取消；浏览器无法移动鼠标指针，以默认选中替代）。 */
export class ConfirmBox {
  readonly el: HTMLElement;
  private readonly msgEl: HTMLElement;
  private readonly yesBtn: HTMLButtonElement;
  private resolve: ((v: boolean) => void) | null = null;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'yg-confirm';
    this.el.innerHTML = `
      <div class="yg-confirm-panel">
        <div class="yg-confirm-msg"></div>
        <div class="yg-confirm-btns">
          <button class="yg-btn yg-confirm-yes">是</button>
          <button class="yg-btn yg-confirm-no">否</button>
        </div>
      </div>`;
    this.msgEl = this.el.querySelector('.yg-confirm-msg')!;
    this.yesBtn = this.el.querySelector('.yg-confirm-yes')!;
    parent.appendChild(this.el);
    this.yesBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.done(true);
    });
    this.el.querySelector('.yg-confirm-no')!.addEventListener('click', (e) => {
      e.stopPropagation();
      this.done(false);
    });
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
    document.addEventListener('keydown', (e) => {
      if (!this.open) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        this.done(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.done(false);
      }
    });
  }

  get open(): boolean {
    return this.el.classList.contains('on');
  }

  ask(message: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.msgEl.textContent = message;
      this.el.classList.add('on');
      this.resolve = resolve;
      this.yesBtn.focus();
    });
  }

  private done(v: boolean): void {
    this.el.classList.remove('on');
    this.resolve?.(v);
    this.resolve = null;
  }
}
