// E2E용 서버: 가상 콘텐츠 + 모의 AI + 임시 데이터 폴더
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../server/index.js';
import { FIXTURE } from '../helpers.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfapp-e2e-'));
createApp({ dataDir, contentDir: FIXTURE, llmModeEnv: 'mock', apiKey: '', adminToken: '', accessCode: '' })
  .listen(3500, '127.0.0.1', () => console.log('e2e server 3500', dataDir));
