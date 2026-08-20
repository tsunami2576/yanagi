import game from 'virtual:yanagi-game';
import { GameSession, openIdbStorage } from '@yanagi/runtime';
import '@yanagi/ui/styles.css';

const root = document.getElementById('app');
if (!root) throw new Error('缺少 #app 挂载点');

const storage = await openIdbStorage('yanagi-demo');
if (storage.degraded) {
  console.warn('[yanagi] IndexedDB 不可用（私密模式？），进度将不会保留');
}

const session = new GameSession(game, { root, storage });
await session.start();
