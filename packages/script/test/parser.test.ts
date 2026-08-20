import { describe, expect, it } from 'vitest';
import type { CompileIssue } from '../src/errors';
import { parseInline } from '../src/inline';
import { parseStory } from '../src/parser';

function issues(): { list: CompileIssue[]; sink: ReturnType<typeof sinks> } {
  return { list: [], sink: sinks() };
  function sinks() {
    const list: CompileIssue[] = [];
    return {
      error: (f: string, l: number, c: number, m: string) => list.push({ file: f, line: l, col: c, message: m, severity: 'error' }),
      warning: (f: string, l: number, c: number, m: string) => list.push({ file: f, line: l, col: c, message: m, severity: 'warning' }),
      list,
    };
  }
}

function parse(text: string) {
  const s = issues().sink;
  const nodes = parseStory([{ path: 't.yn', text }], s);
  return { nodes, errs: s.list };
}

describe('行内标记', () => {
  it('普通文本与转义', () => {
    expect(parseInline('hello').plain).toBe('hello');
    expect(parseInline('a[[b]').plain).toBe('a[b]');
    const joined = parseInline('a[[b]')
      .nodes.map((n) => (n.t === 'text' ? n.v : ''))
      .join('');
    expect(joined).toBe('a[b]');
  });

  it('ruby / 傍点 / 颜色 / 停顿 / 换行 / 变速', () => {
    const { nodes, plain } = parseInline('[ruby:漢字;かんじ]と[em]強調[/em][color=#ff6688]赤[/color]');
    expect(plain).toBe('漢字と強調赤');
    expect(nodes[0]).toMatchObject({ t: 'ruby', base: '漢字', rt: 'かんじ' });
    expect(nodes[2]).toMatchObject({ t: 'span', style: { em: true } });
    expect(nodes[3]).toMatchObject({ t: 'span', style: { color: '#ff6688' } });
    expect(parseInline('[pause=300]').nodes[0]).toMatchObject({ t: 'pause', ms: 300 });
    expect(parseInline('a[br]b').nodes).toContainEqual({ t: 'br' });
    const sp = parseInline('[speed=0]快[/speed]');
    expect(sp.nodes[0]).toMatchObject({ t: 'speed', cps: 0 });
  });

  it('嵌套与闭合校验', () => {
    expect(() => parseInline('[b]未闭合')).toThrow(/闭合/);
    expect(() => parseInline('[b]a[/i]')).toThrow(/不匹配/);
    expect(() => parseInline('[foo]x[/foo]')).toThrow(/未知/);
    expect(parseInline('[b]a[i]b[/i]c[/b]').plain).toBe('abc');
  });
});

describe('行级解析', () => {
  it('标签 / 对话（含尾参）/ 旁白 / 注释', () => {
    const { nodes, errs } = parse(`
; 注释
#start
yui「早上好。」voice=yui_0101
??「谁？」as=？？？
普通旁白一行
`);
    expect(errs).toEqual([]);
    expect(nodes.map((n) => n.k)).toEqual(['label', 'say', 'say', 'say']);
    const dlg = nodes[1] as Extract<(typeof nodes)[number], { k: 'say' }>;
    expect(dlg.speaker).toBe('yui');
    expect(dlg.voice).toBe('yui_0101');
    const asNode = nodes[2] as Extract<(typeof nodes)[number], { k: 'say' }>;
    expect(asNode.displayAs).toBe('？？？');
    const nar = nodes[3] as Extract<(typeof nodes)[number], { k: 'say' }>;
    expect(nar.speaker).toBeNull();
  });

  it('命令行参数（位置 + 命名 + 引号）', () => {
    const { nodes, errs } = parse('@bg room_day fade=800\n@title 第一章 · 夏\n@show yui smile left focus\n');
    expect(errs).toEqual([]);
    expect(nodes[0]).toMatchObject({ k: 'cmd', name: 'bg', args: { pos: ['room_day'], named: { fade: '800' } } });
    expect(nodes[1]).toMatchObject({ k: 'cmd', name: 'title', args: { text: '第一章 · 夏' } });
    expect(nodes[2]).toMatchObject({ k: 'cmd', name: 'show', args: { pos: ['yui', 'smile', 'left'], named: { focus: '' } } });
  });

  it('@if/@elif/@else/@end 块结构（缩进强制）', () => {
    const { nodes, errs } = parse(
      [
        '@if a >= 3',
        '  yui「太好了」',
        '@elif a == 2',
        '  yui「嗯」',
        '@else',
        '  yui「……」',
        '@end',
      ].join('\n'),
    );
    expect(errs).toEqual([]);
    expect(nodes).toHaveLength(1);
    const ifNode = nodes[0] as Extract<(typeof nodes)[number], { k: 'if' }>;
    expect(ifNode.branches.map((b) => b.cond)).toEqual(['a >= 3', 'a == 2', null]);
    expect(ifNode.branches[0]!.body).toHaveLength(1);
  });

  it('@choice 块与选项（->、if=、once）', () => {
    const { nodes, errs } = parse(
      [
        '@choice「怎么做？」',
        '  「去学校」 -> school',
        '  * 「再睡」 -> sleep',
        '  「隐藏项」 -> hid if=flag_x',
        '@end',
      ].join('\n'),
    );
    expect(errs).toEqual([]);
    const menu = nodes[0] as Extract<(typeof nodes)[number], { k: 'menu' }>;
    expect(menu.prompt).toBe('怎么做？');
    expect(menu.options).toHaveLength(3);
    expect(menu.options[1]!.once).toBe(true);
    expect(menu.options[2]!.cond).toBe('flag_x');
    expect(menu.options[0]!.target).toBe('school');
  });

  it('错误报告：缺失 @end / 错误缩进 / 未闭合引号', () => {
    const { errs } = parse('@if x\nyui「hi」\n');
    expect(errs.some((e) => /缺少 @end/.test(e.message))).toBe(true);
    const { errs: e2 } = parse('@if x\nyui「hi」\n@end\n');
    expect(e2.some((e) => /缩进/.test(e.message))).toBe(true);
    const { errs: e3 } = parse('yui「hi\n');
    expect(e3.some((e) => /闭合引号/.test(e.message))).toBe(true);
  });
});
