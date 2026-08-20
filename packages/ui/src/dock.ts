/** 对话框底部控制条：隐藏/快存/快读/上一选项/记录/自动/快进/下一选项/设置/存档/读档。 */

export type DockAction =
  | 'hide'
  | 'qsave'
  | 'qload'
  | 'prevChoice'
  | 'log'
  | 'auto'
  | 'skip'
  | 'nextChoice'
  | 'settings'
  | 'save'
  | 'load';

const DOCK_BUTTONS: { id: DockAction; label: string; title: string }[] = [
  { id: 'hide', label: '隐', title: '隐藏对话框' },
  { id: 'qsave', label: '快存', title: '快速存档' },
  { id: 'qload', label: '快读', title: '快速读档' },
  { id: 'prevChoice', label: '⏮', title: '返回上一个选择' },
  { id: 'log', label: '◀', title: '对话记录' },
  { id: 'auto', label: 'AUTO', title: '自动模式' },
  { id: 'skip', label: '▶', title: '快进（跳过已读/全部）' },
  { id: 'nextChoice', label: '⏭', title: '跳转至下一个选择' },
  { id: 'settings', label: '⚙', title: '设置' },
  { id: 'save', label: '存', title: '存档' },
  { id: 'load', label: '读', title: '读档' },
];

export class DockBar {
  readonly el: HTMLElement;
  private readonly buttons = new Map<DockAction, HTMLButtonElement>();

  constructor(parent: HTMLElement, onAction: (id: DockAction) => void) {
    this.el = document.createElement('div');
    this.el.className = 'yg-dock';
    for (const b of DOCK_BUTTONS) {
      const btn = document.createElement('button');
      btn.className = 'yg-dock-btn';
      btn.dataset.id = b.id;
      btn.title = b.title;
      btn.textContent = b.label;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        onAction(b.id);
      });
      this.el.appendChild(btn);
      this.buttons.set(b.id, btn);
    }
    parent.appendChild(this.el);
  }

  setActive(id: 'auto' | 'skip', on: boolean): void {
    this.buttons.get(id)?.classList.toggle('on', on);
  }
}
