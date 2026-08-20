/**
 * Vite 插件：`import game from 'virtual:yanagi-game'`
 * 编译 story/*.yn + 扫描 assets/ 生成 manifest + 资源存在性校验。
 * 剧本/配置变更 → 全量重载（保现场热替换属 M1 范围）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import type { Bundle, Manifest } from '@yanagi/core';
import { collectAssetRefs, compileStory, type CharDefInput } from './compile';
import { formatIssue } from './errors';

const VIRTUAL_ID = 'virtual:yanagi-game';
const RESOLVED = '\0' + VIRTUAL_ID;

interface GameConfig {
  id: string;
  title: string;
  entry?: string;
  characters?: CharDefInput[];
  /** BGM 循环点（秒）：{ "theme_main": [起, 止] } */
  bgmLoop?: Record<string, [number, number]>;
}

const IMG_EXT = ['.svg', '.png', '.jpg', '.jpeg', '.webp'];
const AUD_EXT = ['.wav', '.mp3', '.m4a', '.ogg'];

function natSort(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

function scanDir(dir: string, exts: string[]): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => exts.includes(f.slice(f.lastIndexOf('.')).toLowerCase()))
      .sort(natSort);
  } catch {
    return [];
  }
}

export function scanManifest(root: string, bgmLoop: Record<string, [number, number]> = {}): Manifest {
  // 注意：publicDir = 'assets' 会把目录内容复制到站点根（dist/bg/…），
  // 因此 URL 不带 assets/ 前缀（与 vite dev 的 /bg/… 一致）。
  const bg: Record<string, string> = {};
  for (const f of scanDir(join(root, 'assets/bg'), IMG_EXT)) {
    bg[f.slice(0, f.lastIndexOf('.'))] = `bg/${f}`;
  }
  const sprites: Record<string, Record<string, string>> = {};
  try {
    for (const id of readdirSync(join(root, 'assets/sprites')).sort(natSort)) {
      sprites[id] = {};
      for (const f of scanDir(join(root, 'assets/sprites', id), IMG_EXT)) {
        sprites[id]![f.slice(0, f.lastIndexOf('.'))] = `sprites/${id}/${f}`;
      }
    }
  } catch {
    /* 无 sprites 目录 */
  }
  const bgm: Manifest['bgm'] = {};
  for (const f of scanDir(join(root, 'assets/bgm'), AUD_EXT)) {
    const key = f.slice(0, f.lastIndexOf('.'));
    const loop = bgmLoop[key];
    bgm[key] = { url: `bgm/${f}`, ...(loop ? { loopStart: loop[0], loopEnd: loop[1] } : {}) };
  }
  const se: Record<string, string> = {};
  for (const f of scanDir(join(root, 'assets/se'), AUD_EXT)) {
    se[f.slice(0, f.lastIndexOf('.'))] = `se/${f}`;
  }
  const voice: Record<string, string> = {};
  for (const f of scanDir(join(root, 'assets/voice'), AUD_EXT)) {
    voice[f.slice(0, f.lastIndexOf('.'))] = `voice/${f}`;
  }
  return { bg, sprites, bgm, se, voice };
}

export function yanagiGame(root: string): Plugin {
  return {
    name: 'yanagi-game',
    enforce: 'pre',
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED : null;
    },
    load(id) {
      if (id !== RESOLVED) return null;
      const game: GameConfig = JSON.parse(readFileSync(join(root, 'game.json'), 'utf8'));
      const storyDir = join(root, 'story');
      const fileNames = scanStoryDir(storyDir);
      const files = fileNames.map((f) => ({ path: f, text: readFileSync(join(storyDir, f), 'utf8') }));
      for (const f of fileNames) this.addWatchFile(join(storyDir, f));
      this.addWatchFile(join(root, 'game.json'));

      const result = compileStory({ files, characters: game.characters ?? [], entry: game.entry });
      for (const issue of result.issues) {
        if (issue.severity === 'warning') this.warn(formatIssue(issue));
      }
      if (!result.bundle) {
        const first = result.issues.find((i) => i.severity === 'error');
        if (first) {
          this.error({ message: formatIssue(first), id: join(storyDir, first.file) });
        } else {
          this.error('剧本编译失败但没有具体错误信息');
        }
        return null;
      }

      const manifest = scanManifest(root, game.bgmLoop ?? {});
      const missing = checkAssets(result.bundle, manifest);
      if (missing.length > 0) {
        const m = missing[0]!;
        this.error(`${m.message}（${m.file}:${m.line}，请检查 assets/ 目录）`);
        return null;
      }

      const def = {
        id: game.id,
        title: game.title,
        entry: result.bundle.entry,
        characters: game.characters ?? [],
        bundle: result.bundle,
        manifest,
      };
      return `export const game = ${JSON.stringify(def)}\nexport default game\n`;
    },
  };
}

function scanStoryDir(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.yn'))
      .sort(natSort);
  } catch {
    return [];
  }
}

function checkAssets(
  bundle: Bundle,
  manifest: Manifest,
): { message: string; file: string; line: number }[] {
  const problems: { message: string; file: string; line: number }[] = [];
  for (const ref of collectAssetRefs(bundle)) {
    switch (ref.kind) {
      case 'bg':
        if (!manifest.bg[ref.key]) problems.push({ message: `背景 "${ref.key}" 不存在（assets/bg/）`, ...ref });
        break;
      case 'sprite': {
        const emotions = manifest.sprites[ref.key];
        if (!emotions) {
          problems.push({ message: `立绘 "${ref.key}" 不存在（assets/sprites/${ref.key}/）`, ...ref });
        } else if (!emotions[ref.emotion ?? 'normal']) {
          problems.push({
            message: `立绘 "${ref.key}" 缺少差分 "${ref.emotion}"（已有：${Object.keys(emotions).join('、')}）`,
            ...ref,
          });
        }
        break;
      }
      case 'bgm':
        if (!manifest.bgm[ref.key]) problems.push({ message: `BGM "${ref.key}" 不存在（assets/bgm/）`, ...ref });
        break;
      case 'se':
        if (!manifest.se[ref.key] && !manifest.bgm[ref.key]) {
          problems.push({ message: `音效 "${ref.key}" 不存在（assets/se/）`, ...ref });
        }
        break;
      case 'voice':
        if (!manifest.voice[ref.key]) problems.push({ message: `语音 "${ref.key}" 不存在（assets/voice/）`, ...ref });
        break;
    }
  }
  return problems;
}
