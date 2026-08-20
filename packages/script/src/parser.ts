/** 行级解析：.yn 文本 → 程序节点树（AST）。块结构（@if/@choice）要求严格缩进。 */
import type { TextNode } from '@yanagi/core';
import type { CompileIssue, IssueSink } from './errors';
import { InlineError, parseInline } from './inline';

export interface SourceFile {
  path: string;
  text: string;
}

export interface RawArgs {
  /** 位置参数（已去引号） */
  pos: string[];
  /** 命名参数 key=value（已去引号） */
  named: Record<string, string>;
  /** 整行余文（@title/@set/@rand/@goto 等整行语义命令） */
  text?: string;
}

export interface MenuOptionNode {
  text: string;
  segments: TextNode[];
  target: string;
  cond: string | null;
  once: boolean;
  file: string;
  line: number;
}

export interface IfBranch {
  /** null = @else 分支 */
  cond: string | null;
  body: ProgNode[];
  file: string;
  line: number;
}

export type ProgNode =
  | { k: 'label'; name: string; file: string; line: number }
  | {
      k: 'say';
      speaker: string | null;
      /** as= 覆盖的显示名（未覆盖为 null，由编译期角色表解析） */
      displayAs: string | null;
      voice?: string;
      segments: TextNode[];
      plain: string;
      file: string;
      line: number;
    }
  | { k: 'cmd'; name: string; args: RawArgs; file: string; line: number }
  | { k: 'if'; branches: IfBranch[]; file: string; line: number }
  | { k: 'menu'; prompt: string | null; options: MenuOptionNode[]; file: string; line: number };

