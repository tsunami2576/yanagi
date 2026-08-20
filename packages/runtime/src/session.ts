/** GameSession：会话编排 —— 输入、事件分发、存读档、音频/舞台驱动、自动存档。 */
import { AudioMixer } from '@yanagi/audio-web';
import {
  type BacklogEntry,
  type Block,
  cloneState,
  type GameDef,
  type GameState,
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

function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

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
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private autoMode = false;
  private skipMode: 'off' | 'read' | 'all' = 'off';
  private skipHeld = false;
  private readSet = new Set<string>();
  private unlocked = new Set<string>();
  /** 本局开始时的已读快照（回想中"以前读过"变色判定） */
  private readBaseline = new Set<string>();
  private lastSaveMenu: { mode: 'save' | 'load'; origin: 'title' | 'pause' } | null = null;
  /** 会话内回溯环缓冲（安全点快照，上限 20，跨会话不保留） */
  private rollbackRing: { uid: string; state: GameState }[] = [];
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
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
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
      rollback: (uid: string) => void this.rollbackTo(uid),
      exportSaves: () => void this.exportSaves(),
      importFile: (file: File) => void this.importFile(file),
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
        if (!this.ui.titleOpen && !this.ui.overlayOpen) this.ui.toggleBacklog(this.backlogEntries());
      } else if (e.key === 'a' || e.key === 'A') {
        if (!this.ui.titleOpen && !this.ui.overlayOpen && this.vm) {
          e.preventDefault();
          this.setAuto(!this.autoMode);
        }
      } else if (e.key === 'Tab') {
        if (!this.ui.titleOpen && !this.ui.overlayOpen && this.vm) {
          e.preventDefault();
          this.cycleSkip();
        }
      } else if (e.key === 'Control' && !e.repeat) {
        this.beginCtrlSkip();
      } else if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        if (document.fullscreenElement) void document.exitFullscreen();
        else void document.documentElement.requestFullscreen().catch(() => undefined);
      }
    });
    document.addEventListener('keyup', (e) => {
      if (e.key === 'Control') this.endCtrlSkip();
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
      if (document.visibilityState === 'hidden') {
        pagehide();
        if (this.settings.muteOnBlur) void this.mixer.suspend();
      } else if (this.settings.muteOnBlur) {
        void this.mixer.resumeCtx();
      }
    });

    // 滚轮：向下 = 前进（同单击），向上 = 呼出对话记录（回溯在记录界面内按条触发）
    let wheelGate = 0;
    this.opts.root.addEventListener(
      'wheel',
      (e) => {
        const t = e.target as Element;
        if (t.closest('.yg-backlog, .yg-panel, .yg-title')) return; // 面板内滚动放行
        const now = performance.now();
        if (now - wheelGate < 140) return;
        if (this.ui.overlayOpen || this.ui.titleOpen) return;
        wheelGate = now;
        if (e.deltaY < 0) {
          if (!this.ui.backlogOpen && this.vm) this.ui.openBacklog(this.backlogEntries());
        } else if (e.deltaY > 0) {
          if (!this.ui.backlogOpen) this.onAdvance();
        }
      },
      { passive: true },
    );
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
    this.readBaseline = new Set(this.readSet);
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
    this.resetModes();
    this.rollbackRing = [];
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
        const block = this.vm.run(this.skipActive);
        this.block = block;
        await this.handleEvents();
        switch (block.kind) {
          case 'dialogue': {
            // wasRead 须在 handleEvents（标记已读）之前取
            const wasRead = this.readSet.has(block.uid);
            this.pushRollback(block.uid);
            if (this.skipActive && this.skipMode === 'read' && !wasRead && !this.skipHeld) {
              this.setSkip('off'); // 仅已读模式遇到未读行：停止跳过，正常显示
            }
            const ch = this.def.characters.find((c) => c.id === block.line.speaker);
            const view = {
              displayName: block.line.displayName,
              color: ch?.color ?? null,
              segments: block.line.segments,
            };
            const skipping = this.skipActive;
            this.ui.showDialogue(view, {
              cps: this.settings.textCps,
              instant: skipping || this.settings.textCps <= 0,
            });
            if (skipping) {
              this.mixer.stopVoice();
              this.scheduleAdvance(45);
              return;
            }
            if (block.line.voice) void this.playVoice(block.line.voice);
            if (this.autoMode) this.scheduleAuto(block.line.plainText.length);
            return;
          }
          case 'menu': {
            if (this.skipMode !== 'off') this.setSkip('off'); // 选择肢前停止跳过（Auto 暂停等待选择）
            this.pushRollback(block.uid);
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

  // ---------- Auto / Skip ----------

  private get skipActive(): boolean {
    return this.skipMode !== 'off' || this.skipHeld;
  }

  private clearPending(): void {
    if (this.pendingTimer !== null) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
  }

  private setAuto(on: boolean): void {
    this.autoMode = on;
    if (on) {
      this.setSkip('off');
      this.clearPending();
    } else {
      this.clearPending();
    }
    this.ui.setBadge('auto', on);
    if (on && this.block?.kind === 'dialogue') this.scheduleAuto(this.currentLineChars());
  }

  private cycleSkip(): void {
    this.setSkip(this.skipMode === 'off' ? 'read' : this.skipMode === 'read' ? 'all' : 'off');
  }

  private setSkip(mode: 'off' | 'read' | 'all'): void {
    this.skipMode = mode;
    if (mode !== 'off') {
      this.autoMode = false;
      this.ui.setBadge('auto', false);
      this.clearPending();
      this.mixer.stopVoice();
      this.ui.setBadge('skip', true, mode === 'read' ? 'SKIP·已读' : 'SKIP·全部');
      if (this.block?.kind === 'dialogue') {
        this.ui.completeText();
        this.scheduleAdvance(45);
      }
    } else {
      this.clearPending();
      this.ui.setBadge('skip', false, 'SKIP');
    }
  }

  private beginCtrlSkip(): void {
    if (this.skipHeld || !this.vm || this.ui.titleOpen || this.ui.overlayOpen) return;
    this.skipHeld = true;
    this.mixer.stopVoice();
    this.ui.setBadge('skip', true, 'SKIP▶');
    if (this.block?.kind === 'dialogue') {
      this.ui.completeText();
      this.scheduleAdvance(60);
    }
  }

  private endCtrlSkip(): void {
    this.skipHeld = false;
    if (this.skipMode === 'off') {
      this.clearPending();
      this.ui.setBadge('skip', false, 'SKIP');
    }
  }

  private currentLineChars(): number {
    if (this.block?.kind === 'dialogue') return this.block.line.plainText.length;
    return 0;
  }

  /** 定时推进（Skip 快进 / Auto 尾延共用）。 */
  private scheduleAdvance(delayMs: number): void {
    this.clearPending();
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      this.timerAdvance();
    }, delayMs);
  }

  private timerAdvance(): void {
    if (!this.vm || this.busy) return;
    if (this.block?.kind !== 'dialogue') return;
    if (this.ui.overlayOpen || this.ui.titleOpen || this.ui.backlogOpen) {
      this.scheduleAdvance(300); // 面板打开期间挂起，稍后重试
      return;
    }
    if (this.ui.textPlaying) {
      if (this.skipActive) this.ui.completeText();
      else {
        this.scheduleAuto(this.currentLineChars());
        return;
      }
    }
    this.block = null;
    this.mixer.stopVoice();
    this.vm.finishDialogue();
    this.handleEvents();
    this.continueLoop();
  }

  /** Auto：等文本完成 + 语音播完，再等尾延。 */
  private scheduleAuto(chars: number): void {
    this.clearPending();
    const tick = (): void => {
      if (!this.autoMode || !this.vm || this.block?.kind !== 'dialogue') return;
      if (this.ui.overlayOpen || this.ui.titleOpen || this.ui.backlogOpen) {
        this.pendingTimer = setTimeout(tick, 300);
        return;
      }
      if (this.ui.textPlaying || this.mixer.voicePlaying) {
        this.pendingTimer = setTimeout(tick, 120);
        return;
      }
      const tail = Math.max(200, this.settings.autoBaseMs + chars * this.settings.autoPerCharMs);
      this.pendingTimer = setTimeout(() => {
        this.pendingTimer = null;
        if (this.autoMode) this.timerAdvance();
      }, tail);
    };
    tick();
  }

  private resetModes(): void {
    this.autoMode = false;
    this.skipMode = 'off';
    this.skipHeld = false;
    this.clearPending();
    this.ui.setBadge('auto', false);
    this.ui.setBadge('skip', false, 'SKIP');
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
    this.resetModes();
    this.readBaseline = new Set(this.readSet);
    this.rollbackRing = [];
    this.vm = new ScriptVM(this.def.bundle, state);
    await this.applyFullState(state);
    this.continueLoop();
  }

  /** 会话内回溯：跳转到回想中对应句/选择的安全点。 */
  private async rollbackTo(uid: string): Promise<void> {
    if (!this.vm) return;
    const idx = this.rollbackRing.map((e) => e.uid).lastIndexOf(uid);
    const hit = idx >= 0 ? this.rollbackRing[idx] : null;
    if (!hit) return;
    this.rollbackRing = this.rollbackRing.slice(0, idx + 1);
    if (this.waitTimer) {
      clearTimeout(this.waitTimer);
      this.waitTimer = null;
    }
    this.resetModes();
    this.mixer.stopVoice();
    const state = cloneState(hit.state);
    this.vm = new ScriptVM(this.def.bundle, state);
    await this.applyFullState(state);
    this.continueLoop();
  }

  private pushRollback(uid: string): void {
    if (!this.vm) return;
    this.rollbackRing.push({ uid, state: this.vm.snapshot() });
    if (this.rollbackRing.length > 20) this.rollbackRing.shift();
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
    this.lastSaveMenu = { mode: 'save', origin };
    this.ui.openSaveMenu('save', origin, slots);
  }

  private async openLoadFrom(origin: 'title' | 'pause'): Promise<void> {
    const slots = await this.collectSlots();
    this.lastSaveMenu = { mode: 'load', origin };
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

  /** 想起数据：正序（最旧在上），标注"以前读过"与会话内可回溯。 */
  private backlogEntries(): (BacklogEntry & { read?: boolean; canRollback?: boolean })[] {
    if (!this.vm) return [];
    return this.vm.state.history.map((e) => ({
      ...e,
      read: this.readBaseline.has(e.uid),
      canRollback: this.rollbackRing.some((r) => r.uid === e.uid),
    }));
  }

  // ---------- 存档导出 / 导入 ----------

  async exportSaves(): Promise<void> {
    const saves: Record<string, unknown> = {};
    for (const slot of ALL_SLOTS) {
      const data = await this.readSave(slot);
      if (!data) continue;
      const entry: Record<string, unknown> = { ...data };
      delete entry['thumbnail'];
      if (data.thumbnail) entry['thumbnailData'] = await blobToDataURL(data.thumbnail);
      saves[slot] = entry;
    }
    const payload = {
      format: 'yanagi-saves',
      version: 1,
      game: this.def.id,
      exportedAt: Date.now(),
      read: [...this.readSet],
      unlocked: [...this.unlocked],
      saves,
    };
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `yanagi-${this.def.id}-saves-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async importFile(file: File): Promise<void> {
    try {
      const payload = JSON.parse(await file.text()) as {
        format?: string;
        version?: number;
        game?: string;
        read?: string[];
        unlocked?: string[];
        saves?: Record<string, Record<string, unknown>>;
      };
      if (payload.format !== 'yanagi-saves' || payload.version !== 1) {
        throw new Error('不是有效的柳引擎存档文件');
      }
      if (payload.game !== this.def.id) {
        throw new Error(`存档属于游戏 "${payload.game}"，与当前游戏不匹配`);
      }
      let imported = 0;
      for (const [slot, raw] of Object.entries(payload.saves ?? {})) {
        if (!ALL_SLOTS.includes(slot)) continue;
        const incomingSavedAt = typeof raw['savedAt'] === 'number' ? raw['savedAt'] : 0;
        const existing = await this.readSave(slot);
        if (existing && existing.savedAt >= incomingSavedAt) continue;
        let thumbnail: Blob | undefined;
        if (typeof raw['thumbnailData'] === 'string') {
          thumbnail = await (await fetch(raw['thumbnailData'])).blob();
        }
        const entry = { ...raw };
        delete entry['thumbnailData'];
        await this.opts.storage.set(`save:${slot}`, {
          ...entry,
          state: entry['state'],
          version: 1,
          game: this.def.id,
          ...(thumbnail ? { thumbnail } : {}),
        });
        imported++;
      }
      for (const uid of payload.read ?? []) this.readSet.add(uid);
      for (const u of payload.unlocked ?? []) this.unlocked.add(u);
      await this.flushGlobals();
      if (this.lastSaveMenu) {
        const { mode, origin } = this.lastSaveMenu;
        if (mode === 'save') await this.openSaveFrom(origin);
        else await this.openLoadFrom(origin);
      }
      console.info(`[yanagi] 导入完成：${imported} 个存档`);
    } catch (e) {
      console.error('[yanagi] 导入失败', e);
      this.ui.showError(`导入失败：${(e as Error).message}`);
    }
  }
}
