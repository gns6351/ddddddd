'use strict';
const fs = require('fs');
const path = require('path');
const { sha256hex, countPlaceholders, PLACEHOLDER } = require('./util');

/** 동결 범위 (§6 고정, §10.1 동결): frozen.lock 자체는 제외 */
const LOCK_SCOPE = ['content', 'schemas', 'public', 'routes', 'core', 'db', 'tools', 'config', 'server.js', 'app.js', 'package.json', 'package-lock.json'];
const LOCK_FILE = 'frozen.lock';

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
  return errs;
}

module.exports = { computeManifest, writeLock, verifyLock, contentGate, LOCK_SCOPE, LOCK_FILE };
