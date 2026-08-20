/**
 * Web Audio 混音器：四总线（BGM/SE/Voice/Ambient）→ master。
 * 采样级无缝循环（loopStart/loopEnd）、交叉淡化、语音 ducking、iOS 手势解锁。
 * 播放器放 KeyedRequest 队列防止同一 URL 并发解码。
 */
export type Bus = 'bgm' | 'se' | 'voice' | 'ambient';

export interface TrackRef {
  url: string;
  loopStart?: number;
  loopEnd?: number;
}

interface VoiceHandle {
  src: AudioBufferSourceNode;
  url: string;
}

const CACHE_MAX = 24;
const DUCK_FACTOR = 0.5;

export class AudioMixer {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buses: Record<Bus, GainNode> | null = null;
  private vols: Record<Bus, number> = { bgm: 0.8, se: 0.8, voice: 0.9, ambient: 0.7 };
  private cache = new Map<string, AudioBuffer>();
  private cacheOrder: string[] = [];
  private decoding = new Map<string, Promise<AudioBuffer>>();

  private bgm: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private ambient: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private voice: VoiceHandle | null = null;
  private ducked = false;

  get unlocked(): boolean {
    return this.ctx?.state === 'running';
  }

  /** 是否有语音正在播放（Auto 模式等待语音结束用） */
  get voicePlaying(): boolean {
    return this.voice !== null;
  }

  private ensureCtx(): AudioContext {
    if (this.ctx) return this.ctx;
    const AC: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AC();
    const master = ctx.createGain();
    master.connect(ctx.destination);
    const buses = {
      bgm: ctx.createGain(),
      se: ctx.createGain(),
      voice: ctx.createGain(),
      ambient: ctx.createGain(),
    };
    for (const g of Object.values(buses)) g.connect(master);
    this.ctx = ctx;
    this.master = master;
    this.buses = buses;
    this.applyVolumes();
    return ctx;
  }

  /** 必须在用户手势内调用。 */
  async unlock(): Promise<void> {
    const ctx = this.ensureCtx();
    if (ctx.state !== 'running') {
      try {
        await ctx.resume();
      } catch {
        /* ignore */
      }
    }
    // 预播静音 buffer（iOS 实测需要）
    const buf = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(0);
  }

  setVolume(bus: Bus, vol: number): void {
    this.vols[bus] = Math.min(1, Math.max(0, vol));
    if (this.buses && !this.ducked) this.buses[bus].gain.value = this.vols[bus];
  }

  setVolumes(v: Record<Bus, number>): void {
    for (const bus of Object.keys(v) as Bus[]) this.setVolume(bus, v[bus]);
  }

  private applyVolumes(): void {
    if (!this.buses) return;
    for (const bus of Object.keys(this.vols) as Bus[]) {
      this.buses[bus].gain.value = this.ducked && bus === 'bgm' ? this.vols[bus] * DUCK_FACTOR : this.vols[bus];
    }
  }

  private async decode(url: string): Promise<AudioBuffer> {
    const hit = this.cache.get(url);
    if (hit) return hit;
    const pending = this.decoding.get(url);
    if (pending) return pending;
    const task = (async (): Promise<AudioBuffer> => {
      const ctx = this.ensureCtx();
      const res = await fetch(url);
      const ab = await res.arrayBuffer();
      // Safari 兼容：promise 形式在老 WebKit 有历史 bug，双写法
      const buf = await new Promise<AudioBuffer>((resolve, reject) => {
        const p = ctx.decodeAudioData(ab, resolve, reject) as unknown as Promise<AudioBuffer> | undefined;
        if (p && typeof p.then === 'function') p.then(resolve, reject);
      });
      this.cache.set(url, buf);
      this.cacheOrder.push(url);
      while (this.cacheOrder.length > CACHE_MAX) {
        const evict = this.cacheOrder.shift()!;
        if (evict !== url) this.cache.delete(evict);
      }
      return buf;
    })();
    this.decoding.set(url, task);
    try {
      return await task;
    } finally {
      this.decoding.delete(url);
    }
  }

  // ---------- BGM ----------

