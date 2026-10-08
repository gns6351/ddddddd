// 연구자용 내보내기: 한 사람당 한 행 CSV
import { LIKERT, finalAttempt } from './flow.js';

const minutes = (a, b) => (a && b ? ((new Date(b) - new Date(a)) / 60000).toFixed(1) : '');
const val = (v) => (v == null ? '' : v);

export function flattenSession(s) {
  const fa = finalAttempt(s);
  const first = s.advice.attempts[0];
  const lastCall = fa?.calls?.at(-1);
  const row = {
    session_id: s.id,
    participant_id: s.participantId,
    created_at: s.createdAt,
    finished_at: val(s.finishedAt),
    stage: s.stage,
    end_type: val(s.endType),
    withdrawn_at_stage: val(s.withdrawnAt),
    llm_mode: s.llmMode,
    model: s.model,
    response_model: val(lastCall?.responseModel),
    prompt: `${s.prompt.ref}@${s.prompt.hash}`,
    study_version: s.studyVersion,
    content_hash: s.contentHash,
    checked_characters: s.pick.checks.map((k) => `${k.characterId}:${k.hasExperience ? 'yes' : 'no'}`).join(';'),
    character_id: val(s.pick.characterId),
    relevance: val(s.pick.relevance),
    dialogue_choices: s.dialogue.map((d) => d.choiceId).join(';'),
    advice_attempts: s.advice.attempts.length,
    advice_1: val(first?.text),
    outcome_1: val(first?.outcome),
    advice_final: val(fa?.text),
    outcome: val(s.advice.outcome),
    outcome_source: val(fa?.source),
    rule_hits: (fa?.ruleHits || []).join(';'),
    advice_type: val(fa?.result?.type),
    core: (fa?.result?.core || []).join(' | '),
    self: val(fa?.result?.self),
    llm_calls: s.advice.attempts.reduce((a, x) => a + (x.calls?.length || 0), 0),
    llm_errors: s.advice.attempts.reduce((a, x) => a + (x.calls || []).filter((c) => !c.valid).length, 0),
    llm_latency_ms: val(lastCall?.latencyMs),
    situation: val(s.reflectPre?.situation),
    emotion: val(s.reflectPre?.emotion),
    automatic_thought: val(s.reflectPre?.automatic_thought),
    belief_pre: val(s.reflectPre?.belief_pre),
    view_pre: val(s.reflectPre?.view_pre),
    fidelity: val(s.returned?.fidelity),
    edited_self: val(s.returned?.edited_self),
    final_self: val(s.returned?.final_self),
    evidence_for: val(s.evidence?.evidence_for),
    for_none: val(s.evidence?.for_none),
    evidence_against: val(s.evidence?.evidence_against),
    against_none: val(s.evidence?.against_none),
    common: val(s.judge?.common),
    common_none: val(s.judge?.common_none),
    difference: val(s.judge?.difference),
    difference_none: val(s.judge?.difference_none),
    verdict: val(s.judge?.verdict),
    reason: val(s.judge?.reason),
    modified_text: val(s.judge?.modified_text),
    view_post: val(s.reflectPost?.view_post),
    belief_post: val(s.reflectPost?.belief_post),
    belief_change: s.reflectPre && s.reflectPost ? s.reflectPost.belief_post - s.reflectPre.belief_pre : '',
  };
  for (const q of LIKERT) row[q] = s.survey ? (s.survey.shown_items.includes(q) ? s.survey[q] : 'NA') : '';
  Object.assign(row, {
    safety_flags: s.safetyFlags.length,
    safety_rules: [...new Set(s.safetyFlags.flatMap((f) => f.rules))].join(';'),
    total_min: minutes(s.createdAt, s.finishedAt),
  });
  return row;
}

function cell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t]/.test(s) && !/^-?\d/.test(s)) s = `'${s}`; // 엑셀 수식으로 실행되지 않게
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function toCsv(rows) {
  if (!rows.length) return '﻿';
  const headers = Object.keys(rows[0]);
  return `﻿${[headers.join(','), ...rows.map((r) => headers.map((h) => cell(r[h])).join(','))].join('\r\n')}`;
}
