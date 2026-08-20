/** GameSession：会话编排 —— 输入、事件分发、存读档、音频/舞台驱动、自动存档。 */
import { AudioMixer } from '@yanagi/audio-web';
import {
  type BacklogEntry,
  type Block,
  type GameDef,
  type StageState,
  type TransitionHints,
  initialState,
  migrateSave,
  type SaveData,
  ScriptVM,
  validateResume,
} from '@yanagi/core';
import { Stage } from '@yanagi/stage-pixi';
import { DEFAULT_SETTINGS, GameUI, type Settings, type SaveSlotView } from '@yanagi/ui';
import { loadSettingsJson, requestPersistent, saveSettingsJson, type KVStorage } from './storage';

export interface SessionOptions {
  root: HTMLElement;
  storage: KVStorage;
  /** 试运行口令门（可选）：提供则在标题前要求输入 */
  passcode?: string;
}

const AUTO_SLOTS = ['auto:0', 'auto:1', 'auto:2'];
const MANUAL_SLOTS = ['quick', 'm0', 'm1', 'm2', 'm3', 'm4', 'm5'];
const ALL_SLOTS = [...AUTO_SLOTS, ...MANUAL_SLOTS];

function slotLabel(slot: string): string {
  if (slot.startsWith('auto:')) return `自动 ${['A', 'B', 'C'][Number(slot.slice(5))] ?? ''}`;
  if (slot === 'quick') return '快速';
  return `存档 ${Number(slot.slice(1)) + 1}`;
}

export class GameSession {
  private readonly ui: GameUI;
  private readonly stage: Stage;
  private readonly mixer = new AudioMixer();
  private settings: Settings;
  private vm: ScriptVM | null = null;
  private block: Block | null = null;
  private busy = false;
  private autoPtr = 0;
  private waitTimer: ReturnType<typeof setTimeout> | null = null;
  private readSet = new Set<string>();
  private unlocked = new Set<string>();
  private readDirty = 0;
  private thumbUrls = new Map<Blob, string>();
  private destroyed = false;

  constructor(
    private readonly def: GameDef,
    private readonly opts: SessionOptions,
  ) {
    this.settings = { ...DEFAULT_SETTINGS, ...loadSettingsJson<Settings>(def.id, DEFAULT_SETTINGS) };
    this.settings.vol = { ...DEFAULT_SETTINGS.vol, ...this.settings.vol };
    this.ui = new GameUI(opts.root, this.hooks());
    this.stage = new Stage(this.ui.stageMount);
  }

