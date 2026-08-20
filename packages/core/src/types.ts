/** 内核共享类型。全部可 JSON 序列化，零平台依赖。 */

// ---------- 表达式 ----------

export type Val = number | string | boolean;

export type Expr =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'bool'; v: boolean }
  | { t: 'var'; name: string }
  | { t: 'un'; op: '!' | '-'; a: Expr }
  | { t: 'bin'; op: string; a: Expr; b: Expr }
  | { t: 'call'; name: string; args: Expr[] };

// ---------- 文本（行内标记 AST） ----------

export interface SpanStyle {
  b?: boolean;
  i?: boolean;
  em?: boolean;
  color?: string;
  size?: number;
  shake?: boolean;
}

export type TextNode =
  | { t: 'text'; v: string }
  | { t: 'br' }
  | { t: 'pause'; ms: number }
  | { t: 'speed'; cps: number; children: TextNode[] }
  | { t: 'span'; style: SpanStyle; children: TextNode[] }
  | { t: 'ruby'; base: string; rt: string };

export interface DialogueLine {
  /** 角色 id；null = 旁白 */
  speaker: string | null;
  /** 显示名（编译期由角色表解析，as= 可覆盖） */
  displayName: string | null;
  voice?: string;
  segments: TextNode[];
  plainText: string;
}

export interface ChoiceOption {
  text: string;
  cond: Expr | null;
  once: boolean;
  target: string;
}

// ---------- 舞台与音频（声明式状态） ----------

export interface SpriteState {
  id: string;
  emotion: string;
  /** 0–100，舞台宽度百分比 */
  x: number;
}

export interface StageState {
  bg: string | null;
  sprites: Record<string, SpriteState>;
  weather: string | null;
  filter: string | null;
  fgs: string[];
  focus: string | null;
}

export interface AudioState {
  bgm: string | null;
  ambient: string | null;
  voiceSustain: boolean;
}

// ---------- 转场与表现事件 ----------

export interface TransitionSpec {
  type: 'cross' | 'fade' | 'slide' | 'blinds' | 'circle' | 'feather' | 'none';
  /** fade 的过渡色（black/white/#hex） */
  color?: string;
  /** slide 方向 */
  dir?: 'l' | 'r' | 'u' | 'd';
  ms: number;
}

export interface TransitionHints {
  bg?: TransitionSpec;
  spriteMs?: number;
  /** @weather density 参数（0–1） */
  weatherDensity?: number;
}

export type EngineEvent =
  | { t: 'stage'; hints: TransitionHints }
  | { t: 'bgm'; id: string | null; fadeMs: number; vol: number }
  | { t: 'ambient'; id: string | null }
  | { t: 'se'; id: string }
  | { t: 'title'; text: string }
  | { t: 'unlock'; kind: 'cg' | 'bgm' | 'scene'; id: string }
  | { t: 'shake'; power: number; ms: number }
  | { t: 'flash'; ms: number; color: string }
  | { t: 'read'; uid: string }
  | { t: 'warn'; message: string };
