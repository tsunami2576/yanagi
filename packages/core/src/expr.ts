/** 表达式：手写词法 + 优先级 climbing 解析 + 求值。 */
import type { Expr, Val } from './types';

export class ExprError extends Error {}

interface Tok {
  k: 'num' | 'str' | 'ident' | 'op';
  v: string;
  pos: number;
}

const TWO_CHAR_OPS = ['==', '!=', '>=', '<=', '&&', '||'];

const IDENT_START = /[A-Za-z_]/;
const IDENT_CHAR = /[A-Za-z0-9_]/;

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ') {
      i++;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j]!)) j++;
      toks.push({ k: 'num', v: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== c) {
        s += src[j];
        j++;
      }
      if (j >= src.length) throw new ExprError(`字符串未闭合（第 ${i} 个字符起）`);
      toks.push({ k: 'str', v: s, pos: i });
      i = j + 1;
      continue;
    }
    if (IDENT_START.test(c)) {
      let j = i;
      while (j < src.length && IDENT_CHAR.test(src[j]!)) j++;
      toks.push({ k: 'ident', v: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (TWO_CHAR_OPS.includes(two)) {
      toks.push({ k: 'op', v: two, pos: i });
      i += 2;
      continue;
    }
    if ('+-*/%()<>=!,'.includes(c)) {
      toks.push({ k: 'op', v: c, pos: i });
      i++;
      continue;
    }
    throw new ExprError(`无法识别的字符 "${c}"（第 ${i} 个字符）`);
  }
  return toks;
}

const BIN_PREC: Record<string, number> = {
  '||': 1,
  '&&': 2,
  '==': 3,
  '!=': 3,
  '>=': 3,
  '<=': 3,
  '>': 3,
  '<': 3,
  '+': 4,
  '-': 4,
  '*': 5,
  '/': 5,
  '%': 5,
};

export function parseExpr(src: string): Expr {
  const toks = tokenize(src);
  let p = 0;
  const peek = (): Tok | undefined => toks[p];
  const eat = (): Tok | undefined => toks[p++];

  function parse(minPrec: number): Expr {
    let left = parseUnary();
    for (;;) {
      const t = peek();
      if (!t || t.k !== 'op' || !(t.v in BIN_PREC)) break;
      const prec = BIN_PREC[t.v]!;
      if (prec < minPrec) break;
      eat();
      const right = parse(prec + 1);
      left = { t: 'bin', op: t.v, a: left, b: right };
    }
    return left;
  }

  function parseUnary(): Expr {
    const t = peek();
    if (t && t.k === 'op' && (t.v === '!' || t.v === '-')) {
      eat();
      return { t: 'un', op: t.v, a: parseUnary() };
    }
    return parsePrimary();
  }

  function parsePrimary(): Expr {
    const t = eat();
    if (!t) throw new ExprError('表达式意外结束');
    if (t.k === 'num') {
      const v = Number(t.v);
      if (Number.isNaN(v)) throw new ExprError(`无效数字 "${t.v}"`);
      return { t: 'num', v };
    }
    if (t.k === 'str') return { t: 'str', v: t.v };
    if (t.k === 'ident') {
      if (t.v === 'true') return { t: 'bool', v: true };
      if (t.v === 'false') return { t: 'bool', v: false };
      const n = peek();
      if (n && n.k === 'op' && n.v === '(') {
        eat();
        const args: Expr[] = [];
        const closed = peek();
        if (!(closed && closed.k === 'op' && closed.v === ')')) {
          for (;;) {
            args.push(parse(0));
            const nx = eat();
            if (!nx) throw new ExprError('括号未闭合');
            if (nx.k === 'op' && nx.v === ')') break;
            if (!(nx.k === 'op' && nx.v === ',')) throw new ExprError(`期待 "," 或 ")"，得到 "${nx.v}"`);
          }
        } else {
          eat();
        }
        return { t: 'call', name: t.v, args };
      }
      return { t: 'var', name: t.v };
    }
    if (t.k === 'op' && t.v === '(') {
      const e = parse(0);
      const close = eat();
      if (!close || close.k !== 'op' || close.v !== ')') throw new ExprError('括号未闭合');
      return e;
    }
    throw new ExprError(`期待值、变量或 "("，得到 "${t.v}"`);
  }

  const e = parse(0);
  if (p < toks.length) throw new ExprError(`表达式末尾有多余内容 "${toks[p]!.v}"`);
  return e;
}

// ---------- 求值 ----------

export interface EvalEnv {
  vars: Readonly<Record<string, Val>>;
  /** 闭区间整数随机（确定性，由 VM 提供并推进种子） */
  rand: (min: number, max: number) => number;
}

export function truthy(v: Val): boolean {
  return Boolean(v);
}

function num(v: Val): number {
  if (typeof v === 'number') return v;
  throw new ExprError(`期待数字，得到 ${typeof v === 'string' ? `"${v}"` : String(v)}`);
}

function str(v: Val): string {
  return typeof v === 'string' ? v : String(v);
}

function cmp(a: Val, b: Val): number {
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  return num(a) - num(b);
}

export function evalExpr(e: Expr, env: EvalEnv): Val {
  switch (e.t) {
    case 'num':
      return e.v;
    case 'str':
      return e.v;
    case 'bool':
      return e.v;
    case 'var': {
      const v = env.vars[e.name];
      if (v === undefined) throw new ExprError(`变量 "${e.name}" 未定义`);
      return v;
    }
    case 'un':
      if (e.op === '!') return !truthy(evalExpr(e.a, env));
      return -num(evalExpr(e.a, env));
    case 'bin': {
      if (e.op === '&&') return truthy(evalExpr(e.a, env)) ? evalExpr(e.b, env) : false;
      if (e.op === '||') {
        if (truthy(evalExpr(e.a, env))) return true;
        return evalExpr(e.b, env);
      }
      const a = evalExpr(e.a, env);
      const b = evalExpr(e.b, env);
      switch (e.op) {
        case '+':
          return typeof a === 'string' || typeof b === 'string' ? str(a) + str(b) : num(a) + num(b);
        case '-':
          return num(a) - num(b);
        case '*':
          return num(a) * num(b);
        case '/': {
          const d = num(b);
          if (d === 0) throw new ExprError('除以零');
          return num(a) / d;
        }
        case '%': {
          const d = num(b);
          if (d === 0) throw new ExprError('对零取模');
          return num(a) % d;
        }
        case '==':
          return a === b;
        case '!=':
          return a !== b;
        case '>=':
          return cmp(a, b) >= 0;
        case '<=':
          return cmp(a, b) <= 0;
        case '>':
          return cmp(a, b) > 0;
        case '<':
          return cmp(a, b) < 0;
        default:
          throw new ExprError(`未知运算符 "${e.op}"`);
      }
    }
    case 'call': {
      const args = e.args.map((a) => evalExpr(a, env));
      switch (e.name) {
        case 'rand': {
          if (args.length !== 2) throw new ExprError('rand(最小值, 最大值) 需要两个参数');
          return env.rand(Math.trunc(num(args[0]!)), Math.trunc(num(args[1]!)));
        }
        case 'len':
          return str(args[0] ?? '').length;
        case 'int':
          return Math.trunc(num(args[0] ?? 0));
        case 'str':
          return str(args[0] ?? '');
        case 'num':
          return num(args[0] ?? 0);
        case 'abs':
          return Math.abs(num(args[0] ?? 0));
        case 'floor':
          return Math.floor(num(args[0] ?? 0));
        case 'min':
          return Math.min(...args.map(num));
        case 'max':
          return Math.max(...args.map(num));
        default:
          throw new ExprError(`未知函数 "${e.name}"`);
      }
    }
  }
}

/** 收集表达式中读取的变量名（编译期"未赋值读取"警告用）。 */
export function collectVarReads(e: Expr, out: Set<string> = new Set()): Set<string> {
  switch (e.t) {
    case 'var':
      out.add(e.name);
      break;
    case 'un':
      collectVarReads(e.a, out);
      break;
    case 'bin':
      collectVarReads(e.a, out);
      collectVarReads(e.b, out);
      break;
    case 'call':
      for (const a of e.args) collectVarReads(a, out);
      break;
  }
  return out;
}
