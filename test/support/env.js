'use strict';
/* 테스트 환경: 임시 폴더에 [실제 프롬프트·UI 문구] + [가상 시나리오·가상 안전 규칙]을 조합 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const FIX = path.join(ROOT, 'test', 'fixtures');

function makeEnv(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crsa-'));
  const content = path.join(root, 'content');
  fs.cpSync(path.join(ROOT, 'content', 'prompts'), path.join(content, 'prompts'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'content', 'ui'), path.join(content, 'ui'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'content', 'rulebased'), path.join(content, 'rulebased'), { recursive: true });
  fs.cpSync(path.join(FIX, 'content', 'scenarios'), path.join(content, 'scenarios'), { recursive: true });
  fs.cpSync(path.join(FIX, 'content', 'safety'), path.join(content, 'safety'), { recursive: true });
  const exp = { ...JSON.parse(fs.readFileSync(path.join(FIX, 'experiment.json'), 'utf8')), ...overrides };
  const configPath = path.join(root, 'experiment.json');
  fs.writeFileSync(configPath, JSON.stringify(exp, null, 2));
  return {
    root,
    opts: { configPath, contentDir: content, dataDir: path.join(root, 'data'), storageRoot: root, port: 0, llmProvider: 'mock' },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

const hex64 = () => crypto.randomBytes(32).toString('hex');
const rid = () => crypto.randomUUID();

module.exports = { makeEnv, hex64, rid, ROOT };
