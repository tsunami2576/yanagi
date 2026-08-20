import { describe, expect, it } from 'vitest';
import { type Instruction } from '../src/instructions';
import { cloneState, initialState, migrateSave, validateResume, type GameState } from '../src/state';
import { ScriptVM } from '../src/vm';

function bundleWith(instructions: Instruction[], scriptHash = 'h1') {
  return {
    schema: 1,
    scriptHash,
    entry: 'start',
    labels: { start: 0, ch2: 2 },
    instructions,
    locs: instructions.map(() => ({ file: 't.yn', line: 1 })),
    strings: [],
  };
}

describe('状态与存档', () => {
  const ins: Instruction[] = [
    { op: 'set', name: 'a', kind: '=', value: { t: 'num', v: 1 } },
    { op: 'menu', uid: 'start#m1', options: [{ text: 'X', cond: null, once: false, target: 'ch2' }] },
    { op: 'dialogue', uid: 'ch2#1', line: { speaker: null, displayName: null, segments: [], plainText: 'hello' } },
  ];

  it('快照往返：克隆后与原状态等价推进', () => {
    const b = bundleWith(ins);
    const vm = new ScriptVM(b, initialState(b));
    vm.run(); // set
    vm.run(); // menu
    const snap = vm.snapshot();
    const clone = cloneState(snap);
    // 原路：选 0
    vm.chooseOption(0);
    const d1 = vm.run();
    // 克隆路：先 run() 重建菜单块（恢复会话的真实流程），再同样选择
    const vm2 = new ScriptVM(b, clone);
    const remenu = vm2.run();
    expect(remenu.kind).toBe('menu');
    vm2.chooseOption(0);
    const d2 = vm2.run();
    expect(d1).toEqual(d2);
    expect(vm2.state.label).toBe('ch2');
  });

  it('validateResume：scriptHash 一致 → ok', () => {
    const b = bundleWith(ins);
    const s = initialState(b);
    const r = validateResume(b, s);
    expect(r.status).toBe('ok');
  });

  it('validateResume：剧本变更 → 按 label 重定位到最近安全点', () => {
    const old = bundleWith(ins);
    const s = initialState(old);
    s.label = 'ch2';
    s.pc = 2;
    // 新版剧本：ch2 前多了一条指令
    const ins2: Instruction[] = [ins[0]!, ins[1]!, { op: 'set', name: 'b', kind: '=', value: { t: 'num', v: 2 } }, ins[2]!];
    const fresh = bundleWith(ins2, 'h2');
    const r = validateResume(fresh, s);
    expect(r.status).toBe('relocated');
    expect(s.pc).toBe(3); // 指向 dialogue
  });

  it('validateResume：label 丢失 → fail', () => {
    const old = bundleWith(ins);
    const s = initialState(old);
    s.label = 'gone';
    const fresh = { ...bundleWith(ins, 'h2'), labels: { start: 0 } };
    expect(validateResume(fresh, s).status).toBe('fail');
  });

  it('migrateSave：v1 放行 / 其他拒绝', () => {
    const b = bundleWith(ins);
    const s: GameState = initialState(b);
    const save = { version: 1 as const, game: 'demo', state: s, savedAt: 1, chapterTitle: '', lineSummary: '' };
    expect(migrateSave(save)).not.toBeNull();
    expect(migrateSave({ ...save, version: 2 as unknown as 1 })).toBeNull();
    expect(migrateSave('x')).toBeNull();
  });
});
