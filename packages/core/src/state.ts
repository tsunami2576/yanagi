/** 游戏状态、存档数据与恢复校验。 */
import type { Bundle } from './instructions';
import type { AudioState, StageState, Val } from './types';

export const SAVE_SCHEMA = 1;

export interface BacklogEntry {
  /** 'say' = 对话/旁白（缺省），'choice' = 玩家选择 */
  kind?: 'say' | 'choice';
  uid: string;
  speaker: string | null;
  name: string | null;
  text: string;
  voice?: string;
}

export interface ChoiceRecord {
  at: string;
  picked: string;
  all: string[];
}

export interface GameState {
  schema: number;
  scriptHash: string;
  /** 下一条待执行指令（安全点：指向 dialogue/menu/wait/end） */
  pc: number;
  /** 当前所在 label（展示与重定位用） */
  label: string;
  vars: Record<string, Val>;
  rngState: number;
  stage: StageState;
  audio: AudioState;
  /** call 返回地址栈（指令索引） */
  callStack: number[];
  history: BacklogEntry[];
  choices: ChoiceRecord[];
  /** 本局已使用的 once 选项（键 `${menuUid}:${index}`） */
  usedOnce: string[];
  chapter: string;
  playMs: number;
  updatedAt: number;
}

export function initialState(bundle: Bundle): GameState {
  const entryPc = bundle.labels[bundle.entry] ?? 0;
  return {
    schema: SAVE_SCHEMA,
    scriptHash: bundle.scriptHash,
    pc: entryPc,
    label: bundle.entry,
    vars: {},
    rngState: (Date.now() | 0) || 1,
    stage: { bg: null, sprites: {}, weather: null, filter: null, fgs: [], focus: null },
    audio: { bgm: null, ambient: null, voiceSustain: false },
    callStack: [],
    history: [],
    choices: [],
    usedOnce: [],
    chapter: '',
    playMs: 0,
    updatedAt: Date.now(),
  };
}

export function cloneState(s: GameState): GameState {
  return structuredClone(s);
}

export interface SaveData {
  version: 1;
  game: string;
  state: GameState;
  savedAt: number;
  chapterTitle: string;
  lineSummary: string;
  thumbnail?: Blob;
}

export type ResumeCheck =
  | { status: 'ok' }
  | { status: 'relocated'; to: number }
  | { status: 'fail'; reason: string };

/**
 * 恢复校验：scriptHash 一致直接放行；否则按 label 重定位到该 label 内
 * 最近的安全点（dialogue/menu）；label 丢失则拒绝。
 * 重定位时会就地修改 state.pc。
 */
export function validateResume(bundle: Bundle, state: GameState): ResumeCheck {
  const n = bundle.instructions.length;
  if (state.scriptHash === bundle.scriptHash && state.pc >= 0 && state.pc < n) {
    return { status: 'ok' };
  }
  const li = bundle.labels[state.label];
  if (li === undefined) {
    return { status: 'fail', reason: `存档位置 "${state.label}" 在当前剧本中不存在` };
  }
  for (let i = li; i < n; i++) {
    const ins = bundle.instructions[i]!;
    if (ins.op === 'dialogue' || ins.op === 'menu') {
      state.pc = i;
      return { status: 'relocated', to: i };
    }
  }
  return { status: 'fail', reason: '该章节内找不到可恢复的安全点' };
}

/** 存档迁移链入口（当前只有 v1）。返回 null 表示无法迁移。 */
export function migrateSave(raw: unknown): SaveData | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const s = raw as Partial<SaveData> & { version?: number };
  if (s.version === 1 && s.state && typeof s.state === 'object') return s as SaveData;
  return null;
}
