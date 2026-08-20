/**
 * canary demo 占位资产生成器（确定性，无随机）。
 * 背景/立绘 = SVG；BGM/SE/语音 = 程序合成 WAV（22050Hz 单声道 16bit）。
 * 用法：node tools/gen-assets.mjs（在 games/demo 目录下）
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RATE = 22050;

// ---------- WAV ----------
function writeWav(path, samples) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(RATE, 24);
  buf.writeUInt32LE(RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  writeFileSync(path, buf);
}

const seconds = (s) => Math.round(s * RATE);

/** 和弦琶音 BGM：慢起音 + 颤音，8 秒正好一个乐句循环。 */
function bgm(freqs, patternSec = 8, gain = 0.32) {
  const n = seconds(patternSec);
  const out = new Float64Array(n);
  const beat = 1.0;
  freqs.forEach((base, li) => {
    for (let i = 0; i < n; i++) {
      const t = i / RATE;
      const pos = t % beat;
      const noteIdx = Math.floor(t / beat) % 4;
      const semis = [0, 4, 7, 12][noteIdx];
      const f = base * Math.pow(2, semis / 12);
      const env = Math.exp(-pos * 2.2) * 0.5 + 0.5;
      const attack = Math.min(1, t / 0.8);
      const vib = 1 + 0.004 * Math.sin(2 * Math.PI * 0.6 * t);
      out[i] += gain * env * attack * Math.sin(2 * Math.PI * f * vib * t) / freqs.length;
    }
  });
  return out;
}

/** 语音占位：三个音的短句。 */
function voiceTone(base) {
  const dur = 0.5;
  const n = seconds(dur);
  const out = new Float64Array(n);
  const notes = [0, 2, 4];
  const seg = Math.floor(n / 3);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    const k = Math.min(2, Math.floor(i / seg));
    const f = base * Math.pow(2, notes[k] / 12);
    const localT = (i - k * seg) / RATE;
    const env = Math.min(1, localT / 0.03) * Math.exp(-localT * 3.2);
    out[i] = 0.5 * env * Math.sin(2 * Math.PI * f * t);
  }
  return out;
}

/** 敲门：两次中频噪声爆发。 */
function knock() {
  const dur = 0.8;
  const n = seconds(dur);
  const out = new Float64Array(n);
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x3fffffff) - 1;
  };
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    for (const start of [0.02, 0.38]) {
      const dt = t - start;
      if (dt >= 0 && dt < 0.12) {
        out[i] += 0.5 * Math.exp(-dt * 28) * (rand() * 0.6 + Math.sin(2 * Math.PI * 170 * t) * 0.8);
      }
    }
  }
  return out;
}

/** 铃声：高频衰减正弦。 */
function bell() {
  const dur = 1.4;
  const n = seconds(dur);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / RATE;
    out[i] =
      0.4 * Math.exp(-t * 2.6) * Math.sin(2 * Math.PI * 1568 * t) +
      0.15 * Math.exp(-t * 4) * Math.sin(2 * Math.PI * 2349 * t);
  }
  return out;
}

