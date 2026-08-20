/** 文本窗：行内标记 → DOM，预布局打字机（只翻转 visibility，不触发重排）。 */
import type { SpanStyle, TextNode } from '@yanagi/core';

export interface TextLineView {
  displayName: string | null;
  color: string | null;
  segments: TextNode[];
}

interface Unit {
  el: HTMLElement;
  /** 该单元显示后的额外停留（pause） */
  postDelay: number;
  /** 覆盖速度（字/秒）；-1 = 继承；0 = 瞬间 */
  cpsOverride: number;
}

const segmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter('zh', { granularity: 'grapheme' })
    : null;

function graphemes(text: string): string[] {
  if (!segmenter) return Array.from(text);
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

export class TextWindow {
  readonly el: HTMLElement;
  private readonly nameEl: HTMLElement;
  private readonly nameText: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private readonly indEl: HTMLElement;

  private units: Unit[] = [];
  private idx = 0;
  private playing = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private cps = 30;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'yg-textwin';
    this.el.innerHTML = `
      <div class="yg-name"><span class="yg-name-text"></span></div>
      <div class="yg-text" aria-live="polite"></div>
      <div class="yg-ind">▼</div>`;
    this.nameEl = this.el.querySelector('.yg-name')!;
    this.nameText = this.el.querySelector('.yg-name-text')!;
    this.bodyEl = this.el.querySelector('.yg-text')!;
    this.indEl = this.el.querySelector('.yg-ind')!;
    parent.appendChild(this.el);
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  setOpacity(opacity: number): void {
    this.el.style.setProperty('--yg-win-bg-alpha', String(Math.min(1, Math.max(0.5, opacity))));
  }

  show(line: TextLineView, opts: { cps: number; instant: boolean }): void {
    this.stopTimer();
    this.units = [];
    this.idx = 0;
    this.bodyEl.replaceChildren();
    this.indEl.classList.remove('on');

    if (line.displayName) {
      this.nameEl.style.display = '';
      this.nameText.textContent = line.displayName;
      this.nameEl.style.setProperty('--yg-name-color', line.color ?? 'var(--yg-sakura)');
    } else {
      this.nameEl.style.display = 'none';
    }

    const ctx = { style: {} as SpanStyle, cps: -1 };
    this.build(line.segments, ctx);
    this.el.classList.add('on');

    this.cps = opts.cps;
    if (opts.instant || opts.cps <= 0) {
      this.revealAll();
    } else {
      this.playing = true;
      this.revealNext();
    }
  }

  hide(): void {
    this.el.classList.remove('on');
    this.stopTimer();
    this.playing = false;
  }

  complete(): void {
    this.revealAll();
  }

  // ---------- 内部 ----------

  private revealAll(): void {
    this.stopTimer();
    for (const u of this.units) u.el.classList.add('on');
    this.playing = false;
    this.indEl.classList.add('on');
  }

  private revealNext(): void {
    const u = this.units[this.idx];
    if (!u) {
      this.revealAll();
      return;
    }
    u.el.classList.add('on');
    this.idx += 1;
    if (this.idx >= this.units.length) {
      this.playing = false;
      this.indEl.classList.add('on');
      return;
    }
    const per = u.cpsOverride === 0 ? 0 : u.cpsOverride > 0 ? 1000 / u.cpsOverride : 1000 / this.cps;
    this.timer = setTimeout(() => this.revealNext(), per + u.postDelay);
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private makeUnit(
    parent: HTMLElement,
    style: SpanStyle,
    cpsOverride: number,
    content: string | Node,
  ): void {
    const span = document.createElement('span');
    span.className = 'yg-u';
    if (style.b) span.style.fontWeight = '600';
    if (style.i) span.style.fontStyle = 'italic';
    if (style.em) span.classList.add('yg-em');
    if (style.shake) span.classList.add('yg-shake');
    if (style.color) span.style.color = style.color;
    if (style.size) span.style.fontSize = `${style.size}%`;
    if (typeof content === 'string') span.textContent = content;
    else span.appendChild(content);
    parent.appendChild(span);
    this.units.push({ el: span, postDelay: 0, cpsOverride });
  }

  /** 递归构建 DOM；文本字符逐个成单元，ruby 整体一个单元。 */
  private build(nodes: TextNode[], ctx: { style: SpanStyle; cps: number }): void {
    for (const node of nodes) {
      switch (node.t) {
        case 'text':
          for (const ch of graphemes(node.v)) {
            this.makeUnit(this.bodyEl, ctx.style, ctx.cps, ch);
          }
          break;
        case 'br':
          this.makeUnit(this.bodyEl, ctx.style, ctx.cps, document.createElement('br'));
          break;
        case 'ruby': {
          const ruby = document.createElement('ruby');
          const base = document.createElement('span');
          base.textContent = node.base;
          const rt = document.createElement('rt');
          rt.textContent = node.rt;
          ruby.append(base, rt);
          this.makeUnit(this.bodyEl, ctx.style, ctx.cps, ruby);
          break;
        }
        case 'pause': {
          const last = this.units[this.units.length - 1];
          if (last) last.postDelay += node.ms;
          break;
        }
        case 'speed':
          this.build(node.children, { style: ctx.style, cps: node.cps });
          break;
        case 'span':
          this.build(node.children, { style: { ...ctx.style, ...node.style }, cps: ctx.cps });
          break;
      }
    }
  }
}
