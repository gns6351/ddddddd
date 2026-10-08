// 참가자용 인터넷 링크 만들기 (Cloudflare 빠른 터널). 서버를 켠 뒤 다른 창에서: npm run tunnel
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadSettings } from '../server/config.js';

const settings = loadSettings();
let port = settings.port;
try { port = Number(fs.readFileSync(path.join(settings.dataDir, '.port'), 'utf8')) || port; } catch { /* 기본값 */ }

try {
  const res = await fetch(`http://127.0.0.1:${port}/api/config`);
  if (!res.ok) throw new Error(String(res.status));
} catch {
  console.error(`※ http://localhost:${port} 에서 서버를 찾지 못했어요. 먼저 다른 창에서 npm start 로 서버를 켜 주세요.`);
  process.exit(1);
}

console.log(`인터넷 링크를 만드는 중이에요 (서버 포트 ${port})…`);
const child = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
let shown = false;

function scan(chunk) {
  const m = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (!m || shown) return;
  shown = true;
  const code = settings.accessCode ? `&code=${encodeURIComponent(settings.accessCode)}` : '';
  console.log('');
  console.log('='.repeat(62));
  console.log(` 참가자 링크:  ${m[0]}/?pid=참가자ID${code}`);
  console.log(`   예) ${m[0]}/?pid=P01${code}`);
  console.log('='.repeat(62));
  console.log(' · 이 창과 서버 창을 모두 켜 둬야 링크가 살아 있어요. 다시 실행하면 주소가 바뀝니다.');
  console.log(` · 연구자 화면은 이 PC에서 http://localhost:${port}/admin`);
  if (!settings.accessCode) console.log(' ※ .env에 ACCESS_CODE가 없어 링크를 아는 누구나 시작할 수 있어요.');
}
child.stdout.on('data', scan);
child.stderr.on('data', scan);
child.on('error', (err) => {
  if (err.code === 'ENOENT') {
    console.error('※ cloudflared가 없어요. 윈도우: winget install --id Cloudflare.cloudflared  /  맥: brew install cloudflared');
    console.error('  설치 후 창을 새로 열고 다시 실행하세요.');
  } else console.error('※ 터널을 시작하지 못했어요:', err.message);
  process.exit(1);
});
child.on('exit', (code) => {
  console.log(`터널이 종료됐어요 (코드 ${code}).`);
  process.exit(code ?? 0);
});
