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
    // 변환 점검 모델. 같은 모델은 자기 출력을 관대하게 볼 수 있어 다른 모델을 권장(비우면 변환 모델과 같음)
    checkModel: env.CHECK_MODEL || env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
    thinking: env.GEMINI_THINKING_LEVEL ?? 'low',
    // 응답 지연 기준(호출 1회). 넘으면 실패 경로. 파일럿에서 정한다
    timeoutMs: Number(env.LLM_TIMEOUT_MS || 15000),
    transformPrompt: env.TRANSFORM_PROMPT || 'v4',
    checkPrompt: env.CHECK_PROMPT || 'v1',
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
  const files = {
    study: 'study.json', strings: path.join('ui', 'strings.json'), safety: path.join('safety', 'rules.json'),
    character: path.join('character', 'character.json'), criteria: path.join('coding', 'criteria.json'),
  };
  const out = {};
  const raws = [];
  for (const [k, f] of Object.entries(files)) {
    const { data, raw } = readJson(path.join(contentDir, f));
    out[k] = data;
    raws.push(raw);
  }
  out.character.faces = fs.existsSync(path.join(contentDir, 'character', 'faces'));
  out.hash = sha(raws.join('\n'));
  return out;
}

// 프롬프트: content/prompts/<kind>/<버전>.md (머리말 + 본문). kind = transform | check
export function loadPrompt(contentDir, kind, version) {
  const dir = path.join(contentDir, 'prompts', kind);
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
  const schemaRaw = fs.readFileSync(path.join(dir, meta.schema || 'schema.json'), 'utf8');
  return {
    kind, version, ref: `${kind}@${version}`, body, schema: JSON.parse(schemaRaw),
    temperature: meta.temperature === undefined ? null : Number(meta.temperature), hash: sha(raw + schemaRaw),
  };
}

// 한 번에 치환: 조언 속 {{...}}는 다시 해석하지 않는다
export function renderPrompt(prompt, vars) {
  return prompt.body.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ''));
}
