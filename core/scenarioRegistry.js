'use strict';
const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const { countPlaceholders, sha256hex } = require('./util');

const SCHEMA = require('../schemas/scenario.schema.json');

const stripEnd = (s) => s.trim().replace(/[.!?。"'“”]+$/u, '').trim();

/** 스키마 외 의미 검사: 3턴 순서, 선택지 id 유일, fact_ids 유효, 턴1·2 사실 1~2개, 턴3 모든 reply에 자동적 사고 포함 */
function semanticErrors(sc) {
  const errs = [];
  const turns = sc.dialogue.turns;
  turns.forEach((t, i) => { if (t.turn !== i + 1) errs.push(`turns[${i}].turn must be ${i + 1}`); });
  const ids = new Set();
  for (const t of turns) {
    for (const c of t.choices) {
      if (ids.has(c.id)) errs.push(`duplicate choice id ${c.id}`);
      ids.add(c.id);
      for (const f of c.fact_ids) if (f >= sc.facts.length) errs.push(`choice ${c.id} fact_id ${f} out of range`);
      if (t.turn < 3 && (c.fact_ids.length < 1 || c.fact_ids.length > 2)) errs.push(`choice ${c.id} must expose 1~2 facts`);
      if (t.turn === 3 && !c.reply.includes(stripEnd(sc.automatic_thought))) errs.push(`turn3 choice ${c.id} reply must contain automatic_thought`);
    }
  }
  return errs;
}

function loadScenario(dir, id, validate) {
  const file = path.join(dir, id, 'scenario.json');
  if (!fs.existsSync(file)) return { id, errors: [`missing ${file}`] };
  const raw = fs.readFileSync(file);
  let sc;
  try { sc = JSON.parse(raw); } catch (e) { return { id, errors: [`invalid JSON: ${e.message}`] }; }
  const errors = [];
  if (!validate(sc)) errors.push(...validate.errors.map((e) => `${e.instancePath} ${e.message}`));
  else errors.push(...semanticErrors(sc));
  if (sc.id !== id) errors.push(`id mismatch: folder ${id} vs ${sc.id}`);
  const imagePath = sc.image ? path.join(dir, id, sc.image) : null;
  return { id, scenario: sc, errors, placeholders: countPlaceholders(sc), hash: sha256hex(raw), imagePath: imagePath && fs.existsSync(imagePath) ? imagePath : null };
}

function createScenarioRegistry(contentDir, activeIds) {
  const dir = path.join(contentDir, 'scenarios');
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(SCHEMA);
  const loaded = activeIds.map((id) => loadScenario(dir, id, validate));
  const byId = new Map(loaded.filter((l) => !l.errors.length).map((l) => [l.id, l]));

  const get = (id) => {
    const l = byId.get(id);
    if (!l) throw new Error(`scenario not available: ${id}`);
    return l.scenario;
  };

  return {
    report: loaded.map(({ id, errors, placeholders }) => ({ id, errors, placeholders })),
    ok: loaded.every((l) => !l.errors.length),
    ids: () => activeIds.filter((id) => byId.has(id)),
    has: (id) => byId.has(id),
    get,
    imagePath: (id) => byId.get(id)?.imagePath || null,
    /** 공개 필드만 (§10.3) */
    publicView: (id) => {
      const s = get(id);
      return { id: s.id, name: s.name, summary: s.summary, image_url: byId.get(id).imagePath ? `/api/scenarios/${encodeURIComponent(id)}/image` : null };
    },
    turnOptions: (id, turn) => get(id).dialogue.turns[turn - 1].choices.map((c) => ({ id: c.id, text: c.text })),
    choice: (id, turn, choiceId) => get(id).dialogue.turns[turn - 1]?.choices.find((c) => c.id === choiceId) || null,
    /** LLM 입력 '캐릭터 상황' = summary + automatic_thought (§4) */
    characterSituation: (id) => { const s = get(id); return `${s.summary} "${s.automatic_thought}"`; },
    contentHash: () => sha256hex(loaded.map((l) => `${l.id}:${l.hash || ''}`).join('|')),
    versions: () => activeIds.map((id) => `${id}@${byId.get(id)?.scenario.version || '?'}`).join(','),
  };
}

module.exports = { createScenarioRegistry, semanticErrors };
