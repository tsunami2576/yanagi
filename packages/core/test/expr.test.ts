import { describe, expect, it } from 'vitest';
import { evalExpr, parseExpr } from '../src/expr';

describe('parseExpr + evalExpr', () => {
  const vars = { a: 3, b: 2, name: '柳', flag: true, s: '5' };

  it('四则运算与优先级', () => {
    expect(evalExpr(parseExpr('1+2*3'), { vars, rand: () => 0 })).toBe(7);
    expect(evalExpr(parseExpr('(1+2)*3'), { vars, rand: () => 0 })).toBe(9);
    expect(evalExpr(parseExpr('10 % 3'), { vars, rand: () => 0 })).toBe(1);
    expect(evalExpr(parseExpr('-a + 1'), { vars, rand: () => 0 })).toBe(-2);
  });

  it('比较与逻辑', () => {
    expect(evalExpr(parseExpr('a >= 3'), { vars, rand: () => 0 })).toBe(true);
    expect(evalExpr(parseExpr('a > b && flag'), { vars, rand: () => 0 })).toBe(true);
    expect(evalExpr(parseExpr('!flag || a == 4'), { vars, rand: () => 0 })).toBe(false);
    expect(evalExpr(parseExpr('a != 3'), { vars, rand: () => 0 })).toBe(false);
  });

  it('字符串拼接与比较', () => {
    expect(evalExpr(parseExpr('"yanagi" + 1'), { vars, rand: () => 0 })).toBe('yanagi1');
    expect(evalExpr(parseExpr('name + name'), { vars, rand: () => 0 })).toBe('柳柳');
    expect(evalExpr(parseExpr('"a" < "b"'), { vars, rand: () => 0 })).toBe(true);
  });

  it('函数', () => {
    expect(evalExpr(parseExpr('len(name)'), { vars, rand: () => 0 })).toBe(1);
    expect(evalExpr(parseExpr('int(3.9)'), { vars, rand: () => 0 })).toBe(3);
    expect(evalExpr(parseExpr('min(2, 5, 1)'), { vars, rand: () => 0 })).toBe(1);
    expect(evalExpr(parseExpr('rand(1, 6)'), { vars, rand: (a, b) => a + b })).toBe(7);
  });

  it('除零报错；未定义变量按假值语义（不崩溃）', () => {
    expect(() => evalExpr(parseExpr('1 / 0'), { vars, rand: () => 0 })).toThrow();
    // 跨分支读取未赋值变量是 VN 剧本正常写法：数值语境 0、逻辑语境假、字符串语境空
    expect(evalExpr(parseExpr('missing + 1'), { vars, rand: () => 0 })).toBe(1);
    expect(evalExpr(parseExpr('!missing'), { vars, rand: () => 0 })).toBe(true);
    expect(evalExpr(parseExpr('missing >= 1'), { vars, rand: () => 0 })).toBe(false);
    expect(evalExpr(parseExpr('missing && a'), { vars, rand: () => 0 })).toBe(false);
    expect(evalExpr(parseExpr('"x" + missing'), { vars, rand: () => 0 })).toBe('x');
    expect(evalExpr(parseExpr('missing == 0'), { vars, rand: () => 0 })).toBe(false);
  });

  it('语法错误', () => {
    expect(() => parseExpr('1 +')).toThrow();
    expect(() => parseExpr('(1 + 2')).toThrow();
    expect(() => parseExpr('a & b')).toThrow();
    expect(() => parseExpr('1 2')).toThrow();
  });
});
