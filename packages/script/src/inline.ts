/** 行内标记解析：[ruby:基;注] [em]…[/em] [color=#f66]…[/color] [pause=300] [br] [speed=0]…[/speed] [[ 转义 */
import type { SpanStyle, TextNode } from '@yanagi/core';

export class InlineError extends Error {
  constructor(
    public readonly col: number,
    message: string,
  ) {
    super(message);
  }
}

interface Frame {
  tag: string;
  col: number;
  style?: SpanStyle;
  cps?: number;
  children: TextNode[];
}

const QUOTE = new Set(['"', "'", '「', '『']);

function parseValue(raw: string, col: number, tag: string): string {
  const v = raw.trim();
  if (QUOTE.has(v[0] ?? '')) return v.slice(1, -1);
  return v;
}

export function parseInline(src: string): { nodes: TextNode[]; plain: string } {
  const root: Frame = { tag: '', col: 1, children: [] };
  const stack: Frame[] = [root];
  let plain = '';
  let i = 0;

  const top = (): Frame => stack[stack.length - 1]!;
  const fail = (col: number, msg: string): never => {
    throw new InlineError(col, msg);
  };

  function handleTag(inner: string, col: number): void {
    if (inner.startsWith('/')) {
      const closing = inner.slice(1);
      if (stack.length === 1) fail(col, '多余的闭合标记');
      const f = top();
      if (closing !== '' && closing !== f.tag) {
        fail(col, `闭合标记不匹配：期待 [/${f.tag}]，得到 [/${closing}]`);
      }
      const closed = stack.pop()!;
      const parent = top();
      if (closed.tag === 'speed') {
        parent.children.push({ t: 'speed', cps: closed.cps ?? 30, children: closed.children });
      } else {
        parent.children.push({ t: 'span', style: closed.style ?? {}, children: closed.children });
      }
      return;
    }
    if (inner.startsWith('ruby:')) {
      const rest = inner.slice(5);
      const sep = rest.indexOf(';');
      if (sep === -1) fail(col, '注音标记应为 [ruby:汉字;读音]');
      const base = rest.slice(0, sep);
      const rt = rest.slice(sep + 1);
      if (!base || !rt) fail(col, '注音标记的基准字或读音为空');
      top().children.push({ t: 'ruby', base, rt });
      plain += base;
      return;
    }
    if (inner === 'br') {
      top().children.push({ t: 'br' });
      plain += '\n';
      return;
    }
    if (inner.startsWith('pause')) {
      const m = /^pause\s*=\s*(\d+)$/.exec(inner);
      if (!m) return fail(col, '停顿标记应为 [pause=毫秒]');
      top().children.push({ t: 'pause', ms: Number(m[1]) });
      return;
    }
    if (inner.startsWith('speed')) {
      const m = /^speed\s*=\s*(\d+)$/.exec(inner);
      if (!m) return fail(col, '变速标记应为 [speed=每秒字数]（0 = 瞬间）');
      stack.push({ tag: 'speed', col, cps: Number(m[1]), children: [] });
      return;
    }
    if (inner.startsWith('color')) {
      const m = /^color\s*=\s*(#[0-9a-fA-F]{3,8})$/.exec(inner);
      if (!m) return fail(col, '颜色标记应为 [color=#rrggbb]');
      stack.push({ tag: 'color', col, style: { color: m[1] }, children: [] });
      return;
    }
    if (inner.startsWith('size')) {
      const m = /^size\s*=\s*(\d+)$/.exec(inner);
      if (!m) return fail(col, '字号标记应为 [size=百分比]，如 [size=120]');
      stack.push({ tag: 'size', col, style: { size: Number(m[1]) }, children: [] });
      return;
    }
    const styleTags: Record<string, SpanStyle> = {
      em: { em: true },
      b: { b: true },
      i: { i: true },
      shake: { shake: true },
    };
    if (inner in styleTags) {
      stack.push({ tag: inner, col, style: styleTags[inner], children: [] });
      return;
    }
    fail(col, `未知的行内标记 [${inner}]`);
  }

  while (i < src.length) {
    const c = src[i]!;
    if (c === '[') {
      if (src[i + 1] === '[') {
        top().children.push({ t: 'text', v: '[' });
        plain += '[';
        i += 2;
        continue;
      }
      const end = src.indexOf(']', i);
      if (end === -1) fail(i + 1, '行内标记缺少 "]"');
      handleTag(src.slice(i + 1, end), i + 1);
      i = end + 1;
      continue;
    }
    let j = src.indexOf('[', i);
    if (j === -1) j = src.length;
    const text = src.slice(i, j);
    if (text) {
      top().children.push({ t: 'text', v: text });
      plain += text;
    }
    i = j;
  }

  if (stack.length > 1) {
    const f = top();
    fail(f.col, `标记 [${f.tag}] 没有闭合`);
  }
  return { nodes: root.children, plain };
}

export { parseValue };
