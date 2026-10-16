// 서버 실행: npm start
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './index.js';

const app = createApp();
const { settings } = app.locals.study;
// PORT를 직접 적지 않았으면 막힌 포트(윈도우 예약 등)를 피해 차례로 시도
const candidates = settings.portExplicit ? [settings.port] : [3000, 8080, 5050, 8000, 4321, 7777, 9090];

function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
}

function ready(port) {
  const line = '-'.repeat(60);
  console.log(line);
  console.log(` 참가자 화면:   http://localhost:${port}`);
  console.log(` 연구자 화면:   http://localhost:${port}/admin`);
  if (settings.host === '0.0.0.0') for (const ip of lanAddresses()) console.log(` 같은 와이파이: http://${ip}:${port}`);
  console.log(line);
  console.log(` AI: ${settings.llmMode === 'live' ? `실제 호출 (${settings.model}, thinking=${settings.thinking || '기본'})` : '모의(mock) — .env에 GEMINI_API_KEY를 넣으면 실제 호출'}`);
  console.log(` 데이터 폴더: ${path.join(settings.dataDir, 'sessions')}`);
  if (!settings.adminToken) console.log(' 연구자 화면은 이 PC에서만 열려요. 다른 PC에서도 보려면 .env에 ADMIN_TOKEN을 정하세요.');
  console.log(' 인터넷으로 참가자 링크를 주려면 새 창에서: npm run tunnel');
  console.log(' 이 창을 닫으면 서버가 꺼집니다.');
  try {
    fs.mkdirSync(settings.dataDir, { recursive: true });
    fs.writeFileSync(path.join(settings.dataDir, '.port'), String(port));
  } catch { /* 기록 못 해도 서버는 동작 */ }
}

function listen(i) {
  const port = candidates[i];
  const server = app.listen(port, settings.host, () => ready(port));
  server.once('error', (err) => {
    if ((err.code === 'EACCES' || err.code === 'EADDRINUSE') && i + 1 < candidates.length) {
      console.log(`※ ${port}번 포트를 쓸 수 없어 ${candidates[i + 1]}번으로 다시 시도해요.`);
      return listen(i + 1);
    }
    console.error(`※ 서버를 켜지 못했어요 (${err.code || err.message}). .env의 PORT를 다른 번호로 바꿔 보세요.`);
    process.exit(1);
  });
}

listen(0);
