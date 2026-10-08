// 설정(.env)과 연구 콘텐츠(content/) 읽기
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* .env가 없으면 기본값 */ }

const env = process.env;
const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);

export function loadSettings(overrides = {}) {
  const s = {
    port: Number(env.PORT || 3000),
    portExplicit: !!env.PORT,
    host: env.HOST || '0.0.0.0',
    dataDir: path.resolve(ROOT, env.DATA_DIR || 'data'),
    contentDir: path.resolve(ROOT, env.CONTENT_DIR || 'content'),
    apiKey: env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '',
    provider: 'gemini',
    model: env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
    thinking: env.GEMINI_THINKING_LEVEL ?? 'low',
    timeoutMs: Number(env.LLM_TIMEOUT_MS || 10000), // 명세: try당 10초, 최대 2회
    transformPrompt: env.TRANSFORM_PROMPT || 'v2',
    // 새 세션에 붙는 단계 표시. 파일럿 자료는 본 분석에서 뺀다(대시보드에서 세션별로 바꿀 수 있음)
    phase: oneOf(env.STUDY_PHASE, ['pilot', 'main'], 'pilot'),
    // 연구자 화면 비밀번호. 비워 두면 서버 PC(localhost)에서만 비밀번호 없이 열림
    adminToken: env.ADMIN_TOKEN || '',
    // 외부 링크로 참가자를 받을 때 입장 코드(?code=). 비우면 누구나 시작 가능
    accessCode: env.ACCESS_CODE || '',
    llmModeEnv: oneOf(env.LLM_MODE, ['live', 'mock'], ''),
    ...overrides,
  };
  s.llmMode = s.llmModeEnv === 'live' || (s.llmModeEnv !== 'mock' && s.apiKey) ? 'live' : 'mock';
  return s;
}

export const sha = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);

function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return { data: JSON.parse(raw), raw };
}

// 매 요청마다 읽는다. 파일럿 중 문구를 고치면 재시작 없이 반영되고, 세션에는 그 시점의 해시가 남는다.
export function loadContent(contentDir) {
  const study = readJson(path.join(contentDir, 'study.json'));
  const strings = readJson(path.join(contentDir, 'ui', 'strings.json'));
  const safety = readJson(path.join(contentDir, 'safety', 'rules.json'));
  const scenarios = study.data.scenarios.map((id) => readJson(path.join(contentDir, 'scenarios', id, 'scenario.json')));
  const hash = sha([study.raw, strings.raw, safety.raw, ...scenarios.map((x) => x.raw)].join('\n'));
  return {
    study: study.data,
    strings: strings.data,
    safety: safety.data,
    scenarios: scenarios.map((x) => x.data),
    scenario: (id) => scenarios.map((x) => x.data).find((x) => x.id === id) || null,
    hash,
  };
}

// 프롬프트: content/prompts/transform/<버전>.md (머리말 + 본문)
export function loadPrompt(contentDir, version) {
  const dir = path.join(contentDir, 'prompts', 'transform');
  const raw = fs.readFileSync(path.join(dir, `${version}.md`), 'utf8');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  const meta = {};
  let body = raw;
  if (m) {
    body = m[2];
    for (const line of m[1].split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  const schema = JSON.parse(fs.readFileSync(path.join(dir, meta.output_schema || 'schema.json'), 'utf8'));
  const examples = JSON.parse(fs.readFileSync(path.join(dir, meta.examples || 'examples.json'), 'utf8'));
  return { ref: `transform@${version}`, version, body, schema, examples, thinking: meta.thinking || null, temperature: meta.temperature === undefined ? null : Number(meta.temperature), hash: sha(raw + JSON.stringify(schema) + JSON.stringify(examples)) };
}

// 한 번에 치환: 조언 속 {{...}}는 다시 해석하지 않는다
export function renderPrompt(prompt, vars) {
  const examples = prompt.examples.map((e) => JSON.stringify(e)).join('\n');
  return prompt.body.replace(/\{\{(\w+)\}\}/g, (_, k) => (k === 'examples' ? examples : String(vars[k] ?? '')));
}
