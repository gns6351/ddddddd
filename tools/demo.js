#!/usr/bin/env node
'use strict';
/**
 * 데모 서버 (외부 테스트 공유용, 실험 아님)
 *   node tools/demo.js [--port 3300] [--local] [--reset]
 * - 0.0.0.0에 바인딩해 같은 네트워크의 다른 기기가 http://<이 컴퓨터 IP>:<port> 로 접속
 * - 인터넷 공유는 터널 사용: cloudflared tunnel --url http://localhost:<port>  (https 주소 발급)
 * - 데이터는 demo-data/ 에만 저장(연구 DB·export·coding과 분리), LLM은 Mock 고정
 * - 현재 content/ 초안(시나리오·문구·안전 규칙)을 그대로 사용
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ROOT } = require('../core/config');
const { start } = require('../server');

function arg(k, d) { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; }

async function main() {
  const demoRoot = path.join(ROOT, 'demo-data');
  if (process.argv.includes('--reset')) fs.rmSync(demoRoot, { recursive: true, force: true });
  fs.mkdirSync(demoRoot, { recursive: true });
  const port = Number(arg('--port', process.env.PORT || 3300));
  const host = process.argv.includes('--local') ? '127.0.0.1' : '0.0.0.0';
  const { ctx } = await start({ demo: true, host, port, llmProvider: 'mock', dataDir: path.join(demoRoot, 'data'), storageRoot: demoRoot, noEnv: true });
  const ips = Object.values(os.networkInterfaces()).flat().filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address);
  console.log('\n[데모 모드] 실제 연구 아님 — 실명·개인정보·실제 고민 입력 금지, 변환 문장은 Mock');
  console.log(`  이 컴퓨터:        http://localhost:${port}`);
  if (host === '0.0.0.0') for (const ip of ips) console.log(`  같은 네트워크:    http://${ip}:${port}`);
  console.log(`  인터넷 공유(선택): cloudflared tunnel --url http://localhost:${port}`);
  console.log(`  데이터 폴더:      ${demoRoot}  (초기화: node tools/demo.js --reset)`);
  console.log('  Mock 경로 시험:   조언 끝에 #notadvice #unsafe #blaming #badjson #latchbad #timeout 를 붙이면 해당 경로로 진행\n');
  const stop = () => { ctx.db.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
