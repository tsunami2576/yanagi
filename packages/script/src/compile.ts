/** 编译器：AST → 指令束（含跳转校验、角色解析、参数校验、scriptHash、i18n 底稿）。 */
// 注意：此文件会被 Vite 的 config loader 连同 vite-plugin 一起打包，
// 裸导入 @yanagi/core 会被外部化导致 Node 原生 ESM 加载失败，故用相对导入。
// M3 引擎包产出 dist 构建后恢复为包名导入（决策 D-006）。
import {
  SAVE_SCHEMA,
  type Bundle,
  type ChoiceOption,
  type Expr,
  type Instruction,
  type SourceLoc,
  type TransitionSpec,
  collectVarReads,
  fnv1a,
  parseExpr,
} from '../../core/src/index';
import type { CompileIssue, IssueSink } from './errors';
import type { ProgNode, SourceFile } from './parser';
import { parseStory } from './parser';

export interface CharDefInput {
  id: string;
  name: string;
  color?: string;
  voicePrefix?: string;
}

export interface CompileInput {
  files: SourceFile[];
  characters: CharDefInput[];
  entry?: string;
}

export interface CompileResult {
  bundle: Bundle | null;
  issues: CompileIssue[];
}

interface CmdSpec {
  pos?: string[];
  named?: string[];
}

/** v0.1 命令集（参数校验表）。 */
export const CMDS: Record<string, CmdSpec> = {
  bg: { pos: ['asset'], named: ['fade'] },
  show: { pos: ['id', 'emotion', 'slot'], named: ['focus', 'anim'] },
  hide: { pos: ['id'], named: ['slide', 'ms'] },
  emotion: { pos: ['id', 'emotion'] },
  clear_sprites: {},
  weather: { pos: ['preset'], named: ['density'] },
  filter: { pos: ['name'], named: ['strength'] },
  fg: { pos: ['asset'] },
  bgm: { pos: ['asset'], named: ['fade', 'vol'] },
  ambient: { pos: ['asset'] },
  se: { pos: ['asset'] },
  voice_sustain: { pos: ['value'] },
  title: {},
  unlock: { pos: ['kind', 'id'] },
  shake: { named: ['power', 'ms'] },
  flash: { named: ['ms', 'color'] },
};

const SLOT_X: Record<string, number> = { left: 25, center: 50, right: 75 };

