/** 剧本虚拟机：解释指令束直到阻塞点；维护可序列化状态。 */
import { evalExpr, truthy } from './expr';
import type { Bundle, Instruction } from './instructions';
import { cloneState, type GameState } from './state';
import type { EngineEvent, TransitionSpec, Val } from './types';

export interface MenuOptionView {
  index: number;
  text: string;
  target: string;
  disabled: boolean;
}

export type Block =
  | { kind: 'dialogue'; line: import('./types').DialogueLine; uid: string }
  | { kind: 'menu'; options: MenuOptionView[]; uid: string; prompt?: string }
  | { kind: 'wait'; ms: number }
  | { kind: 'end' }
  | { kind: 'ended' };

const HISTORY_MAX = 200;

export class ScriptVM {
  private readonly events: EngineEvent[] = [];
  private readonly labelStarts: Set<number>;
  private lastMenu: MenuOptionView[] | null = null;
  private currentMenuUid = '';

  constructor(
    private readonly bundle: Bundle,
    public state: GameState,
  ) {
    this.labelStarts = new Set(Object.values(bundle.labels));
  }

  drainEvents(): EngineEvent[] {
    const out = this.events.slice();
    this.events.length = 0;
    return out;
  }

  /** 确定性随机（mulberry32），种子状态在 GameState 内随存档保存。 */
  private nextRand(): number {
    this.state.rngState = (this.state.rngState + 0x6d2b79f5) | 0;
    let t = this.state.rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  private rand(min: number, max: number): number {
    const span = Math.max(1, max - min + 1);
    return min + Math.floor(this.nextRand() * span);
  }

  private eval(e: import('./types').Expr): Val | undefined {
    return evalExpr(e, { vars: this.state.vars, rand: (a, b) => this.rand(a, b) });
  }

  /** 执行到下一个阻塞点。fast=true 时压缩 wait（Skip 模式用）。 */
  run(fast = false): Block {
    const ins = this.bundle.instructions;
    for (;;) {
      if (this.state.pc < 0 || this.state.pc >= ins.length) {
        this.state.pc = ins.length;
        return { kind: 'ended' };
      }
      if (this.labelStarts.has(this.state.pc)) {
        for (const [name, idx] of Object.entries(this.bundle.labels)) {
          if (idx === this.state.pc && !name.startsWith('$')) {
            this.state.label = name;
            break;
          }
        }
      }
      const cur = ins[this.state.pc]!;
      switch (cur.op) {
        case 'jump':
          this.jump(cur.label);
          continue;
        case 'jumpIf':
          if (truthy(this.eval(cur.cond))) this.jump(cur.label);
          else this.state.pc++;
          continue;
        case 'call':
          this.state.callStack.push(this.state.pc + 1);
          if (this.state.callStack.length > 32) throw new Error('子程序嵌套超过 32 层（缺少 @return？）');
          this.jump(cur.label);
          continue;
        case 'return': {
          const back = this.state.callStack.pop();
          if (back === undefined) throw new Error('@return 出现在没有 @call 的位置');
          this.state.pc = back;
          continue;
        }
        case 'set':
          this.applySet(cur);
          this.state.pc++;
          continue;
        case 'rand':
          this.state.vars[cur.name] = this.rand(cur.min, cur.max);
          this.state.pc++;
          continue;
        case 'cmd':
          this.applyCmd(cur);
          this.state.pc++;
          continue;
        case 'wait': {
          const ms = fast ? Math.min(50, cur.ms) : cur.ms;
          return { kind: 'wait', ms };
        }
        case 'dialogue': {
          const last = this.state.history[this.state.history.length - 1];
          if (!last || last.uid !== cur.uid) {
            this.state.history.push({
              uid: cur.uid,
              speaker: cur.line.speaker,
              name: cur.line.displayName,
              text: cur.line.plainText,
              voice: cur.line.voice,
            });
            if (this.state.history.length > HISTORY_MAX) this.state.history.shift();
            this.events.push({ t: 'read', uid: cur.uid });
          }
          return { kind: 'dialogue', line: cur.line, uid: cur.uid };
        }
        case 'menu': {
          const options: MenuOptionView[] = cur.options.map((o, i) => {
            let visible = true;
            if (o.cond) {
              try {
                visible = truthy(this.eval(o.cond));
              } catch {
                visible = false;
              }
            }
            return {
              index: i,
              text: o.text,
              target: o.target,
              disabled: !visible || this.state.usedOnce.includes(`${cur.uid}:${i}`),
            };
          });
          this.lastMenu = options;
          this.currentMenuUid = cur.uid;
          return { kind: 'menu', options, uid: cur.uid, prompt: cur.prompt };
        }
        case 'end':
          return { kind: 'end' };
      }
    }
  }

  /** 对话完成（玩家确认前进）。 */
  finishDialogue(): void {
    this.state.pc++;
    this.state.updatedAt = Date.now();
  }

  /** wait 完成。 */
  finishWait(): void {
    this.state.pc++;
  }

  /** 玩家做出选择。 */
  chooseOption(i: number): void {
    if (!this.lastMenu) throw new Error('当前没有待回答的选择肢');
    const opt = this.lastMenu[i]!;
    if (!opt || opt.disabled) return;
    const uid = this.currentMenuUid;
    this.state.usedOnce.push(`${uid}:${i}`);
    this.state.choices.push({
      at: uid,
      picked: opt.text,
      all: this.lastMenu.filter((o) => !o.disabled).map((o) => o.text),
    });
    this.lastMenu = null;
    this.jump(opt.target);
    this.state.updatedAt = Date.now();
  }

  /** 状态快照（存档）。 */
  snapshot(): GameState {
    return cloneState(this.state);
  }

  private jump(label: string): void {
    const idx = this.bundle.labels[label];
    if (idx === undefined) throw new Error(`跳转到不存在的标签 "${label}"（编译器漏洞：应在编译期拦截）`);
    this.state.pc = idx;
    if (!label.startsWith('$')) this.state.label = label;
  }

  private applySet(cur: Extract<Instruction, { op: 'set' }>): void {
    const raw = this.eval(cur.value);
    // 未定义变量参与 @set 时落为 false（Val 不含 undefined，保证可序列化）
    const v: Val = raw === undefined ? false : raw;
    const box = this.state.vars;
    switch (cur.kind) {
      case '=':
        box[cur.name] = v;
        break;
      case '+=':
        box[cur.name] = (typeof box[cur.name] === 'string' || typeof v === 'string'
          ? String(box[cur.name] ?? '') + String(v)
          : Number(box[cur.name] ?? 0) + Number(v)) as Val;
        break;
      case '-=':
        box[cur.name] = Number(box[cur.name] ?? 0) - Number(v);
        break;
      case '*=':
        box[cur.name] = Number(box[cur.name] ?? 0) * Number(v);
        break;
      case '/=': {
        const d = Number(v);
        if (d === 0) throw new Error(`@set ${cur.name} /= 0：除以零`);
        box[cur.name] = Number(box[cur.name] ?? 0) / d;
        break;
      }
    }
  }

  private applyCmd(cur: Extract<Instruction, { op: 'cmd' }>): void {
    const a = cur.args;
    const st = this.state.stage;
    const au = this.state.audio;
    switch (cur.name) {
      case 'bg': {
        const asset = a.asset as string;
        st.bg = asset === 'none' ? null : asset;
        this.events.push({ t: 'stage', hints: { bg: (a.fade as TransitionSpec | undefined) ?? { type: 'cross', ms: 300 } } });
        break;
      }
      case 'show': {
        const id = a.id as string;
        st.sprites[id] = { id, emotion: (a.emotion as string) ?? 'normal', x: (a.x as number) ?? 50 };
        if (a.focus) st.focus = id;
        this.events.push({ t: 'stage', hints: {} });
        break;
      }
      case 'hide': {
        delete st.sprites[a.id as string];
        if (st.focus === a.id) st.focus = null;
        this.events.push({ t: 'stage', hints: { spriteMs: (a.ms as number) ?? 300 } });
        break;
      }
      case 'emotion': {
        const sp = st.sprites[a.id as string];
        if (sp) sp.emotion = (a.emotion as string) ?? 'normal';
        this.events.push({ t: 'stage', hints: { spriteMs: 150 } });
        break;
      }
      case 'clear_sprites':
        st.sprites = {};
        st.focus = null;
        this.events.push({ t: 'stage', hints: {} });
        break;
      case 'weather':
        st.weather = a.preset === 'off' ? null : (a.preset as string);
        this.events.push({ t: 'stage', hints: {} });
        break;
      case 'filter':
        st.filter = a.name === 'off' ? null : (a.name as string);
        this.events.push({ t: 'stage', hints: {} });
        break;
      case 'fg': {
        const asset = a.asset as string;
        st.fgs = asset === 'off' ? [] : [asset];
        this.events.push({ t: 'stage', hints: {} });
        break;
      }
      case 'bgm': {
        const asset = a.asset as string;
        const stop = asset === 'stop';
        au.bgm = stop ? null : asset;
        this.events.push({
          t: 'bgm',
          id: stop ? null : asset,
          fadeMs: (a.fade as number) ?? 1000,
          vol: (a.vol as number) ?? 1,
        });
        break;
      }
      case 'ambient': {
        const asset = a.asset as string;
        au.ambient = asset === 'off' ? null : asset;
        this.events.push({ t: 'ambient', id: au.ambient });
        break;
      }
      case 'se':
        this.events.push({ t: 'se', id: a.asset as string });
        break;
      case 'voice_sustain':
        au.voiceSustain = (a.value as string) === 'on';
        break;
      case 'title':
        this.state.chapter = a.text as string;
        this.events.push({ t: 'title', text: a.text as string });
        break;
      case 'unlock':
        this.events.push({ t: 'unlock', kind: a.kind as 'cg' | 'bgm' | 'scene', id: a.id as string });
        break;
      case 'shake':
        this.events.push({ t: 'shake', power: (a.power as number) ?? 6, ms: (a.ms as number) ?? 500 });
        break;
      case 'flash':
        this.events.push({ t: 'flash', ms: (a.ms as number) ?? 200, color: (a.color as string) ?? 'white' });
        break;
      default:
        this.events.push({ t: 'warn', message: `命令 @${cur.name} 尚未实现运行期行为（M1 落地）` });
    }
  }
}