// ---------- SVG ----------
const svgHead = (w, h) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`;

function bgClassroom() {
  return `${svgHead(1600, 900)}
  <defs>
    <linearGradient id="wall" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#d8cdb4"/><stop offset="1" stop-color="#b8ad93"/>
    </linearGradient>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffd9a0"/><stop offset="1" stop-color="#ffefcf"/>
    </linearGradient>
    <linearGradient id="floor" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#9d7b57"/><stop offset="1" stop-color="#6f5540"/>
    </linearGradient>
  </defs>
  <rect width="1600" height="900" fill="url(#wall)"/>
  <rect x="180" y="120" width="420" height="380" rx="8" fill="url(#sky)" stroke="#7a6a50" stroke-width="10"/>
  <rect x="980" y="120" width="420" height="380" rx="8" fill="url(#sky)" stroke="#7a6a50" stroke-width="10"/>
  <line x1="390" y1="120" x2="390" y2="500" stroke="#7a6a50" stroke-width="8"/>
  <line x1="180" y1="310" x2="600" y2="310" stroke="#7a6a50" stroke-width="8"/>
  <line x1="1190" y1="120" x2="1190" y2="500" stroke="#7a6a50" stroke-width="8"/>
  <line x1="980" y1="310" x2="1400" y2="310" stroke="#7a6a50" stroke-width="8"/>
  <rect x="640" y="90" width="300" height="420" rx="6" fill="#8e98a8" opacity="0.35"/>
  <rect y="620" width="1600" height="280" fill="url(#floor)"/>
  <g stroke="#5a4433" stroke-width="4" opacity="0.5">
    <line x1="0" y1="700" x2="1600" y2="700"/><line x1="0" y1="780" x2="1600" y2="780"/><line x1="0" y1="860" x2="1600" y2="860"/>
  </g>
  <rect x="120" y="470" width="480" height="120" rx="8" fill="#c9b48c" stroke="#7a6a50" stroke-width="6"/>
  <rect x="1000" y="470" width="480" height="120" rx="8" fill="#c9b48c" stroke="#7a6a50" stroke-width="6"/>
  <rect x="140" y="560" width="60" height="240" fill="#7a6a50"/>
  <rect x="1020" y="560" width="60" height="240" fill="#7a6a50"/>
  <rect x="520" y="560" width="60" height="240" fill="#7a6a50"/>
  <rect x="1400" y="560" width="60" height="240" fill="#7a6a50"/>
  <circle cx="1360" cy="180" r="60" fill="#fff3d6" opacity="0.85"/>
</svg>`;
}

function bgHallway() {
  return `${svgHead(1600, 900)}
  <defs>
    <linearGradient id="hw" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#cfd6de"/><stop offset="1" stop-color="#9aa4b0"/>
    </linearGradient>
  </defs>
  <rect width="1600" height="900" fill="url(#hw)"/>
  <rect x="560" y="260" width="480" height="380" fill="#e8eef4" stroke="#6d7783" stroke-width="8"/>
  <rect x="600" y="300" width="400" height="300" fill="#bfe0f0"/>
  <rect x="770" y="300" width="60" height="300" fill="#8fb8d0"/>
  <rect x="600" y="420" width="400" height="30" fill="#8fb8d0"/>
  <g>
    <rect x="0" y="120" width="560" height="560" fill="#7c8794" transform="skewY(12)"/>
    <rect x="1040" y="640" width="560" height="560" fill="#7c8794" transform="skewY(-12)"/>
  </g>
  <g fill="#5d6873">
    <rect x="120" y="300" width="120" height="200" rx="4"/>
    <rect x="1360" y="300" width="120" height="200" rx="4"/>
  </g>
  <rect y="620" width="1600" height="280" fill="#8b939e"/>
  <g stroke="#707a86" stroke-width="3" opacity="0.6">
    <line x1="0" y1="700" x2="1600" y2="700"/><line x1="0" y1="790" x2="1600" y2="790"/><line x1="0" y1="870" x2="1600" y2="870"/>
  </g>
