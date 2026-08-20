/** 游戏工程元数据类型（script 编译产出、runtime 消费）。 */

export interface CharDef {
  id: string;
  name: string;
  color?: string;
  voicePrefix?: string;
}

export interface BgmTrack {
  url: string;
  /** 循环点（秒） */
  loopStart?: number;
  loopEnd?: number;
}

export interface Manifest {
  /** 背景：逻辑名 → 资源 URL */
  bg: Record<string, string>;
  /** 立绘：id → 差分表情 → 资源 URL */
  sprites: Record<string, Record<string, string>>;
  bgm: Record<string, BgmTrack>;
  se: Record<string, string>;
  voice: Record<string, string>;
}

export interface GameDef {
  id: string;
  title: string;
  entry: string;
  characters: CharDef[];
  bundle: import('./instructions').Bundle;
  manifest: Manifest;
}
