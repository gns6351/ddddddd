// E2E용 서버: 가상 콘텐츠(조언 3회) + 모의 AI + 임시 데이터 폴더
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../server/index.js';
import { FIXTURE } from '../helpers.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfapp-e2e-'));
const contentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfapp-e2e-content-'));
fs.cpSync(FIXTURE, contentDir, { recursive: true });
const study = path.join(contentDir, 'study.json');
fs.writeFileSync(study, JSON.stringify({ ...JSON.parse(fs.readFileSync(study, 'utf8')), adviceRounds: 3 }));
createApp({ dataDir, contentDir, llmModeEnv: 'mock', apiKey: '', adminToken: '', accessCode: '' })
  .listen(3500, '127.0.0.1', () => console.log('e2e server 3500', dataDir));