export function parseStory(files: SourceFile[], issues: IssueSink): ProgNode[] {
  const root: ProgNode[] = [];

  interface Frame {
    kind: 'if' | 'menu';
    indent: number;
    file: string;
    line: number;
    cur: ProgNode[];
    branches?: IfBranch[];
    options?: MenuOptionNode[];
    prompt?: string | null;
  }
  const stack: Frame[] = [];
  const target = (): ProgNode[] => (stack.length ? stack[stack.length - 1]!.cur : root);

  for (const file of files) {
    const lines = file.text.split(/\r?\n/);
    for (let ln = 1; ln <= lines.length; ln++) {
      const raw = lines[ln - 1]!;
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith(';')) continue;
      const indent = countIndent(raw);
      const top = stack[stack.length - 1];

      // ---- 标签 ----
      if (trimmed.startsWith('#')) {
        if (top) {
          issues.error(file.path, ln, 1, `标签定义不能位于 @${top.kind} 块内`);
          continue;
        }
        const m = /^#([a-z0-9_]+)$/.exec(trimmed);
        if (!m) {
          issues.error(file.path, ln, 1, '标签格式应为 #小写字母_数字_下划线，如 #ch1_start');
          continue;
        }
        root.push({ k: 'label', name: m[1]!, file: file.path, line: ln });
        continue;
      }

      // ---- 命令与块结构 ----
      if (trimmed.startsWith('@')) {
        const m = /^@([a-z_]+)\s*(.*)$/.exec(trimmed);
        if (!m) {
          issues.error(file.path, ln, 1, `无法解析的命令："${trimmed}"`);
          continue;
        }
        const name = m[1]!;
        const rest = m[2] ?? '';

        if (name === 'end') {
          if (!top) {
            issues.error(file.path, ln, 1, '@end 没有对应的 @if/@choice');
            continue;
          }
          if (indent !== top.indent) {
            issues.error(
              file.path,
              ln,
              1,
              `@end 的缩进应与 @${top.kind}（${top.file}:${top.line}）对齐`,
            );
          }
          const parentTarget = stack.length >= 2 ? stack[stack.length - 2]!.cur : root;
          if (top.kind === 'if') {
            parentTarget.push({ k: 'if', branches: top.branches!, file: top.file, line: top.line });
          } else {
            if (!top.options || top.options.length === 0) {
              issues.error(file.path, ln, 1, '@choice 块内没有任何选项');
            }
            parentTarget.push({
              k: 'menu',
              prompt: top.prompt ?? null,
              options: top.options ?? [],
              file: top.file,
              line: top.line,
            });
          }
          stack.pop();
          continue;
        }
        if (name === 'elif' || name === 'else') {
          if (!top || top.kind !== 'if' || !top.branches) {
            issues.error(file.path, ln, 1, `@${name} 只能出现在 @if 块内`);
            continue;
          }
          if (indent !== top.indent) {
            issues.error(file.path, ln, 1, `@${name} 的缩进应与 @if（${top.file}:${top.line}）对齐`);
            continue;
          }
          if (name === 'else') {
            if (top.branches.some((b) => b.cond === null)) {
              issues.error(file.path, ln, 1, '@if 块内出现多个 @else');
              continue;
            }
            top.branches.push({ cond: null, body: [], file: file.path, line: ln });
          } else {
            const cond = rest.trim();
            if (!cond) {
              issues.error(file.path, ln, 1, '@elif 缺少条件表达式');
              continue;
            }
            top.branches.push({ cond, body: [], file: file.path, line: ln });
          }
          top.cur = top.branches[top.branches.length - 1]!.body;
          continue;
        }
        if (name === 'if' || name === 'choice') {
          if (top && indent <= top.indent) {
            issues.error(
              file.path,
              ln,
              1,
              `嵌套块应比外层 @${top.kind}（${top.file}:${top.line}）缩进更深`,
            );
            continue;
          }
          if (name === 'if') {
            const cond = rest.trim();
            if (!cond) {
              issues.error(file.path, ln, 1, '@if 缺少条件表达式');
              continue;
            }
            const first: IfBranch = { cond, body: [], file: file.path, line: ln };
            stack.push({ kind: 'if', indent, file: file.path, line: ln, cur: first.body, branches: [first] });
          } else {
            const prompt = parsePrompt(rest, file.path, ln, issues);
            stack.push({ kind: 'menu', indent, file: file.path, line: ln, cur: [], options: [], prompt });
          }
          continue;
        }

        // 普通命令：块内必须缩进
        if (top) {
          if (indent <= top.indent) {
            issues.error(
              file.path,
              ln,
              1,
              `块内语句需要比 @${top.kind}（${top.file}:${top.line}）更深的缩进，或用 @end 闭合`,
            );
            continue;
          }
          if (top.kind === 'menu') {
            issues.error(file.path, ln, 1, '@choice 块内只能出现选项行（「文本」 -> 标签）');
            continue;
          }
        }
        const cmd = parseCommand(name, rest, file.path, ln, issues);
        if (cmd) target().push(cmd);
        continue;
      }

      // ---- 选择肢选项行 ----
      if (top?.kind === 'menu') {
        if (indent <= top.indent) {
          issues.error(
            file.path,
            ln,
            1,
            `选项行需要比 @choice（${top.file}:${top.line}）更深的缩进；结束选项用 @end`,
          );
          continue;
        }
        const opt = parseOption(trimmed, file.path, ln, issues);
        if (opt) top.options!.push(opt);
        continue;
      }

      // ---- 对话 / 旁白（块内需缩进） ----
      if (top && indent <= top.indent) {
        issues.error(
          file.path,
          ln,
          1,
          `块内语句需要比 @${top.kind}（${top.file}:${top.line}）更深的缩进，或用 @end 闭合`,
        );
        continue;
      }

      const dlg = splitDialogue(trimmed);
      if (dlg === 'unclosed') {
        issues.error(file.path, ln, 1, '对话缺少闭合引号（「…」需成对出现）');
        continue;
      }
      if (dlg) {
        const inline = tryInline(dlg.text, file.path, ln, issues);
        const trailers = parseTrailers(dlg.trailer, { voice: 'value', as: 'value' }, file.path, ln, issues);
        target().push({
          k: 'say',
          speaker: dlg.speaker,
          displayAs: trailers['as'] ?? null,
          voice: trailers['voice'],
          segments: inline.nodes,
          plain: inline.plain,
          file: file.path,
          line: ln,
        });
      } else {
        const src = trimmed.startsWith('「') && trimmed.endsWith('」') ? trimmed.slice(1, -1) : trimmed;
        const inline = tryInline(src, file.path, ln, issues);
        target().push({
          k: 'say',
          speaker: null,
          displayAs: null,
          segments: inline.nodes,
          plain: inline.plain,
          file: file.path,
          line: ln,
        });
      }
    }
  }

  if (stack.length) {
    const f = stack[stack.length - 1]!;
    issues.error(f.file, f.line, 1, `@${f.kind} 块缺少 @end 闭合`);
  }
  return root;
}

