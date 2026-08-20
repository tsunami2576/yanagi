/**
 * 对话记录（居中宽面板）：正序、最新在下自动滚底；每条预留头像位；
 * ⏪ 回溯按钮；语音重播；滚轮在底部再向下滚 = 关闭。
 */
import type { BacklogEntry } from '@yanagi/core';

export type BacklogViewEntry = BacklogEntry & { read?: boolean; canRollback?: boolean };

export class BacklogPanel {
  readonly el: HTMLElement;
  private readonly listEl: HTMLElement;

  constructor(
    parent: HTMLElement,
    private readonly hooks: {
      onRollback: (uid: string) => void;
      onReplayVoice: (voice: string) => void;
      onClose: () => void;
    },
    private avatarFor: (charId: string | null) => string | undefined,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'yg-log';
    this.el.innerHTML = `
      <div class="yg-log-panel">
        <div class="yg-log-head">
          <h2>对话记录</h2>
          <button class="yg-btn yg-log-close">关 闭</button>
        </div>
        <div class="yg-log-list"></div>
        <div class="yg-log-foot">滚轮向下到底可关闭 · ⏪ 回溯到此句</div>
      </div>`;
    this.listEl = this.el.querySelector('.yg-log-list')!;
    parent.appendChild(this.el);

    this.el.querySelector('.yg-log-close')!.addEventListener('click', (e) => {
      e.stopPropagation();
      hooks.onClose();
    });
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
    // 滚轮已在底部再向下 = 关闭
    this.listEl.addEventListener('wheel', (e) => {
      if (e.deltaY <= 0) return;
      const { scrollTop, clientHeight, scrollHeight } = this.listEl;
      if (scrollTop + clientHeight >= scrollHeight - 2) {
        e.preventDefault();
        hooks.onClose();
      }
    });
  }

  get open(): boolean {
    return this.el.classList.contains('on');
  }

  show(entries: BacklogViewEntry[]): void {
    this.listEl.replaceChildren();
    const frag = document.createDocumentFragment();
    for (const e of entries) {
      const item = document.createElement('div');
      item.className =
        'yg-log-item' +
        (e.kind === 'choice' ? ' choice' : e.speaker ? '' : ' narration') +
        (e.read ? ' read' : '');

      const back = document.createElement('button');
      back.className = 'yg-rollback-btn';
      back.textContent = '⏪';
      back.title = '回溯到此句';
      if (!e.canRollback) back.style.visibility = 'hidden';
      back.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.hide();
        this.hooks.onRollback(e.uid);
      });
      item.appendChild(back);

      const avatarWrap = document.createElement('div');
      avatarWrap.className = 'yg-log-avatar';
      if (e.kind === 'choice') {
        avatarWrap.classList.add('choice');
        avatarWrap.textContent = '❖';
      } else {
        const url = this.avatarFor(e.speaker);
        if (url) {
          const img = document.createElement('img');
          img.src = url;
          img.alt = e.name ?? '';
          avatarWrap.appendChild(img);
        }
      }
      item.appendChild(avatarWrap);

      const body = document.createElement('div');
      body.className = 'yg-log-body';
      const name = document.createElement('div');
      name.className = 'yg-log-name';
      name.textContent = e.kind === 'choice' ? '选择' : (e.name ?? '');
      const text = document.createElement('div');
      text.className = 'yg-log-text';
      text.textContent = e.text;
      body.append(name, text);
      item.appendChild(body);

      if (e.voice) {
        const btn = document.createElement('button');
        btn.className = 'yg-voice-btn';
        btn.textContent = '▶';
        btn.title = '重播语音';
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this.hooks.onReplayVoice(e.voice!);
        });
        item.appendChild(btn);
      }
      frag.appendChild(item);
    }
    this.listEl.appendChild(frag);
    this.listEl.scrollTop = this.listEl.scrollHeight;
    this.el.classList.add('on');
  }

  hide(): void {
    this.el.classList.remove('on');
  }
}
