import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
// 相对导入：让 Vite 的 config loader 连同插件源码一起打包
// （裸导入 @yanagi/script/vite 会被外部化，Node 原生 ESM 无法加载 .ts 源）
import { yanagiGame } from '../../packages/script/src/vite-plugin';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  publicDir: 'assets',
  base: './',
  build: {
    rollupOptions: {
      output: {
        // pixi v8 的渲染器类存在跨 chunk 循环继承，拆分会挂起 app.init —— 保持单 chunk
        manualChunks(id) {
          if (id.includes('pixi.js') || id.includes('/pixi/') || id.includes('meshekhr')) return 'pixi';
          return undefined;
        },
      },
    },
  },
  plugins: [yanagiGame(root)],
});
