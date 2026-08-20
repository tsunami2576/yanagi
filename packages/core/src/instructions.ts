/** 指令集与剧本束（编译产物）。 */
import type { ChoiceOption, DialogueLine } from './types';

export type Instruction =
  | { op: 'dialogue'; line: DialogueLine; uid: string }
  | { op: 'menu'; options: ChoiceOption[]; uid: string; prompt?: string }
  | { op: 'jump'; label: string }
  | { op: 'jumpIf'; cond: import('./types').Expr; label: string }
  | { op: 'call'; label: string }
  | { op: 'return' }
  | { op: 'set'; name: string; kind: '=' | '+=' | '-=' | '*=' | '/='; value: import('./types').Expr }
  | { op: 'rand'; name: string; min: number; max: number }
  | { op: 'cmd'; name: string; args: Record<string, unknown> }
  | { op: 'wait'; ms: number }
  | { op: 'end' };

export interface SourceLoc {
  file: string;
  line: number;
}

export interface Bundle {
  /** 存档结构版本 */
  schema: number;
  /** 指令束内容哈希（存档兼容判定） */
  scriptHash: string;
  /** 入口 label */
  entry: string;
  /** label → 指令索引（含 $ 开头的编译器内部标签） */
  labels: Record<string, number>;
  instructions: Instruction[];
  /** 与 instructions 等长，源码定位 */
  locs: SourceLoc[];
  /** i18n 字符串底稿 */
  strings: { uid: string; speaker: string | null; text: string }[];
}

/** FNV-1a 32 位哈希（scriptHash 用，无需加密强度）。 */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
