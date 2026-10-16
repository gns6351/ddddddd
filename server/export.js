// 내보내기: 시연 세션 한 사람당 한 행 CSV, 공용 CSV 만들기
import { finalSubmission } from './flow.js';

const val = (v) => (v == null ? '' : v);
const STEPS = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9'];

export function flattenSession(s) {
  const subs = s.s3.submissions;
  const fin = finalSubmission(s);
  const lastCall = fin?.calls?.filter((c) => c.kind === 'transform').at(-1);
  const firstCheck = fin?.checks?.[0];
  const row = {
    pid: s.pid,
    session_id: s.id,
    session_start: s.createdAt,
    finished_at: val(s.finishedAt),
    phase: s.phase || 'pilot',
    excluded: s.excluded?.excluded ? true : '',
    exclude_reason: s.excluded?.reason || '',
    end_type: val(s.endType),
    stopped_at: val(s.stoppedAt),
    relevance: val(s.screen?.relevance),
    s2_choice: val(s.s2?.attitude),
    advice_raw: subs.map((x) => x.text).join('\n'),
    advice_raw_1: val(subs[0]?.text),
    advice_raw_2: val(subs[1]?.text),
    advice_verdict: val(fin?.verdict ?? (fin?.path === 'fail' ? fin.failReason : null)),
    advice_verdict_1: val(subs[0] ? subs[0].verdict ?? subs[0].failReason : null),
    reprompt_used: s.s3.repromptUsed,
    transformed: val(fin?.self ?? fin?.transforms?.at(-1)?.self),
    transformed_first: val(fin?.transforms?.[0]?.self),
    check: val(firstCheck?.result),
    check_final: val(fin?.checks?.at(-1)?.result),
    check_detail: fin?.checks?.map((c) => `${c.attempt}:${c.result}${c.format?.errors?.length ? `[${c.format.errors.join('|')}]` : ''}${c.meaning?.reversal ? '[reversal]' : ''}${c.meaning?.addition ? '[addition]' : ''}${c.meaning?.forcing ? '[forcing]' : ''}`).join(';') || '',
    retransformed: val(fin?.retransformed),
    s4_thought: val(s.s4?.thought),
    s4_situation: val(s.s4?.situation),
    s5_fidelity: val(s.s5?.fidelity),
    s5_edit_before: val(s.s5?.editBefore),
    s5_edit_after: val(s.s5?.editAfter),
    s6_sentence: val(s.s6?.sentence),
    s6_decision: val(s.s6?.decision),
    s6_final: val(s.s6?.final),
    s7_reason: val(s.s7?.reasonId),
    s7_category: val(s.s7?.category),
    s7_text: val(s.s7?.text),
    q10: val(s.s8?.q10),
    q11: val(s.s8?.q11),
    withdraw: s.s9 ? s.s9.withdraw : '',
    path: val(s.path),
    fail_reason: val(s.failReason),
    fail_step: val(s.failStep),
    s4_reviewed: s.reviewed ? true : '',
    llm_mode: s.llmMode,
    model: val(s.model),
    response_model: val(lastCall?.responseModel),
    check_model: val(s.checkModel),
    prompt_transform: val(s.prompts?.transform),
    prompt_check: val(s.prompts?.check),
    ai_latency_ms: val(fin?.latencyMs),
    study_version: s.studyVersion,
    content_hash: s.contentHash,
  };
  for (const st of STEPS) {
    row[`${st}_enter`] = val(s.stepTimes?.[st]?.enter);
    row[`${st}_done`] = val(s.stepTimes?.[st]?.done);
  }
  return row;
}

function cell(v) {
  const t = v == null ? '' : String(v);
  // 엑셀 수식 주입 방지
  const safe = /^[=+\-@\t\r]/.test(t) ? `'${t}` : t;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(rows) {
  if (!rows.length) return '﻿';
  const head = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return `﻿${[head.map(cell).join(','), ...rows.map((r) => head.map((k) => cell(r[k])).join(','))].join('\r\n')}\r\n`;
}