  async playBgm(track: TrackRef | null, opts: { fadeMs?: number; vol?: number } = {}): Promise<void> {
    const fadeMs = opts.fadeMs ?? 1000;
    const vol = opts.vol ?? 1;
    if (!track) {
      await this.stopBgm(fadeMs);
      return;
    }
    const ctx = this.ensureCtx();
    const buf = await this.decode(track.url);
    const gain = ctx.createGain();
    gain.connect(this.buses!.bgm);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    if (track.loopStart !== undefined) src.loopStart = track.loopStart;
    if (track.loopEnd !== undefined && track.loopEnd > (track.loopStart ?? 0)) src.loopEnd = track.loopEnd;
    src.connect(gain);
    const old = this.bgm;
    this.bgm = { src, gain };
    if (fadeMs <= 0) {
      gain.gain.value = vol;
      src.start();
      this.fadeOutAndStop(old, 0);
      return;
    }
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(vol, ctx.currentTime + fadeMs / 1000);
    src.start();
    this.fadeOutAndStop(old, fadeMs);
  }

  async stopBgm(fadeMs = 1000): Promise<void> {
    const cur = this.bgm;
    this.bgm = null;
    this.fadeOutAndStop(cur, fadeMs);
  }

  private fadeOutAndStop(handle: { src: AudioBufferSourceNode; gain: GainNode } | null, fadeMs: number): void {
    if (!handle || !this.ctx) {
      handle?.src.stop();
      return;
    }
    const t = this.ctx.currentTime;
    handle.gain.gain.cancelScheduledValues(t);
    handle.gain.gain.setValueAtTime(handle.gain.gain.value, t);
    handle.gain.gain.linearRampToValueAtTime(0, t + Math.max(0.01, fadeMs / 1000));
    const timeout = setTimeout(() => {
      try {
        handle.src.stop();
      } catch {
        /* already stopped */
      }
      handle.gain.disconnect();
    }, fadeMs + 80);
    handle.src.onended = () => clearTimeout(timeout);
  }

  // ---------- Ambient ----------

  async playAmbient(track: TrackRef | null): Promise<void> {
    if (!track) {
      await this.stopAmbient();
      return;
    }
    const buf = await this.decode(track.url);
    await this.stopAmbient();
    const ctx = this.ensureCtx();
    const gain = ctx.createGain();
    gain.connect(this.buses!.ambient);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    if (track.loopStart !== undefined) src.loopStart = track.loopStart;
    if (track.loopEnd !== undefined) src.loopEnd = track.loopEnd;
    src.connect(gain);
    gain.gain.value = 1;
    src.start();
    this.ambient = { src, gain };
  }

  async stopAmbient(): Promise<void> {
    const cur = this.ambient;
    this.ambient = null;
    if (cur) {
      try {
        cur.src.stop();
      } catch {
        /* ignore */
      }
      cur.gain.disconnect();
    }
  }

  // ---------- SE / Voice ----------

  async playSe(url: string): Promise<void> {
    const buf = await this.decode(url);
    const ctx = this.ensureCtx();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.buses!.se);
    src.start();
  }

  async playVoice(url: string, opts: { cutPrevious?: boolean } = {}): Promise<void> {
    const buf = await this.decode(url);
    const ctx = this.ensureCtx();
    if (opts.cutPrevious !== false) this.stopVoice(120);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.buses!.voice);
    src.start();
    this.voice = { src, url };
    src.onended = () => {
      if (this.voice?.src === src) {
        this.voice = null;
        this.unDuck();
      }
    };
    this.duck();
  }

  stopVoice(fadeMs = 0): void {
    const cur = this.voice;
    this.voice = null;
    if (!cur) return;
    if (fadeMs > 0 && this.ctx) {
      // AudioBufferSourceNode 无 gain；直接 stop（语音极短淡出意义有限）
      const t = this.ctx.currentTime;
      setTimeout(() => {
        try {
          cur.src.stop();
        } catch {
          /* ignore */
        }
      }, t && fadeMs);
    } else {
      try {
        cur.src.stop();
      } catch {
        /* ignore */
      }
    }
    this.unDuck();
  }

  private duck(): void {
    if (this.ducked || !this.ctx || !this.buses) return;
    this.ducked = true;
    const t = this.ctx.currentTime;
    const g = this.buses.bgm.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(this.vols.bgm * DUCK_FACTOR, t + 0.6);
  }

  private unDuck(): void {
    if (!this.ducked || !this.ctx || !this.buses) return;
    const t = this.ctx.currentTime;
    const g = this.buses.bgm.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(this.vols.bgm, t + 1.0);
    this.ducked = false;
  }

  /** 失焦静音（可选行为由 session 决定）。 */
  async suspend(): Promise<void> {
    if (this.ctx?.state === 'running') await this.ctx.suspend();
  }

  async resumeCtx(): Promise<void> {
    if (this.ctx?.state === 'suspended') await this.ctx.resume();
  }
}
