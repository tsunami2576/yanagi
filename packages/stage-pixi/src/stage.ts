/**
 * PixiJS v8 舞台：背景/立绘/转场/聚焦压暗/震屏/闪光。
 * 声明式状态差分渲染：apply(下一状态) 只对变化部分做动画。
 */
import type { StageState, TransitionHints, TransitionSpec } from '@yanagi/core';
import { Application, Assets, Container, Graphics, Sprite, type Texture } from 'pixi.js';

export interface StageResolver {
  bgUrl(id: string): string | undefined;
  spriteUrl(id: string, emotion: string): string | undefined;
}

const DESIGN_W = 1920;
const DESIGN_H = 1080;
const SPRITE_H = 920;

const warned = new Set<string>();
function warnOnce(key: string): void {
  if (!warned.has(key)) {
    warned.add(key);
    console.info(`[yanagi-stage] "${key}" 演出暂未实现（后续迭代落地）`);
  }
}

interface Particle {
  sprite: Sprite;
  baseX: number;
  y: number;
  vy: number;
  swayAmp: number;
  swaySpeed: number;
  phase: number;
  rotSpeed: number;
  glow: boolean;
  baseAlpha: number;
  vx: number;
}

export class Stage {
  private app = new Application();
  private root = new Container();
  private bgLayer = new Container();
  private spriteLayer = new Container();
  private weatherLayer = new Container();
  private fxLayer = new Container();
  private bgSprite: Sprite | null = null;
  private spriteMap = new Map<string, { holder: Container; sprite: Sprite; texKey: string }>();
  private applied: StageState | null = null;
  private baseX = 0;
  private baseY = 0;
  private shaking = false;
  private particles: Particle[] = [];
  private particleTex = new Map<string, Texture>();
  private weatherClock = 0;
  readonly ready: Promise<void>;

  constructor(parent: HTMLElement) {
    this.ready = this.init(parent);
  }

  private async init(parent: HTMLElement): Promise<void> {
    try {
      await this.app.init({
        resizeTo: parent,
        preference: 'webgl', // 无头/CI 与 WebGPU 环境差异大，固定 WebGL（金像测试前提）
        background: 0x0b0e14,
        antialias: true,
        preserveDrawingBuffer: true,
        resolution: Math.min(window.devicePixelRatio || 1, 2),
        autoDensity: true,
      });
    } catch (e) {
      console.error('[yanagi-stage] 画布初始化失败（WebGL 不可用？）', e);
      throw e;
    }
    parent.appendChild(this.app.canvas);
    this.app.stage.addChild(this.root);
    this.root.addChild(this.bgLayer, this.spriteLayer, this.weatherLayer, this.fxLayer);
    this.app.renderer.on('resize', () => this.layout());
    this.app.ticker.add((ticker) => this.tickWeather(ticker.deltaMS / 1000));
    this.layout();
  }

  private layout(): void {
    const w = this.app.screen.width;
    const h = this.app.screen.height;
    const s = Math.min(w / DESIGN_W, h / DESIGN_H);
    this.root.scale.set(s);
    if (!this.shaking) {
      this.baseX = (w - DESIGN_W * s) / 2;
      this.baseY = (h - DESIGN_H * s) / 2;
      this.root.position.set(this.baseX, this.baseY);
    }
  }

  /** 应用舞台状态（差分）。restore=true（读档）时全部瞬时到位。 */
  async apply(next: StageState, resolver: StageResolver, hints: TransitionHints = {}, restore = false): Promise<void> {
    await this.ready;
    const prev = this.applied;
    if (prev?.bg !== next.bg) {
      const url = next.bg ? resolver.bgUrl(next.bg) : undefined;
      await this.swapBg(url ?? null, hints.bg ?? { type: 'cross', ms: restore ? 0 : 300 }, restore);
    }
    await this.syncSprites(next, resolver, restore);
    if (prev?.weather !== next.weather) {
      this.setWeather(next.weather, hints.weatherDensity ?? 0.5, restore);
    }
    if (next.filter) warnOnce(`filter:${next.filter}`);
    if (next.fgs.length) warnOnce('fg');
    this.applied = { ...next, sprites: { ...next.sprites } };
  }