export function compileStory(input: CompileInput): CompileResult {
  const issues: CompileIssue[] = [];
  const sink: IssueSink = {
    error: (f, l, c, m) => issues.push({ file: f, line: l, col: c, message: m, severity: 'error' }),
    warning: (f, l, c, m) => issues.push({ file: f, line: l, col: c, message: m, severity: 'warning' }),
  };

  const chars = new Map<string, CharDefInput>();
  for (const c of input.characters) {
    chars.set(c.id, c);
    chars.set(c.name, c);
  }

  const nodes = parseStory(input.files, sink);

  const instructions: Instruction[] = [];
  const locs: SourceLoc[] = [];
  const labels: Record<string, number> = {};
  const labelDefLoc = new Map<string, SourceLoc>();
  const referenced = new Map<string, SourceLoc>();
  const strings: Bundle['strings'] = [];
  const assignedVars = new Set<string>();
  const readVars = new Map<string, SourceLoc>();
  let ifCounter = 0;
  let menuCounter = 0;
  let currentLabel = '';
  const dialogueCounters = new Map<string, number>();
  let firstLabel: string | null = null;

  const emit = (ins: Instruction, loc: SourceLoc): void => {
    instructions.push(ins);
    locs.push(loc);
  };

  const registerLabel = (name: string, loc: SourceLoc): void => {
    if (name in labels) {
      const prev = labelDefLoc.get(name)!;
      sink.error(loc.file, loc.line, 1, `标签 "${name}" 重复定义（首次定义于 ${prev.file}:${prev.line}）`);
      return;
    }
    labels[name] = instructions.length;
    labelDefLoc.set(name, loc);
  };

  const tryExpr = (src: string, loc: SourceLoc): Expr | null => {
    try {
      return parseExpr(src);
    } catch (e) {
      sink.error(loc.file, loc.line, 1, `表达式错误：${(e as Error).message}（表达式："${src}"）`);
      return null;
    }
  };

  const noteReads = (e: Expr, loc: SourceLoc): void => {
    for (const name of collectVarReads(e)) {
      if (!readVars.has(name)) readVars.set(name, loc);
    }
  };

  const nextUid = (prefix: string): string => {
    const key = currentLabel || '_pre';
    const n = (dialogueCounters.get(key) ?? 0) + 1;
    dialogueCounters.set(key, n);
    return `${key}#${prefix}${n}`;
  };

  const walk = (list: ProgNode[]): void => {
    for (const node of list) {
      const loc: SourceLoc = { file: node.file, line: node.line };
      switch (node.k) {
        case 'label':
          registerLabel(node.name, loc);
          currentLabel = node.name;
          if (firstLabel === null) firstLabel = node.name;
          break;
        case 'say': {
          let displayName: string | null = node.displayAs;
          if (node.speaker !== null) {
            const def = chars.get(node.speaker);
            if (!def) {
              sink.error(
                node.file,
                node.line,
                1,
                `未注册的角色 "${node.speaker}"（请在 game.json 的 characters 中登记；显示名可用 as= 覆盖）`,
              );
            } else if (displayName === null) {
              displayName = def.name;
            }
          }
          const uid = nextUid('');
          strings.push({ uid, speaker: node.speaker, text: node.plain });
          emit(
            {
              op: 'dialogue',
              line: {
                speaker: node.speaker,
                displayName,
                voice: node.voice,
                segments: node.segments,
                plainText: node.plain,
              },
              uid,
            },
            loc,
          );
          break;
        }
        case 'if': {
          ifCounter += 1;
          const endLbl = `$if${ifCounter}end`;
          const hasElse = node.branches.some((b) => b.cond === null);
          const elseLbl = hasElse ? `$if${ifCounter}else` : null;
          const branchLbl = (i: number): string => `$if${ifCounter}b${i}`;
          node.branches.forEach((b, i) => {
            if (b.cond === null) return;
            const e = tryExpr(b.cond, { file: b.file, line: b.line });
            if (!e) return;
            noteReads(e, { file: b.file, line: b.line });
            emit({ op: 'jumpIf', cond: e, label: branchLbl(i) }, { file: b.file, line: b.line });
          });
          emit({ op: 'jump', label: elseLbl ?? endLbl }, loc);
          node.branches.forEach((b, i) => {
            if (b.cond !== null) registerLabel(branchLbl(i), { file: b.file, line: b.line });
            walk(b.body);
            emit({ op: 'jump', label: endLbl }, { file: b.file, line: b.line });
          });
          if (elseLbl) {
            const elseBranch = node.branches.find((b) => b.cond === null)!;
            registerLabel(elseLbl, { file: elseBranch.file, line: elseBranch.line });
            walk(elseBranch.body);
          }
          registerLabel(endLbl, loc);
          break;
        }
        case 'menu': {
          const uid = nextUid('m');
          const options: ChoiceOption[] = node.options.map((o) => {
            let cond: Expr | null = null;
            if (o.cond !== null) {
              cond = tryExpr(o.cond, { file: o.file, line: o.line });
              if (cond) noteReads(cond, { file: o.file, line: o.line });
            }
            referenced.set(o.target, { file: o.file, line: o.line });
            return { text: o.text, cond, once: o.once, target: o.target };
          });
          emit({ op: 'menu', options, uid, prompt: node.prompt ?? undefined }, loc);
          break;
        }
        case 'cmd': {
          emitCmd(node, loc);
          break;
        }
      }
    }
  };

  const emitCmd = (node: Extract<ProgNode, { k: 'cmd' }>, loc: SourceLoc): void => {
    const { pos, named, text } = node.args;
    switch (node.name) {
      case 'goto':
      case 'call': {
        const label = (text ?? '').trim();
        if (!/^[a-z0-9_]+$/.test(label)) {
          sink.error(node.file, node.line, 1, `@${node.name} 的目标 "${label}" 不是合法标签名`);
          return;
        }
        referenced.set(label, loc);
        emit({ op: node.name === 'goto' ? 'jump' : 'call', label }, loc);
        return;
      }
      case 'return':
        emit({ op: 'return' }, loc);
        return;
      case 'end_game':
        emit({ op: 'end' }, loc);
        return;
      case 'wait': {
        const raw = (pos[0] ?? named['ms'] ?? '').trim();
        const ms = toMs(raw);
        if (ms === null) {
          sink.error(node.file, node.line, 1, `@wait 参数应为毫秒或秒（如 500 / 1.2s），得到 "${raw}"`);
          return;
        }
        emit({ op: 'wait', ms }, loc);
        return;
      }
      case 'set': {
        const m = /^([A-Za-z_]\w*)\s*(\+=|-=|\*=|\/=|=)\s*(.+)$/.exec((text ?? '').trim());
        if (!m) {
          sink.error(node.file, node.line, 1, '@set 格式应为 @set 变量 = 表达式 或 @set 变量 += 表达式');
          return;
        }
        const value = tryExpr(m[3]!, loc);
        if (!value) return;
        assignedVars.add(m[1]!);
        noteReads(value, loc);
        emit({ op: 'set', name: m[1]!, kind: m[2] as '=' | '+=' | '-=' | '*=' | '/=', value }, loc);
        return;
      }
      case 'rand': {
        const m = /^([A-Za-z_]\w*)\s*=\s*(-?\d+)\s*\.\.\s*(-?\d+)$/.exec((text ?? '').trim());
        if (!m) {
          sink.error(node.file, node.line, 1, '@rand 格式应为 @rand 变量 = 最小值..最大值（闭区间整数）');
          return;
        }
        assignedVars.add(m[1]!);
        emit({ op: 'rand', name: m[1]!, min: Number(m[2]), max: Number(m[3]) }, loc);
        return;
      }
    }

    // 通用命令：先做参数表校验
    const spec = CMDS[node.name];
    if (!spec) {
      const known = [...Object.keys(CMDS), 'goto', 'call', 'return', 'wait', 'set', 'rand', 'if', 'choice', 'end', 'end_game'].join('、');
      sink.error(node.file, node.line, 1, `未知命令 @${node.name}（可用命令：${known}）`);
      return;
    }
    const maxPos = spec.pos?.length ?? 0;
    if (pos.length > maxPos) {
      sink.error(
        node.file,
        node.line,
        1,
        `@${node.name} 位置参数最多 ${maxPos} 个（${(spec.pos ?? []).join(' ')}），多余的 "${pos[maxPos]}"`,
      );
      return;
    }
    for (const key of Object.keys(named)) {
      if (!(spec.named ?? []).includes(key)) {
        sink.error(
          node.file,
          node.line,
          1,
          `@${node.name} 没有参数 "${key}"（支持：${(spec.named ?? []).join(' / ') || '无'}）`,
        );
        return;
      }
    }

    const needPos = (i: number, what: string): string | null => {
      const v = pos[i];
      if (v === undefined) {
        sink.error(node.file, node.line, 1, `@${node.name} 缺少参数：${what}`);
        return null;
      }
      return v;
    };
    const num = (raw: string | undefined, what: string): number | null => {
      if (raw === undefined) return null;
      const v = Number(raw);
      if (Number.isNaN(v)) {
        sink.error(node.file, node.line, 1, `@${node.name} 的 ${what} 应为数字，得到 "${raw}"`);
        return null;
      }
      return v;
    };

    let args: Record<string, unknown> | null = null;
    switch (node.name) {
      case 'bg': {
        const asset = needPos(0, '背景资源名（或 none）');
        if (asset === null) return;
        args = { asset, fade: parseTransition(named['fade'], node, sink) };
        break;
      }
      case 'show': {
        const id = needPos(0, '立绘 id');
        if (id === null) return;
        const emotion = pos[1];
        const slot = pos[2];
        let x = 50;
        if (slot !== undefined) {
          if (slot in SLOT_X) x = SLOT_X[slot]!;
          else if (/^\d+%$/.test(slot)) x = Number(slot.slice(0, -1));
          else {
            sink.error(node.file, node.line, 1, `@show 位置参数应为 left/center/right 或百分比，得到 "${slot}"`);
            return;
          }
        }
        args = { id, emotion, x, focus: 'focus' in named };
        break;
      }
      case 'hide': {
        const id = needPos(0, '立绘 id');
        if (id === null) return;
        const ms = named['ms'] !== undefined ? toMs(named['ms']) : 300;
        if (ms === null) {
          sink.error(node.file, node.line, 1, `@hide 的 ms 参数应为时长，得到 "${named['ms']}"`);
          return;
        }
        args = { id, ms };
        break;
      }
      case 'emotion': {
        const id = needPos(0, '立绘 id');
        const emotion = needPos(1, '差分表情名');
        if (id === null || emotion === null) return;
        args = { id, emotion };
        break;
      }
      case 'weather': {
        const preset = needPos(0, '粒子预设（sakura/snow/rain/fireflies/dust/off）');
        if (preset === null) return;
        const density = named['density'] !== undefined ? num(named['density'], 'density（0–1）') : undefined;
        if (density !== null) args = { preset, density: density ?? undefined };
        break;
      }
      case 'filter': {
        const name = needPos(0, '滤镜名（mono/sepia/blur/vignette/off）');
        if (name === null) return;
        args = { name };
        break;
      }
      case 'fg':
      case 'ambient':
      case 'se': {
        const asset = needPos(0, '资源名');
        if (asset === null) return;
        args = { asset };
        break;
      }
      case 'bgm': {
        const asset = needPos(0, 'BGM 资源名（或 stop）');
        if (asset === null) return;
        const fade = named['fade'] !== undefined ? num(named['fade'], 'fade（毫秒）') : 1000;
        const vol = named['vol'] !== undefined ? num(named['vol'], 'vol（0–1）') : 1;
        if (fade === null || vol === null) return;
        args = { asset, fade, vol };
        break;
      }
      case 'voice_sustain': {
        const value = needPos(0, 'on / off');
        if (value === null) return;
        if (value !== 'on' && value !== 'off') {
          sink.error(node.file, node.line, 1, `@voice_sustain 参数应为 on/off，得到 "${value}"`);
          return;
        }
        args = { value };
        break;
      }
      case 'title': {
        const t = (text ?? '').trim();
        if (!t) {
          sink.error(node.file, node.line, 1, '@title 缺少标题文字');
          return;
        }
        args = { text: t };
        break;
      }
      case 'unlock': {
        const kind = needPos(0, '解锁类型（cg/bgm/scene）');
        const id = needPos(1, '解锁条目 id');
        if (kind === null || id === null) return;
        if (!['cg', 'bgm', 'scene'].includes(kind)) {
          sink.error(node.file, node.line, 1, `@unlock 类型应为 cg/bgm/scene，得到 "${kind}"`);
          return;
        }
        args = { kind, id };
        break;
      }
      case 'shake': {
        const power = named['power'] !== undefined ? num(named['power'], 'power') : 6;
        const ms = named['ms'] !== undefined ? toMs(named['ms']) : 500;
        if (power === null || ms === null) {
          if (ms === null) sink.error(node.file, node.line, 1, '@shake 的 ms 应为时长');
          return;
        }
        args = { power, ms };
        break;
      }
      case 'flash': {
        const ms = named['ms'] !== undefined ? toMs(named['ms']) : 200;
        const color = named['color'] ?? 'white';
        if (ms === null) {
          sink.error(node.file, node.line, 1, '@flash 的 ms 应为时长');
          return;
        }
        args = { ms, color };
        break;
      }
      default:
        args = {};
    }
    if (args) emit({ op: 'cmd', name: node.name, args }, loc);
  };

  function parseTransition(raw: string | undefined, node: Extract<ProgNode, { k: 'cmd' }>, sink: IssueSink): TransitionSpec | undefined {
    if (raw === undefined) return undefined;
    const s = raw.trim();
    if (s === 'none') return { type: 'none', ms: 0 };
    const num = toMs(s);
    if (num !== null) return { type: 'cross', ms: num };
    const m = /^([a-z]+):(\d+(?:\.\d+)?)(ms|s)?$/.exec(s);
    if (m) {
      const ms = toMs(`${m[2]}${m[3] ?? ''}`);
      if (ms !== null) return { type: 'fade', color: m[1]!, ms };
    }
    sink.error(node.file, node.line, 1, `转场参数应为 时长（800 / 1.2s）或 颜色:时长（black:1000），得到 "${raw}"`);
    return undefined;
  }

  walk(nodes);

  // ---- 校验：跳转目标存在 ----
  for (const [label, loc] of referenced) {
    if (!(label in labels)) {
      sink.error(loc.file, loc.line, 1, `跳转到不存在的标签 "${label}"`);
    }
  }

  // ---- 入口 ----
  const entry = input.entry ?? firstLabel ?? '';
  if (!entry) {
    sink.error('(story)', 0, 1, '剧本中没有任何标签（#label），无法确定入口');
  } else if (!(entry in labels)) {
    sink.error('(game.json)', 0, 1, `入口标签 "${entry}" 在剧本中不存在`);
  }

  // ---- 警告：未赋值读取 / 未使用标签 ----
  for (const [name, loc] of readVars) {
    if (!assignedVars.has(name)) {
      sink.warning(loc.file, loc.line, 1, `变量 "${name}" 被读取但从未赋值（@set/@rand）；运行期按未定义处理（逻辑假/数值 0）`);
    }
  }
  // 这些指令之后控制流不会顺延到下一条 → 其后的标签若无人跳转则真不可达
  const NO_FALLTHROUGH = new Set(['jump', 'return', 'end', 'menu']);
  for (const name of Object.keys(labels)) {
    if (name.startsWith('$') || name === entry || referenced.has(name)) continue;
    const idx = labels[name]!;
    const prev = idx > 0 ? instructions[idx - 1] : undefined;
    if (prev && NO_FALLTHROUGH.has(prev.op)) {
      const loc = labelDefLoc.get(name)!;
      sink.warning(loc.file, loc.line, 1, `标签 "${name}" 从未被跳转引用，且其上方是 @${prev.op === 'jump' ? 'goto/@end_game/选择肢跳转' : prev.op === 'menu' ? 'choice' : prev.op === 'return' ? 'return' : 'end_game'}，不可达`);
    }
  }

  if (issues.some((i) => i.severity === 'error')) {
    return { bundle: null, issues };
  }

  const scriptHash = fnv1a(entry + '\u0000' + JSON.stringify(instructions));
  return {
    bundle: { schema: SAVE_SCHEMA, scriptHash, entry, labels, instructions, locs, strings },
    issues,
  };
}