  async start(): Promise<void> {
    await this.stage.ready;
    await this.loadGlobals();
    this.applySettings(this.settings);
    this.bindInput();

    const hasSave = await this.anySave();
    this.ui.showTitle(this.def.title, hasSave, this.opts.storage.degraded ? '存储不可用（私密模式？）· 进度将不保留' : 'Yanagi Engine 0.1 · M0');
    requestPersistent();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.waitTimer) clearTimeout(this.waitTimer);
    this.stage.destroy();
  }

  // ---------- hooks（UI → 会话） ----------

  private hooks() {
    return {
      advance: () => this.onAdvance(),
      titleStart: () => void this.beginNewGame(),
      titleContinue: () => void this.continueLatest(),
      titleLoad: () => this.openLoadFrom('title'),
      titleSettings: () => this.ui.openSettings('title'),
      pauseResume: () => this.ui.closePause(),
      pauseSave: () => this.openSaveFrom('pause'),
      pauseLoad: () => this.openLoadFrom('pause'),
      pauseSettings: () => this.ui.openSettings('pause'),
      pauseTitle: () => void this.backToTitle(),
      saveSlot: (slot: string) => void this.doSave(slot),
      loadSlot: (slot: string) => void this.doLoad(slot),
      settingsChange: (s: Settings) => {
        this.settings = s;
        saveSettingsJson(this.def.id, s);
        this.applySettings(s);
      },
      replayVoice: (voice: string) => void this.playVoice(voice, false),
      panelClosed: () => {
        if (this.ui.titleOpen) return;
        // 从标题打开的读档/设置关闭后回到标题语境
        if (!this.vm) this.ui.showTitle(this.def.title, true);
      },
    };
  }

  // ---------- 输入 ----------

  private bindInput(): void {
    document.addEventListener('keydown', (e) => {
      if (this.destroyed) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        if (this.ui.overlayOpen && !this.ui.titleOpen) {
          if (this.ui.saveOpen) this.ui.closeSaveMenu();
          else if (this.ui.settingsOpen) this.ui.closeSettings();
          else if (this.ui.pauseOpen) this.ui.closePause();
          return;
        }
        if (!this.ui.titleOpen && this.vm) {
          if (this.ui.backlogOpen) this.ui.closeBacklog();
          else this.ui.openPause();
        }
        return;
      }
      if (this.ui.titleOpen || this.ui.overlayOpen || this.ui.backlogOpen) return;
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        this.onAdvance();
      } else if (e.key === 'l' || e.key === 'L') {
        e.preventDefault();
        this.ui.toggleBacklog(this.history());
      } else if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        if (document.fullscreenElement) void document.exitFullscreen();
        else void document.documentElement.requestFullscreen().catch(() => undefined);
      }
    });

    // 音频解锁：任何首次手势
    const unlock = (): void => {
      void this.mixer.unlock();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);

    const pagehide = (): void => {
      if (this.vm && !this.ui.titleOpen) void this.saveGame('quick');
      void this.flushGlobals();
    };
    window.addEventListener('pagehide', pagehide);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') pagehide();
    });
  }

  private onAdvance(): void {
    if (this.ui.overlayOpen || this.ui.titleOpen) return;
    if (this.ui.backlogOpen) {
      this.ui.closeBacklog();
      return;
    }
    // loop 过渡期（block 已设但演出/资源尚未就绪）忽略输入：
    // 此时推进会跳步并使 block 悬空造成死锁
    if (this.busy) return;
    if (!this.vm || !this.block) return;
    if (this.block.kind === 'dialogue') {
      if (this.ui.textPlaying) {
        this.ui.completeText();
        return;
      }
      // 过渡期（loop 尚在 await 资源/转场）置空 block，防止重复推进导致 pc 跳步
      this.block = null;
      if (!this.vm.state.audio.voiceSustain) this.mixer.stopVoice();
      this.vm.finishDialogue();
      this.handleEvents();
      this.continueLoop();
      return;
    }
    if (this.block.kind === 'wait') {
      // 点击跳过等待（商业 VN 基线行为）
      this.block = null;
      if (this.waitTimer) {
        clearTimeout(this.waitTimer);
        this.waitTimer = null;
      }
      this.vm.finishWait();
      this.continueLoop();
    }
    // menu：必须选择
  }

  // ---------- 游戏流程 ----------

  private async beginNewGame(): Promise<void> {
    await this.mixer.unlock();
    this.ui.hideTitle();
    const st = initialState(this.def.bundle);
    this.vm = new ScriptVM(this.def.bundle, st);
    await this.applyFullState(st);
    this.continueLoop();
  }

  private async continueLatest(): Promise<void> {
    let latest: SaveData | null = null;
    let latestSlot = '';
    for (const slot of ALL_SLOTS) {
      const s = await this.readSave(slot);
      if (s && (!latest || s.savedAt > latest.savedAt)) {
        latest = s;
        latestSlot = slot;
      }
    }
    if (!latest) {
      await this.beginNewGame();
      return;
    }
    await this.restore(latestSlot, latest);
  }

  private async backToTitle(): Promise<void> {
    if (this.vm) await this.saveGame('quick');
    if (this.waitTimer) clearTimeout(this.waitTimer);
    this.block = null;
    this.vm = null;
    this.busy = false;
    await this.mixer.stopBgm(800);
    await this.mixer.stopAmbient();
    this.ui.closePause();
    this.ui.hideText();
    await this.stage.apply(
      { bg: null, sprites: {}, weather: null, filter: null, fgs: [], focus: null },
      this.resolver(),
      {},
      true,
    );
    this.ui.showTitle(this.def.title, true);
  }

  private async finishGame(): Promise<void> {
    this.block = null;
    this.ui.hideText();
    await this.mixer.stopBgm(1200);
    this.ui.chapterTitle('— 完 —');
    setTimeout(() => {
      if (!this.destroyed) void this.backToTitle();
    }, 2600);
  }

  // ---------- 主循环 ----------

  private continueLoop(): void {
    if (this.busy || !this.vm) return;
    this.busy = true;
    void this.loop().finally(() => {
      this.busy = false;
    });
  }

  private async loop(): Promise<void> {
    if (!this.vm) return;
    try {
      for (;;) {
        const block = this.vm.run();
        this.block = block;
        await this.handleEvents();
        switch (block.kind) {
          case 'dialogue': {
            const ch = this.def.characters.find((c) => c.id === block.line.speaker);
            this.ui.showDialogue(
              {
                displayName: block.line.displayName,
                color: ch?.color ?? null,
                segments: block.line.segments,
              },
              {
                cps: this.settings.textCps,
                instant: this.settings.textCps <= 0,
              },
            );
            if (block.line.voice) void this.playVoice(block.line.voice);
            return;
          }
          case 'menu': {
            this.ui.hideText();
            this.ui.showChoices(block.prompt ?? null, block.options, (i) => {
              this.pick(i);
            });
            return;
          }
          case 'wait': {
            if (this.waitTimer) clearTimeout(this.waitTimer);
            this.waitTimer = setTimeout(() => {
              this.waitTimer = null;
              this.vm?.finishWait();
              this.continueLoop();
            }, block.ms);
            return;
          }
          case 'end':
          case 'ended':
            await this.finishGame();
            return;
        }
      }
    } catch (e) {
      console.error('[yanagi] 运行错误', e);
      this.ui.showError(`运行时错误：${(e as Error).message}\n\n进度已自动保存到「快速」槽。`);
      await this.saveGame('quick');
    }
  }

  private pick(i: number): void {
    if (!this.vm || this.block?.kind !== 'menu') return;
    this.vm.chooseOption(i);
    void this.handleEvents();
    void this.autosave();
    this.continueLoop();
  }

  // ---------- 事件分发 ----------

  private async handleEvents(): Promise<void> {
    if (!this.vm) return;
    for (const ev of this.vm.drainEvents()) {
      switch (ev.t) {
        case 'stage':
          await this.stage.apply(this.vm.state.stage, this.resolver(), ev.hints);
          break;
        case 'bgm': {
          const track = ev.id ? this.def.manifest.bgm[ev.id] : null;
          await this.mixer.playBgm(
            track ? { url: new URL(track.url, location.href).href, loopStart: track.loopStart, loopEnd: track.loopEnd } : null,
            { fadeMs: ev.fadeMs, vol: ev.vol },
          );
          break;
        }
        case 'ambient': {
          const t = ev.id ? this.def.manifest.bgm[ev.id] ?? this.seAsTrack(ev.id) : null;
          await this.mixer.playAmbient(t ? { url: this.abs(t.url), loopStart: t.loopStart, loopEnd: t.loopEnd } : null);
          break;
        }
        case 'se': {
          const url = this.def.manifest.se[ev.id] ?? this.def.manifest.bgm[ev.id]?.url;
          if (url) await this.mixer.playSe(this.abs(url));
          else console.warn(`[yanagi] 音效 "${ev.id}" 无资源`);
          break;
        }
        case 'title':
          this.ui.chapterTitle(ev.text);
          break;
        case 'unlock':
          this.unlocked.add(`${ev.kind}:${ev.id}`);
          void this.flushGlobals();
          break;
        case 'shake':
          void this.stage.shake(ev.power, ev.ms);
          break;
        case 'flash':
          void this.stage.flash(ev.color, ev.ms);
          break;
        case 'read':
          this.readSet.add(ev.uid);
          this.readDirty += 1;
          if (this.readDirty >= 15) void this.flushGlobals();
          break;
        case 'warn':
          console.info(`[yanagi] ${ev.message}`);
          break;
      }
    }
  }

  private seAsTrack(id: string): { url: string; loopStart?: number; loopEnd?: number } | undefined {
    const url = this.def.manifest.se[id];
    return url ? { url } : undefined;
  }

  private abs(url: string): string {
    return new URL(url, location.href).href;
  }

  private resolver() {
    return {
      bgUrl: (id: string) => this.def.manifest.bg[id],
      spriteUrl: (id: string, emotion: string) => this.def.manifest.sprites[id]?.[emotion],
    };
  }

  /** 读档/新开局：完整重建舞台与音频（瞬时）。 */
  private async applyFullState(state: { stage: StageState; audio: { bgm: string | null; ambient: string | null } }): Promise<void> {
    await this.stage.apply(state.stage, this.resolver(), {}, true);
    const bgm = state.audio.bgm ? this.def.manifest.bgm[state.audio.bgm] : null;
    await this.mixer.playBgm(bgm ? { url: this.abs(bgm.url), loopStart: bgm.loopStart, loopEnd: bgm.loopEnd } : null, { fadeMs: 0 });
    const amb = state.audio.ambient ? this.def.manifest.bgm[state.audio.ambient] ?? this.seAsTrack(state.audio.ambient) : null;
    await this.mixer.playAmbient(amb ? { url: this.abs(amb.url) } : null);
  }

  private async playVoice(id: string, cut = true): Promise<void> {
    const url = this.def.manifest.voice[id];
    if (!url) {
      console.warn(`[yanagi] 语音 "${id}" 无资源`);
      return;
    }
    await this.mixer.playVoice(this.abs(url), { cutPrevious: cut });
  }

  // ---------- 存档 ----------

  private async autosave(): Promise<void> {
    if (!this.vm) return;
    const slot = AUTO_SLOTS[this.autoPtr % AUTO_SLOTS.length]!;
    this.autoPtr += 1;
    await this.saveGame(slot);
  }

  private async saveGame(slot: string): Promise<void> {
    if (!this.vm) return;
    try {
      const thumbnail = await this.stage.captureThumbnail();
      const state = this.vm.snapshot();
      const last = state.history[state.history.length - 1];
      const data: SaveData = {
        version: 1,
        game: this.def.id,
        state,
        savedAt: Date.now(),
        chapterTitle: state.chapter,
        lineSummary: (last?.text ?? '').slice(0, 24),
        ...(thumbnail ? { thumbnail } : {}),
      };
      await this.opts.storage.set(`save:${slot}`, data);
    } catch (e) {
      console.warn('[yanagi] 存档失败', e);
    }
  }

  private async readSave(slot: string): Promise<SaveData | null> {
    try {
      const raw = await this.opts.storage.get<SaveData>(`save:${slot}`);
      if (!raw) return null;
      return migrateSave(raw);
    } catch {
      return null;
    }
  }

  private async anySave(): Promise<boolean> {
    const keys = await this.opts.storage.keys('save:');
    return keys.length > 0;
  }

  private async restore(slot: string, data: SaveData): Promise<void> {
    const state = data.state;
    const check = validateResume(this.def.bundle, state);
    if (check.status === 'fail') {
      this.ui.showError(`无法读取 "${slotLabel(slot)}"：${check.reason}`);
      return;
    }
    if (check.status === 'relocated') {
      console.warn('[yanagi] 剧本已更新，存档重定位到最近安全点');
    }
    await this.mixer.unlock();
    this.ui.hideTitle();
    this.ui.closeSaveMenu();
    this.vm = new ScriptVM(this.def.bundle, state);
    await this.applyFullState(state);
    this.continueLoop();
  }

  private async doSave(slot: string): Promise<void> {
    await this.saveGame(slot);
    this.ui.closeSaveMenu();
    this.ui.closePause();
  }

  private async doLoad(slot: string): Promise<void> {
    const data = await this.readSave(slot);
    if (!data) {
      this.ui.showError(`存档 "${slotLabel(slot)}" 不存在或已损坏`);
      return;
    }
    await this.restore(slot, data);
  }

  private async openSaveFrom(origin: 'title' | 'pause'): Promise<void> {
    const slots = await this.collectSlots();
    this.ui.openSaveMenu('save', origin, slots);
  }

  private async openLoadFrom(origin: 'title' | 'pause'): Promise<void> {
    const slots = await this.collectSlots();
    this.ui.openSaveMenu('load', origin, slots);
  }

  private async collectSlots(): Promise<SaveSlotView[]> {
    const out: SaveSlotView[] = [];
    for (const slot of ALL_SLOTS) {
      const data = await this.readSave(slot);
      if (data) {
        let thumbUrl: string | null = null;
        if (data.thumbnail) {
          thumbUrl = this.thumbUrls.get(data.thumbnail) ?? URL.createObjectURL(data.thumbnail);
          this.thumbUrls.set(data.thumbnail, thumbUrl);
        }
        out.push({
          slot,
          label: slotLabel(slot),
          chapterTitle: data.chapterTitle,
          lineSummary: data.lineSummary,
          savedAt: data.savedAt,
          thumbUrl,
          empty: false,
        });
      } else {
        out.push({
          slot,
          label: slotLabel(slot),
          chapterTitle: '',
          lineSummary: '',
          savedAt: 0,
          thumbUrl: null,
          empty: true,
        });
      }
    }
    return out;
  }

  // ---------- 全局进度 / 设置 ----------

  private async loadGlobals(): Promise<void> {
    try {
      const reads = await this.opts.storage.get<string[]>('global:read');
      if (reads) this.readSet = new Set(reads);
      const unlock = await this.opts.storage.get<string[]>('global:unlock');
      if (unlock) this.unlocked = new Set(unlock);
    } catch {
      /* 降级存储 */
    }
  }

  private async flushGlobals(): Promise<void> {
    this.readDirty = 0;
    try {
      await this.opts.storage.set('global:read', [...this.readSet]);
      await this.opts.storage.set('global:unlock', [...this.unlocked]);
    } catch {
      /* ignore */
    }
  }

  private applySettings(s: Settings): void {
    this.mixer.setVolumes({
      bgm: s.vol.bgm,
      se: s.vol.se,
      voice: s.vol.voice,
      ambient: s.vol.ambient,
    });
    this.ui.applySettings(s);
  }

  private history(): BacklogEntry[] {
    return this.vm?.state.history.slice().reverse() ?? [];
  }
}
