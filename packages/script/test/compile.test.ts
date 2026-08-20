import { describe, expect, it } from 'vitest';
import { compileStory, toMs } from '../src/compile';

const CHARS = [
  { id: 'yui', name: '结衣', color: '#e58b9c' },
  { id: 'nao', name: '直', color: '#7aa2c4' },
];

function compile(text: string, entry?: string) {
  return compileStory({ files: [{ path: 't.yn', text }], characters: CHARS, entry });
}

describe('compileStory', () => {
  it('完整剧本：标签/对话/选择肢/分支/子程序编译通过且指令形态正确', () => {
    const r = compile(`
#start
@bg room fade=800
@bgm theme_main vol=0.8
yui「早上好[ruby:漢字;かんじ]」voice=yui_0101
@set affection = 1
@choice「怎么做？」
  「去」 -> go
  「留」 -> stay
@end
#go
@if affection >= 1
  yui「嗯！」
@else
  nao「哦？」
@end
@goto fin
#stay
nao「行吧。」
#fin
@call sub
@end_game
#sub
@return
`);
    const errs = r.issues.filter((i) => i.severity === 'error');
    expect(errs).toEqual([]);
    expect(r.bundle).not.toBeNull();
    const b = r.bundle!;
    expect(b.labels['start']).toBe(0);
    const ops = b.instructions.map((i) => i.op);
    expect(ops).toContain('dialogue');
    expect(ops).toContain('menu');
    expect(ops).toContain('jumpIf');
    expect(ops).toContain('call');
    expect(ops).toContain('end');
    // i18n 底稿
    expect(b.strings.length).toBeGreaterThanOrEqual(3);
    // scriptHash 稳定性
    const r2 = compile(r_bundleText);
    expect(r2.bundle!.scriptHash).toBe(b.scriptHash);
  });

  it('未注册角色 → 错误带行号', () => {
    const r = compile('#start\nmystery「谁」');
    const e = r.issues.find((i) => i.severity === 'error');
    expect(e?.message).toMatch(/未注册的角色 "mystery"/);
    expect(e?.line).toBe(2);
    expect(r.bundle).toBeNull();
  });

  it('跳转不存在的标签 → 错误', () => {
    const r = compile('#start\n@goto nowhere');
    expect(r.issues.some((i) => i.severity === 'error' && /nowhere/.test(i.message))).toBe(true);
  });

  it('未知命令与未知参数 → 错误', () => {
    const r1 = compile('#start\n@explode room');
    expect(r1.issues.some((i) => /未知命令 @explode/.test(i.message))).toBe(true);
    const r2 = compile('#start\n@bg room fade2=800');
    expect(r2.issues.some((i) => /没有参数 "fade2"/.test(i.message))).toBe(true);
    const r3 = compile('#start\n@bg room extra');
    expect(r3.issues.some((i) => /位置参数最多/.test(i.message))).toBe(true);
  });

  it('转场参数解析与时长单位', () => {
    expect(toMs('800')).toBe(800);
    expect(toMs('1.2s')).toBe(1200);
    expect(toMs('500ms')).toBe(500);
    expect(toMs('abc')).toBeNull();
    const r = compile('#start\n@bg room fade=black:1000');
    const cmd = r.bundle?.instructions.find((i) => i.op === 'cmd');
    expect(cmd).toMatchObject({ args: { asset: 'room', fade: { type: 'fade', color: 'black', ms: 1000 } } });
  });

  it('变量警告：读取未赋值变量 / 不可达标签', () => {
    const r = compile('#start\n@if ghost > 0\n  yui「嗯」\n@end\n@goto fin\n#dead\nyui「x」\n#fin\nyui「完」');
    expect(r.bundle).not.toBeNull();
    expect(r.issues.some((i) => i.severity === 'warning' && /ghost/.test(i.message))).toBe(true);
    expect(r.issues.some((i) => i.severity === 'warning' && /"dead"/.test(i.message))).toBe(true);
    // 顺序落入可达的标签不应误报（fin 被引用；前一条为 dialogue 的标签可落入）
    const r2 = compile('#start\n@call sub\n#after\nyui「落」\n@end_game\n#sub\n@return');
    expect(r2.issues.some((i) => i.severity === 'warning' && /"after"/.test(i.message))).toBe(false);
  });

  it('@rand / @set 表达式编译', () => {
    const r = compile('#start\n@rand dice = 1..6\n@set affection += 2\nyui「好」');
    const b = r.bundle!;
    expect(b.instructions[0]).toMatchObject({ op: 'rand', name: 'dice', min: 1, max: 6 });
    expect(b.instructions[1]).toMatchObject({ op: 'set', name: 'affection', kind: '+=' });
  });

  it('表达式语法错误 → 编译期错误（不到运行期）', () => {
    const r = compile('#start\n@if a >=\n  yui「x」\n@end');
    expect(r.issues.some((i) => i.severity === 'error' && /表达式错误/.test(i.message))).toBe(true);
  });
});

// 与第一个用例相同的剧本文本，用于验证 scriptHash 稳定性
const r_bundleText = `
#start
@bg room fade=800
@bgm theme_main vol=0.8
yui「早上好[ruby:漢字;かんじ]」voice=yui_0101
@set affection = 1
@choice「怎么做？」
  「去」 -> go
  「留」 -> stay
@end
#go
@if affection >= 1
  yui「嗯！」
@else
  nao「哦？」
@end
@goto fin
#stay
nao「行吧。」
#fin
@call sub
@end_game
#sub
@return
`;