/** "500" / "1.2s" / "500ms" → 毫秒；非法返回 null。 */
export function toMs(raw: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(ms|s)?$/.exec(raw.trim());
  if (!m) return null;
  const v = Number(m[1]);
  return m[2] === 's' ? Math.round(v * 1000) : Math.round(v);
}

// ---------- 资源引用收集（Vite 插件做存在性校验用） ----------

export interface AssetRef {
  kind: 'bg' | 'sprite' | 'bgm' | 'se' | 'voice';
  key: string;
  emotion?: string;
  file: string;
  line: number;
}

export function collectAssetRefs(bundle: Bundle): AssetRef[] {
  const refs: AssetRef[] = [];
  bundle.instructions.forEach((ins, i) => {
    const loc = bundle.locs[i] ?? { file: '?', line: 0 };
    if (ins.op === 'cmd') {
      const a = ins.args as Record<string, unknown>;
      switch (ins.name) {
        case 'bg':
          if (a.asset !== 'none' && typeof a.asset === 'string') refs.push({ kind: 'bg', key: a.asset, ...loc });
          break;
        case 'show':
          refs.push({ kind: 'sprite', key: String(a.id), emotion: (a.emotion as string) ?? 'normal', ...loc });
          break;
        case 'emotion':
          refs.push({ kind: 'sprite', key: String(a.id), emotion: (a.emotion as string) ?? 'normal', ...loc });
          break;
        case 'bgm':
          if (a.asset !== 'stop') refs.push({ kind: 'bgm', key: String(a.asset), ...loc });
          break;
        case 'ambient':
        case 'se':
          refs.push({ kind: 'se', key: String(a.asset), ...loc });
          break;
      }
    } else if (ins.op === 'dialogue' && ins.line.voice) {
      refs.push({ kind: 'voice', key: ins.line.voice, ...loc });
    }
  });
  return refs;
}
