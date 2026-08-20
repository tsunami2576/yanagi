import { describe, expect, it } from 'vitest';
import { type Bundle, type Instruction } from '../src/instructions';
import { initialState } from '../src/state';
import { ScriptVM, type Block } from '../src/vm';

function mkBundle(instructions: Instruction[], labels: Record<string, number>, entry = 'start'): Bundle {
  return {
    schema: 1,
    scriptHash: 'test',
    entry,
    labels,
    instructions,
    locs: instructions.map(() => ({ file: 't.yn', line: 1 })),
    strings: [],
  };
}

function runToEnd(vm: ScriptVM, action: (b: Block, vm: ScriptVM) => boolean): Block[] {
  const blocks: Block[] = [];
  for (;;) {
    const b = vm.run();
    blocks.push(b);
    if (b.kind === 'ended' || b.kind === 'end') break;
    if (!action(b, vm)) break;
  }
  return blocks;
}

describe('ScriptVM', () => {
  it('线性对话 + 状态推进', () => {
    const ins: Instruction[] = [
      { op: 'dialogue', uid: 'start#1', line: { speaker: null, displayName: null, segments: [{ t: 'text', v: 'a' }], plainText: 'a' } },
      { op: 'dialogue', uid: 'start#2', line: { speaker: 'yui', displayName: '结衣', segments: [{ t: 'text', v: 'b' }], plainText: 'b' } },
    ];
    const vm = new ScriptVM(mkBundle(ins, { start: 0 }), initialState(mkBundle(ins, { start: 0 })));
    const blocks = runToEnd(vm, (b, v) => {
      if (b.kind === 'dialogue') {
        v.finishDialogue();
        return true;
      }
      return false;
    });
    expect(blocks.map((b) => b.kind)).toEqual(['dialogue', 'dialogue', 'ended']);
    expect(vm.state.history).toHaveLength(2);
    expect(vm.state.history[1]!.name).toBe('结衣');
  });

  it('选择肢跳转与 once 禁用', () => {
    const ins: Instruction[] = [
      {
        op: 'menu',
        uid: 'start#m1',
        options: [
          { text: 'A', cond: null, once: true, target: 'a' },
          { text: 'B', cond: null, once: false, target: 'b' },
        ],
      },
      { op: 'dialogue', uid: 'a#1', line: { speaker: null, displayName: null, segments: [], plainText: 'A' } },
      { op: 'jump', label: 'fin' },
      { op: 'dialogue', uid: 'b#1', line: { speaker: null, displayName: null, segments: [], plainText: 'B' } },
    ];
    const labels = { start: 0, a: 1, b: 3, fin: 4 };
    const bundle = mkBundle(ins, labels);
    const vm = new ScriptVM(bundle, initialState(bundle));
    const menu = vm.run();
    expect(menu.kind).toBe('menu');
    if (menu.kind === 'menu') {
      expect(menu.options).toHaveLength(2);
      expect(menu.options[0]!.disabled).toBe(false);
    }
    vm.chooseOption(0);
    expect(vm.state.label).toBe('a');
    const d = vm.run();
    expect(d.kind).toBe('dialogue');
    vm.finishDialogue();
    const jump = vm.run(); // jump → fin → ended
    expect(jump.kind).toBe('ended');

    // 重放同一存档点：once 选项应禁用
    const vm2 = new ScriptVM(bundle, { ...initialState(bundle), usedOnce: ['start#m1:0'] });
    const menu2 = vm2.run();
    if (menu2.kind === 'menu') {
      expect(menu2.options[0]!.disabled).toBe(true);
      expect(menu2.options[1]!.disabled).toBe(false);
    }
  });

  it('条件分支 jumpIf / if-else 语义', () => {
    const ins: Instruction[] = [
      { op: 'set', name: 'x', kind: '=', value: { t: 'num', v: 2 } },
      { op: 'jumpIf', cond: { t: 'bin', op: '>=', a: { t: 'var', name: 'x' }, b: { t: 'num', v: 3 } }, label: 'big' },
      { op: 'dialogue', uid: 'start#1', line: { speaker: null, displayName: null, segments: [], plainText: 'small' } },
      { op: 'jump', label: 'fin' },
      { op: 'dialogue', uid: 'big#1', line: { speaker: null, displayName: null, segments: [], plainText: 'big' } },
    ];
    const bundle = mkBundle(ins, { start: 0, big: 4, fin: 5 });
    const vm = new ScriptVM(bundle, initialState(bundle));
    vm.run(); // set
    const b = vm.run(); // jumpIf 为假 → 落到对话
    expect(b.kind).toBe('dialogue');
    expect(vm.state.vars['x']).toBe(2);
  });

  it('call/return 子程序栈', () => {
    const ins: Instruction[] = [
      { op: 'call', label: 'sub' },
      { op: 'dialogue', uid: 'start#1', line: { speaker: null, displayName: null, segments: [], plainText: 'after' } },
      { op: 'end' },
      { op: 'dialogue', uid: 'sub#1', line: { speaker: null, displayName: null, segments: [], plainText: 'sub' } },
      { op: 'return' },
    ];
    const bundle = mkBundle(ins, { start: 0, sub: 3 });
    const vm = new ScriptVM(bundle, initialState(bundle));
    const texts: string[] = [];
    for (;;) {
      const b = vm.run();
      if (b.kind === 'ended' || b.kind === 'end') break;
      if (b.kind === 'dialogue') {
        texts.push(b.line.plainText);
        vm.finishDialogue();
      }
    }
    expect(texts).toEqual(['sub', 'after']);
  });

  it('@rand 确定性：同种子同结果', () => {
    const ins: Instruction[] = [
      { op: 'rand', name: 'dice', min: 1, max: 6 },
      { op: 'rand', name: 'dice2', min: 1, max: 6 },
    ];
    const bundle = mkBundle(ins, { start: 0 });
    const s1 = initialState(bundle);
    const s2 = { ...initialState(bundle), rngState: 42 };
    const s3 = { ...initialState(bundle), rngState: 42 };
    const vm1 = new ScriptVM(bundle, { ...s1, rngState: 42 });
    vm1.run();
    const vm2 = new ScriptVM(bundle, s2);
    vm2.run();
    const vm3 = new ScriptVM(bundle, s3);
    vm3.run();
    expect(vm1.state.vars['dice']).toBe(vm2.state.vars['dice']);
    expect(vm2.state.vars['dice2']).toBe(vm3.state.vars['dice2']);
  });

  it('cmd 指令更新舞台与音频状态并产生事件', () => {
    const ins: Instruction[] = [
      { op: 'cmd', name: 'bg', args: { asset: 'room', fade: { type: 'cross', ms: 800 } } },
      { op: 'cmd', name: 'show', args: { id: 'yui', emotion: 'smile', x: 25, focus: true } },
      { op: 'cmd', name: 'bgm', args: { asset: 'theme', fade: 1000, vol: 0.8 } },
      { op: 'cmd', name: 'emotion', args: { id: 'yui', emotion: 'shy' } },
    ];
    const bundle = mkBundle(ins, { start: 0 });
    const vm = new ScriptVM(bundle, initialState(bundle));
    vm.run();
    expect(vm.state.stage.bg).toBe('room');
    expect(vm.state.stage.sprites['yui']!).toMatchObject({ emotion: 'shy', x: 25 });
    expect(vm.state.stage.focus).toBe('yui');
    expect(vm.state.audio.bgm).toBe('theme');
    const events = vm.drainEvents();
    expect(events.filter((e) => e.t === 'stage')).toHaveLength(3);
    expect(events).toContainEqual({ t: 'bgm', id: 'theme', fadeMs: 1000, vol: 0.8 });
  });

  it('wait 在 fast 模式下压缩', () => {
    const bundle = mkBundle([{ op: 'wait', ms: 2000 }], { start: 0 });
    const vm = new ScriptVM(bundle, initialState(bundle));
    expect(vm.run(true)).toMatchObject({ kind: 'wait', ms: 50 });
    expect(vm.run(false)).toMatchObject({ kind: 'wait', ms: 2000 });
  });
});