</svg>`;
}

function bgSunset() {
  return `${svgHead(1600, 900)}
  <defs>
    <linearGradient id="sky2" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3d3a6e"/><stop offset="0.45" stop-color="#e8734f"/>
      <stop offset="0.75" stop-color="#ffb35c"/><stop offset="1" stop-color="#ffd98e"/>
    </linearGradient>
  </defs>
  <rect width="1600" height="900" fill="url(#sky2)"/>
  <circle cx="800" cy="520" r="150" fill="#fff0c8" opacity="0.95"/>
  <circle cx="800" cy="520" r="210" fill="#ffd98e" opacity="0.35"/>
  <g fill="#2e2a45">
    <rect x="0" y="640" width="1600" height="260"/>
    <rect x="120" y="520" width="90" height="140"/>
    <rect x="260" y="560" width="70" height="100"/>
    <rect x="1380" y="500" width="100" height="160"/>
    <rect x="1240" y="580" width="80" height="80"/>
  </g>
  <g stroke="#c95f3f" stroke-width="10" stroke-linecap="round" opacity="0.85">
    <line x1="150" y1="640" x2="150" y2="470"/>
    <path d="M60 500 Q150 430 240 500" fill="none"/>
  </g>
  <g fill="#ffffff" opacity="0.5">
    <circle cx="300" cy="200" r="2.5"/><circle cx="520" cy="120" r="2"/><circle cx="1100" cy="180" r="2.5"/>
    <circle cx="1320" cy="260" r="2"/><circle cx="900" cy="90" r="2"/>
  </g>
</svg>`;
}

/** 简易二次元风半身立绘（几何构成，占位用）。emotion 决定眉眼与红晕。 */
function sprite({ hair, hairDark, eye, uniform, uniformDark, emotion }) {
  const eyes = {
    normal: `<circle cx="255" cy="300" r="14" fill="#3a3f52"/><circle cx="345" cy="300" r="14" fill="#3a3f52"/>
             <circle cx="260" cy="295" r="4" fill="#fff"/><circle cx="350" cy="295" r="4" fill="#fff"/>`,
    smile: `<path d="M238 302 Q255 286 272 302" stroke="#3a3f52" stroke-width="7" fill="none" stroke-linecap="round"/>
            <path d="M328 302 Q345 286 362 302" stroke="#3a3f52" stroke-width="7" fill="none" stroke-linecap="round"/>`,
    shy: `<path d="M240 304 L270 296" stroke="#3a3f52" stroke-width="7" stroke-linecap="round"/>
          <path d="M330 296 L360 304" stroke="#3a3f52" stroke-width="7" stroke-linecap="round"/>
          <ellipse cx="225" cy="345" rx="26" ry="13" fill="#f3a1ab" opacity="0.75"/>
          <ellipse cx="375" cy="345" rx="26" ry="13" fill="#f3a1ab" opacity="0.75"/>`,
    lonely: `<path d="M238 300 Q255 310 272 300" stroke="#3a3f52" stroke-width="7" fill="none" stroke-linecap="round"/>
             <path d="M328 300 Q345 310 362 300" stroke="#3a3f52" stroke-width="7" fill="none" stroke-linecap="round"/>
             <path d="M255 330 q4 16 0 24" stroke="#7db3d8" stroke-width="4" fill="none" stroke-linecap="round"/>`,
  }[emotion] ?? '';
  const mouth = {
    normal: `<path d="M288 358 Q300 366 312 358" stroke="#b06a6a" stroke-width="5" fill="none" stroke-linecap="round"/>`,
    smile: `<path d="M282 354 Q300 372 318 354" stroke="#b06a6a" stroke-width="5" fill="none" stroke-linecap="round"/>`,
    shy: `<circle cx="300" cy="360" r="6" fill="#b06a6a"/>`,
    lonely: `<path d="M290 362 Q300 356 310 362" stroke="#b06a6a" stroke-width="5" fill="none" stroke-linecap="round"/>`,
  }[emotion] ?? '';
  return `${svgHead(600, 900)}
  <defs>
    <linearGradient id="hairG" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${hair}"/><stop offset="1" stop-color="${hairDark}"/>
    </linearGradient>
    <linearGradient id="uni" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${uniform}"/><stop offset="1" stop-color="${uniformDark}"/>
    </linearGradient>
  </defs>
  <g>
    <path d="M300 470 C160 470 90 560 70 900 L530 900 C510 560 440 470 300 470 Z" fill="url(#uni)"/>
    <path d="M300 470 L215 900 L385 900 Z" fill="#f6f2ec" opacity="0.92"/>
    <path d="M170 560 L140 900 L90 900 C100 700 130 590 170 560 Z" fill="${hairDark}"/>
    <path d="M430 560 L460 900 L510 900 C500 700 470 590 430 560 Z" fill="${hairDark}"/>
    <path d="M300 470 C160 470 90 560 70 900 L530 900 C510 560 440 470 300 470 Z" fill="none" stroke="${uniformDark}" stroke-width="4" opacity="0.5"/>
    <ellipse cx="300" cy="300" rx="150" ry="165" fill="#ffe4cf"/>
    <path d="M150 290 C150 150 210 110 300 110 C390 110 450 150 450 290 C450 240 420 200 400 195 C370 230 230 230 200 195 C180 200 150 240 150 290 Z" fill="url(#hairG)"/>
    <path d="M150 285 C140 420 120 520 90 600 C110 470 130 380 150 285 Z" fill="url(#hairG)"/>
    <path d="M450 285 C460 420 480 520 510 600 C490 470 470 380 450 285 Z" fill="url(#hairG)"/>
    <ellipse cx="300" cy="205" rx="90" ry="40" fill="${hair}" opacity="0.9"/>
    <g>${eyes}</g>
    <path d="M262 262 Q255 252 248 260" stroke="#5a4a3a" stroke-width="5" fill="none" stroke-linecap="round"/>
    <path d="M338 262 Q345 252 352 260" stroke="#5a4a3a" stroke-width="5" fill="none" stroke-linecap="round"/>
    ${mouth}
    <ellipse cx="300" cy="128" rx="12" ry="8" fill="${hair}" opacity="0.95"/>
  </g>
