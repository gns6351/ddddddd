'use strict';
const fs = require('fs');
const path = require('path');
const { sha256hex, countPlaceholders, PLACEHOLDER } = require('./util');

/** 동결 범위 (§6 고정, §10.1 동결): frozen.lock 자체는 제외 */
const LOCK_SCOPE = ['content', 'schemas', 'public', 'routes', 'core', 'db', 'tools', 'config', 'server.js', 'app.js', 'package.json', 'package-lock.json'];
const LOCK_FILE = 'frozen.lock';
const APPROVALS = ['irb_decision', 'consent_forms_participation_transfer_recording', 'age_19_eligibility_procedure', 'llm_provider_country_retention_terms', 'safety_manual_contacts_drill', 'researcher_training', 'pretest_manual_review'];

function pretestGate(ctx) {
  const ver = ctx.config.experiment.prompts.transform;
  const f = path.join(ctx.config.storageRoot, 'stats', `pretest_${ver}_summary.json`);
  if (!fs.existsSync(f)) return ['pretest summary missing'];
  let s;
  try { s = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return ['pretest summary unreadable']; }
  const errs = [];
  if (s.prompt_hash !== ctx.transformPrompt.hash) errs.push('pretest prompt_hash mismatch (프롬프트 변경 후 재점검 필요)');
  if (s.model !== ctx.config.experiment.model) errs.push('pretest model mismatch');
  for (const [k, v] of Object.entries(s.gate_auto || {})) if (v !== true) errs.push(`pretest gate failed: ${k}`);
  if (!s.gate_auto) errs.push('pretest gate missing');
  return errs;
}

function listFiles(root, rel) {
  const p = path.join(root, rel);
  if (!fs.existsSync(p)) return [];
  if (fs.statSync(p).isFile()) return [rel];
  return fs.readdirSync(p, { withFileTypes: true }).flatMap((e) => {
    const r = path.join(rel, e.name);
    return e.isDirectory() ? listFiles(root, r) : e.isFile() ? [r] : [];
  });
}

function computeManifest(root) {
  const files = {};
  for (const rel of LOCK_SCOPE.flatMap((s) => listFiles(root, s)).sort()) {
    if (path.basename(rel) === LOCK_FILE) continue;
    files[rel.split(path.sep).join('/')] = sha256hex(fs.readFileSync(path.join(root, rel)));
  }
  return files;
}

function writeLock(root, meta = {}) {
  const files = computeManifest(root);
  const lock = { created_at: new Date().toISOString(), ...meta, files };
  fs.writeFileSync(path.join(root, LOCK_FILE), JSON.stringify(lock, null, 2) + '\n');
  return lock;
}

/** @returns {string[]} 불일치 목록 (빈 배열이면 통과) */
function verifyLock(root) {
  const p = path.join(root, LOCK_FILE);
  if (!fs.existsSync(p)) return ['frozen.lock missing'];
  const lock = JSON.parse(fs.readFileSync(p, 'utf8'));
  const cur = computeManifest(root);
  const errs = [];
  for (const [f, h] of Object.entries(lock.files || {})) {
    if (!(f in cur)) errs.push(`missing: ${f}`);
    else if (cur[f] !== h) errs.push(`changed: ${f}`);
  }
  for (const f of Object.keys(cur)) if (!(f in (lock.files || {}))) errs.push(`added: ${f}`);
  return errs;
}

/**
 * 콘텐츠·운영 게이트 (§10.1): 자리표시자 0, 시나리오 유효, 규칙 패턴 존재, 모델·동의서 버전 확정, 실제 provider.
 * 기관 승인·파일럿 등 시스템 밖 항목은 판정하지 않는다(T45: pretest 통과로 대신할 수 없음).
 */
function contentGate(ctx) {
  const errs = [];
  const exp = ctx.config.experiment;
  for (const r of ctx.scenarios.report) {
    for (const e of r.errors) errs.push(`scenario ${r.id}: ${e}`);
    if (r.placeholders) errs.push(`scenario ${r.id}: ${r.placeholders} placeholders`);
  }
  const sp = countPlaceholders(ctx.strings);
  if (sp) errs.push(`ui strings: ${sp} placeholders`);
  for (const k of ['model', 'model_checked_at', 'consent_version', 'analysis_plan_version']) {
    if (!exp[k] || PLACEHOLDER.test(String(exp[k]))) errs.push(`config.${k} not confirmed`);
  }
  if (PLACEHOLDER.test(JSON.stringify(exp.safety || {}))) errs.push('config.safety.responder_id not confirmed');
  if (ctx.rules.empty || PLACEHOLDER.test(String(ctx.rules.version))) errs.push('safety rules empty or unversioned');
  if (ctx.transformPrompt.errors.length) errs.push(...ctx.transformPrompt.errors.map((e) => `prompt: ${e}`));
  if (ctx.config.llmProvider !== 'gemini') errs.push(`llm provider must be gemini (got ${ctx.config.llmProvider})`);
  // 동의/운영 승인 체크리스트(A07, T45): 시스템이 대신 판정하지 않고 승인 근거 기록 여부만 확인
  const ap = exp.approvals || {};
  for (const k of APPROVALS) if (!ap[k] || PLACEHOLDER.test(String(ap[k]))) errs.push(`approval missing: ${k}`);
  // 사전 점검 게이트(§10.1, §10.10): 현재 프롬프트·모델로 실행한 자동 지표 합격 (pretest 통과가 승인을 대신하지 않음)
  errs.push(...pretestGate(ctx));
  return errs;
}

module.exports = { computeManifest, writeLock, verifyLock, contentGate, pretestGate, LOCK_SCOPE, LOCK_FILE, APPROVALS };