// ---------- 辅助 ----------

function countIndent(raw: string): number {
  let n = 0;
  for (const c of raw) {
    if (c === ' ') n += 1;
    else if (c === '\t') n += 4;
    else break;
  }
  return n;
}

const OPEN_CLOSE: Record<string, string> = {
  '「': '」',
  '『': '』',
  '"': '"',
  '“': '”',
};

interface DialogueParts {
  speaker: string | null;
  text: string;
  trailer: string;
}

/** 识别「名前「文本」尾参」；'unclosed' = 有引号但未闭合；null = 旁白。 */
function splitDialogue(line: string): DialogueParts | 'unclosed' | null {
  let best = -1;
  let bestQuote = '';
  for (const q of Object.keys(OPEN_CLOSE)) {
    const idx = line.indexOf(q);
    if (idx > 0 && (best === -1 || idx < best)) {
      best = idx;
      bestQuote = q;
    }
  }
  if (best === -1) return null;
  const speaker = line.slice(0, best);
  if (/\s/.test(speaker)) return null; // 引号前含空白 → 旁白
  const close = OPEN_CLOSE[bestQuote]!;
  const closeIdx = line.indexOf(close, best + 1);
  if (closeIdx === -1) return 'unclosed';
  return {
    speaker,
    text: line.slice(best + 1, closeIdx),
    trailer: line.slice(closeIdx + 1).trim(),
  };
}

function parsePrompt(rest: string, file: string, line: number, issues: IssueSink): string | null {
  const s = rest.trim();
  if (!s) return null;
  const q = s[0]!;
  const close = OPEN_CLOSE[q];
  if (!close) {
    issues.error(file, line, 1, '@choice 的提示文字应使用引号，如 @choice「接下来怎么做？」');
    return null;
  }
  const end = s.indexOf(close, 1);
  if (end === -1) {
    issues.error(file, line, 1, '@choice 提示文字的引号未闭合');
    return null;
  }
  const leftover = s.slice(end + 1).trim();
  if (leftover) {
    issues.error(file, line, 1, `@choice 行末有无法解析的内容 "${leftover}"`);
  }
  return s.slice(1, end);
}

function parseOption(
  trimmed: string,
  file: string,
  line: number,
  issues: IssueSink,
): MenuOptionNode | null {
  let s = trimmed;
  let once = false;
  if (s.startsWith('*')) {
    once = true;
    s = s.slice(1).trim();
  }
  const q = s[0]!;
  const close = OPEN_CLOSE[q];
  if (!close) {
    issues.error(file, line, 1, '选项文本应以引号开始，如 「一起去学校」 -> school');
    return null;
  }
  const end = s.indexOf(close, 1);
  if (end === -1) {
    issues.error(file, line, 1, '选项文本的引号未闭合');
    return null;
  }
  const text = s.slice(1, end);
  const rest = s.slice(end + 1).trim();
  const arrow = rest.indexOf('->');
  if (arrow === -1) {
    issues.error(file, line, 1, `选项 "${text}" 缺少 "-> 目标标签"`);
    return null;
  }
  const before = rest.slice(0, arrow).trim();
  if (before) {
    issues.error(file, line, 1, `选项的 "->" 之前不应有内容 "${before}"（格式：「文本」 -> 标签）`);
    return null;
  }
  const after = rest.slice(arrow + 2).trim();
  const space = after.indexOf(' ');
  const target = space === -1 ? after : after.slice(0, space);
  const trailerRaw = space === -1 ? '' : after.slice(space + 1).trim();
  if (!/^[a-z0-9_]+$/.test(target)) {
    issues.error(file, line, 1, `选项目标 "${target}" 不是合法标签名（小写字母/数字/下划线）`);
    return null;
  }
  const trailers = parseTrailers(trailerRaw, { if: 'value', once: 'flag' }, file, line, issues);
  const inline = tryInline(text, file, line, issues);
  return {
    text: inline.plain,
    segments: inline.nodes,
    target,
    cond: trailers['if'] ?? null,
    once: once || trailers['once'] === 'true',
    file,
    line,
  };
}