</svg>`;
}

// ---------- 输出 ----------
const dirs = {
  bg: join(ROOT, 'assets/bg'),
  sprites: join(ROOT, 'assets/sprites'),
  bgm: join(ROOT, 'assets/bgm'),
  se: join(ROOT, 'assets/se'),
  voice: join(ROOT, 'assets/voice'),
};
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });

writeFileSync(join(dirs.bg, 'classroom_afternoon.svg'), bgClassroom());
writeFileSync(join(dirs.bg, 'hallway.svg'), bgHallway());
writeFileSync(join(dirs.bg, 'sunset.svg'), bgSunset());

const yui = { hair: '#7c6cae', hairDark: '#5a4a86', eye: '#8a2f4a', uniform: '#4a5568', uniformDark: '#2f3746' };
const nao = { hair: '#3f4c5c', hairDark: '#2b3440', eye: '#7aa2c4', uniform: '#5d6b7d', uniformDark: '#3d4855' };
mkdirSync(join(dirs.sprites, 'yui'), { recursive: true });
for (const emotion of ['normal', 'shy', 'smile', 'lonely']) {
  writeFileSync(join(dirs.sprites, 'yui', `${emotion}.svg`), sprite({ ...yui, emotion }));
}
mkdirSync(join(dirs.sprites, 'nao'), { recursive: true });
writeFileSync(join(dirs.sprites, 'nao', 'normal.svg'), sprite({ ...nao, emotion: 'normal' }));

writeWav(join(dirs.bgm, 'theme_main.wav'), bgm([220, 277.18, 329.63]));
writeWav(join(dirs.bgm, 'theme_soft.wav'), bgm([174.61, 220, 261.63], 8, 0.26));
writeWav(join(dirs.se, 'door.wav'), knock());
writeWav(join(dirs.se, 'bell.wav'), bell());

for (let i = 101; i <= 107; i++) {
  writeWav(join(dirs.voice, `yui_0${i}.wav`), voiceTone(494));
}
for (let i = 101; i <= 104; i++) {
  writeWav(join(dirs.voice, `nao_0${i}.wav`), voiceTone(330));
}

console.log('占位资产已生成 →', join(ROOT, 'assets'));