  private tween(ms: number, fn: (t: number) => void): Promise<void> {
    if (ms <= 0) {
      fn(1);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const start = performance.now();
      const tick = (now: number): void => {
        const t = Math.min(1, (now - start) / ms);
        fn(t);
        if (t < 1) requestAnimationFrame(tick);
        else resolve();
      };
      requestAnimationFrame(tick);
    });
  }

  private fullRect(color: number): Sprite {
    const sp = new Sprite();
    sp.width = DESIGN_W;
    sp.height = DESIGN_H;
    sp.tint = color;
    return sp;
  }

  private placeCover(sp: Sprite, tex: Texture): void {
    const s = Math.max(DESIGN_W / tex.width, DESIGN_H / tex.height);
    sp.texture = tex;
    sp.scale.set(s);
    sp.x = (DESIGN_W - tex.width * s) / 2;
    sp.y = (DESIGN_H - tex.height * s) / 2;
  }

  private setBg(tex: Texture | null, alpha = 1): void {
    this.bgSprite?.destroy();
    if (!tex) {
      this.bgSprite = null;
      return;
    }
    const sp = new Sprite();
    this.placeCover(sp, tex);
    sp.alpha = alpha;
    this.bgLayer.addChild(sp);
    this.bgSprite = sp;
  }

  private async swapBg(url: string | null, spec: TransitionSpec, restore: boolean): Promise<void> {
    const tex = url ? await Assets.load<Texture>(url) : null;
    if (restore || spec.type === 'none' || spec.ms <= 0) {
      this.setBg(tex);
      return;
    }
    if (spec.type === 'fade') {
      const veil = this.fullRect(spec.color === 'white' ? 0xffffff : 0x000000);
      veil.alpha = 0;
      this.fxLayer.addChild(veil);
      await this.tween(spec.ms / 2, (t) => (veil.alpha = t));
      this.setBg(tex);
      await this.tween(spec.ms / 2, (t) => (veil.alpha = 1 - t));
      veil.destroy();
    } else {
      const old = this.bgSprite;
      this.setBg(tex, 0);
      const cur = this.bgSprite!;
      await this.tween(spec.ms, (t) => {
        cur.alpha = t;
        if (old) old.alpha = 1 - t;
      });
      old?.destroy();
    }
  }

  private async syncSprites(next: StageState, resolver: StageResolver, restore: boolean): Promise<void> {
    for (const id of [...this.spriteMap.keys()]) {
      if (!next.sprites[id]) await this.removeSprite(id, restore);
    }
    const focusAlpha = (id: string): number => (next.focus && next.focus !== id ? 0.62 : 1);
    for (const [id, sp] of Object.entries(next.sprites)) {
      const url = resolver.spriteUrl(id, sp.emotion);
      if (!url) {
        console.warn(`[yanagi-stage] 立绘 ${id}/${sp.emotion} 无资源，跳过`);
        continue;
      }
      const texKey = url;
      const tex = await Assets.load<Texture>(url);
      const cur = this.spriteMap.get(id);
      if (!cur) {
        this.addSprite(id, sp.x, tex, texKey, focusAlpha(id), restore);
      } else {
        cur.holder.x = (DESIGN_W * sp.x) / 100;
        if (cur.texKey !== texKey) {
          await this.swapSpriteTexture(cur, tex, texKey, restore);
        }
        const target = focusAlpha(id);
        if (Math.abs(cur.holder.alpha - target) > 0.02) {
          if (restore) cur.holder.alpha = target;
          else await this.tween(220, (t) => (cur.holder.alpha = lerpTo(cur.holder.alpha, target, t)));
        }
      }
    }
  }

  private addSprite(id: string, x: number, tex: Texture, texKey: string, alpha: number, restore: boolean): void {
    const holder = new Container();
    holder.x = (DESIGN_W * x) / 100;
    holder.y = DESIGN_H;
    holder.alpha = 0;
    holder.zIndex = x;
    const sprite = new Sprite(tex);
    sprite.anchor.set(0.5, 1);
    sprite.scale.set(SPRITE_H / tex.height);
    holder.addChild(sprite);
    this.spriteLayer.addChild(holder);
    this.spriteMap.set(id, { holder, sprite, texKey });
    const settle = (): void => {
      holder.alpha = alpha;
    };
    if (restore) settle();
    else void this.tween(260, (t) => (holder.alpha = t * alpha));
  }

  private async swapSpriteTexture(entry: { holder: Container; sprite: Sprite; texKey: string }, tex: Texture, texKey: string, restore: boolean): Promise<void> {
    if (restore) {
      entry.sprite.texture = tex;
      entry.sprite.scale.set(SPRITE_H / tex.height);
      entry.texKey = texKey;
      return;
    }
    const nextSprite = new Sprite(tex);
    nextSprite.anchor.set(0.5, 1);
    nextSprite.scale.set(SPRITE_H / tex.height);
    nextSprite.alpha = 0;
    entry.holder.addChild(nextSprite);
    const old = entry.sprite;
    await this.tween(150, (t) => {
      nextSprite.alpha = t;
      old.alpha = 1 - t;
    });
    old.destroy();
    entry.sprite = nextSprite;
    entry.texKey = texKey;
  }

  private async removeSprite(id: string, restore: boolean): Promise<void> {
    const entry = this.spriteMap.get(id);
    if (!entry) return;
    this.spriteMap.delete(id);
    if (restore) {
      entry.holder.destroy();
      return;
    }
    const start = entry.holder.alpha;
    await this.tween(220, (t) => (entry.holder.alpha = start * (1 - t)));
    entry.holder.destroy();
  }

  // ---------- 瞬时演出 ----------

  async shake(power = 6, ms = 500): Promise<void> {
    await this.ready;
    this.shaking = true;
    const total = ms;
    const start = performance.now();
    await new Promise<void>((resolve) => {
      const tick = (now: number): void => {
        const p = (now - start) / total;
        if (p >= 1) {
          this.shaking = false;
          this.root.position.set(this.baseX, this.baseY);
          resolve();
          return;
        }
        const damp = power * (1 - p);
        this.root.position.set(
          this.baseX + (Math.random() * 2 - 1) * damp,
          this.baseY + (Math.random() * 2 - 1) * damp,
        );
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  async flash(color = 'white', ms = 220): Promise<void> {
    await this.ready;
    const veil = this.fullRect(color === 'white' ? 0xffffff : 0x000000);
    veil.alpha = 0;
    this.fxLayer.addChild(veil);
    await this.tween(ms / 2, (t) => (veil.alpha = 0.85 * t));
    await this.tween(ms / 2, (t) => (veil.alpha = 0.85 * (1 - t)));
    veil.destroy();
  }

  /** 存档缩略图（JPEG Blob，约 320×180；Safari 不支持 WebP 编码故用 JPEG）。 */
  async captureThumbnail(): Promise<Blob | null> {
    await this.ready;
    try {
      const src = this.app.canvas;
      const dst = document.createElement('canvas');
      dst.width = 320;
      dst.height = 180;
      const ctx = dst.getContext('2d');
      if (!ctx) return null;
      const scale = Math.max(320 / src.width, 180 / src.height);
      const w = src.width * scale;
      const h = src.height * scale;
      ctx.drawImage(src, (320 - w) / 2, (180 - h) / 2, w, h);
      return await new Promise<Blob | null>((res) => dst.toBlob((b) => res(b), 'image/jpeg', 0.7));
    } catch {
      return null;
    }
  }

  // ---------- 天气粒子 ----------

  private particleTexture(kind: 'dot' | 'petal' | 'streak', color: number): Texture {
    const key = `${kind}:${color}`;
    const hit = this.particleTex.get(key);
    if (hit) return hit;
    const g = new Graphics();
    if (kind === 'dot') g.circle(0, 0, 6).fill({ color });
    else if (kind === 'petal') g.ellipse(0, 0, 9, 5.5).fill({ color });
    else g.roundRect(-1.5, -18, 3, 36, 1.5).fill({ color });
    const tex = this.app.renderer.generateTexture(g);
    g.destroy();
    this.particleTex.set(key, tex);
    return tex;
  }

  /** 设置天气粒子预设；null = 清空。 */
  setWeather(preset: string | null, density = 0.5, restore = false): void {
    for (const p of this.particles) p.sprite.destroy();
    this.particles = [];
    if (!preset) return;
    const d = Math.min(1, Math.max(0.1, density));
    interface Wx {
      n: number;
      kind: 'dot' | 'petal' | 'streak';
      color: number;
      alpha: number;
      vy: [number, number];
      sway: number;
      swaySpeed: [number, number];
      scale: [number, number];
      rot?: boolean;
      glow?: boolean;
      vx?: number;
    }
    const presets: Record<string, Wx> = {
      sakura: { n: 26, kind: 'petal', color: 0xf5b8c8, alpha: 0.9, vy: [42, 86], sway: 46, swaySpeed: [0.6, 1.4], scale: [0.7, 1.3], rot: true },
      snow: { n: 46, kind: 'dot', color: 0xffffff, alpha: 0.85, vy: [34, 68], sway: 22, swaySpeed: [0.3, 0.9], scale: [0.35, 0.8] },
      rain: { n: 70, kind: 'streak', color: 0xbdd4ee, alpha: 0.35, vy: [640, 860], sway: 0, swaySpeed: [0, 0], scale: [0.7, 1.2], vx: -110 },
      fireflies: { n: 16, kind: 'dot', color: 0xd8f0a0, alpha: 0.9, vy: [-10, 10], sway: 60, swaySpeed: [0.15, 0.45], scale: [0.4, 0.7], glow: true },
      dust: { n: 24, kind: 'dot', color: 0xffffff, alpha: 0.22, vy: [6, 16], sway: 30, swaySpeed: [0.1, 0.3], scale: [0.25, 0.5] },
    };
    const wx = presets[preset];
    if (!wx) {
      warnOnce(`weather:${preset}`);
      return;
    }
    const count = Math.max(4, Math.round(wx.n * d));
    for (let i = 0; i < count; i++) {
      const sprite = new Sprite(this.particleTexture(wx.kind, wx.color));
      const scale = lerpTo(wx.scale[0], wx.scale[1], Math.random());
      sprite.anchor.set(0.5);
      sprite.scale.set(scale);
      sprite.alpha = wx.alpha * (0.6 + Math.random() * 0.4);
      this.weatherLayer.addChild(sprite);
      this.particles.push({
        sprite,
        baseX: Math.random() * DESIGN_W,
        y: -DESIGN_H + Math.random() * DESIGN_H * 2,
        vy: lerpTo(wx.vy[0], wx.vy[1], Math.random()),
        swayAmp: wx.sway * (0.5 + Math.random() * 0.5),
        swaySpeed: lerpTo(wx.swaySpeed[0], wx.swaySpeed[1], Math.random()),
        phase: Math.random() * Math.PI * 2,
        rotSpeed: wx.rot ? (Math.random() * 2 - 1) * 2.2 : 0,
        glow: !!wx.glow,
        baseAlpha: sprite.alpha,
        vx: wx.vx ?? 0,
      });
    }
    if (restore) this.tickWeather(0);
  }

  private tickWeather(dt: number): void {
    if (!this.particles.length) return;
    this.weatherClock += dt;
    const t = this.weatherClock;
    for (const p of this.particles) {
      p.y += p.vy * dt;
      p.baseX += p.vx * dt;
      const x = p.baseX + Math.sin(t * p.swaySpeed + p.phase) * p.swayAmp;
      p.sprite.x = ((x % DESIGN_W) + DESIGN_W) % DESIGN_W;
      p.sprite.y = p.y;
      if (p.rotSpeed) p.sprite.rotation += p.rotSpeed * dt;
      if (p.glow) p.sprite.alpha = p.baseAlpha * (0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * 1.8 + p.phase * 3)));
      if (p.y > DESIGN_H + 40) {
        p.y = -40 - Math.random() * 80;
        p.baseX = Math.random() * DESIGN_W;
      } else if (p.y < -DESIGN_H - 80) {
        p.y = DESIGN_H + 20;
      }
    }
  }

  destroy(): void {
    for (const [, e] of this.spriteMap) e.holder.destroy();
    this.spriteMap.clear();
    this.app.destroy(true, { children: true, texture: true });
  }
}

function lerpTo(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}