function parseCommand(
  name: string,
  rest: string,
  file: string,
  line: number,
  issues: IssueSink,
): ProgNode | null {
  // 整行语义命令：保留原始余文
  if (name === 'set' || name === 'rand' || name === 'title' || name === 'goto' || name === 'call') {
    if (name !== 'title' && !rest.trim()) {
      issues.error(file, line, 1, `@${name} 缺少参数`);
      return null;
    }
    return { k: 'cmd', name, args: { pos: [], named: {}, text: rest }, file, line };
  }
  const { pos, named } = tokenizeArgs(rest, file, line, issues);
  return { k: 'cmd', name, args: { pos, named }, file, line };
}

/** 无值的 flag 型参数（写在命令行末尾的裸词）。 */
const BARE_FLAGS = new Set(['focus']);

function tokenizeArgs(
  rest: string,
  file: string,
  line: number,
  issues: IssueSink,
): { pos: string[]; named: Record<string, string> } {
  const pos: string[] = [];
  const named: Record<string, string> = {};
  let i = 0;
  const s = rest;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (i >= s.length) break;
    const c = s[i]!;
    let token: string;
    if (c === '"' || c === '「' || c === '『' || c === '“') {
      const close = OPEN_CLOSE[c]!;
      const end = s.indexOf(close, i + 1);
      if (end === -1) {
        issues.error(file, line, i + 1, `参数引号未闭合`);
        return { pos, named };
      }
      token = s.slice(i + 1, end);
      i = end + 1;
      const gap = s.slice(i).search(/\s/);
      if (gap !== -1 && gap > 0) {
        issues.error(file, line, i + 1, '引号参数后有多余字符');
      }
    } else {
      let j = i;
      while (j < s.length && !/\s/.test(s[j]!)) j++;
      token = s.slice(i, j);
      i = j;
    }
    const eq = token.indexOf('=');
    if (eq > 0) {
      const key = token.slice(0, eq);
      const val = token.slice(eq + 1);
      if (!/^[a-z_][a-z0-9_]*$/.test(key)) {
        issues.error(file, line, 1, `参数名 "${key}" 不合法`);
      } else {
        named[key] = val;
      }
    } else if (BARE_FLAGS.has(token)) {
      named[token] = '';
    } else {
      pos.push(token);
    }
  }
  return { pos, named };
}

function parseTrailers(
  raw: string,
  allowed: Record<string, 'value' | 'flag'>,
  file: string,
  line: number,
  issues: IssueSink,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const token of raw.split(/\s+/).filter(Boolean)) {
    if (allowed[token] === 'flag') {
      out[token] = 'true';
      continue;
    }
    const m = /^([a-z]+)=(.*)$/.exec(token);
    const key = m?.[1];
    if (m && key !== undefined && allowed[key] === 'value') {
      const val = m[2] ?? '';
      out[key] = OPEN_CLOSE[val[0] ?? ''] ? val.slice(1, -1) : val;
    } else {
      issues.error(
        file,
        line,
        1,
        `无法解析的尾部参数 "${token}"（此处允许：${Object.keys(allowed).join(' / ')}）`,
      );
    }
  }
  return out;
}

function tryInline(text: string, file: string, line: number, issues: IssueSink): { nodes: TextNode[]; plain: string } {
  try {
    return parseInline(text);
  } catch (e) {
    if (e instanceof InlineError) {
      issues.error(file, line, e.col, e.message);
      return { nodes: [{ t: 'text', v: text.replace(/\[[^\]]*\]/g, '') }], plain: text };
    }
    throw e;
  }
}
