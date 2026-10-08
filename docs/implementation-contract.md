# 구현 계약 (v3.4 명세 추출본)

원천: `상담자 역할 게임 자기적용 시스템 명세 v3.4`(DOCX) + `db/schema.sql`(schema_v3.4.sql 원본 그대로).
우선순위: §13·§14 > §10 > §1~9 (명세 §13 서두 규정). 별도 "감사 보고서" 파일은 첨부되지 않았으며 감사 내용은 DOCX §11~§14에 포함된 것을 사용한다.
미확정 항목은 `BLOCKERS.md`의 ID(Bxx)로 참조한다. 이 문서에 없는 기능은 구현하지 않는다.

## 1. 연구 고정값 (변경 금지)
- RQ1~RQ3, S1~S11 흐름, S5/S9/S10 문구, 코딩 기준 A~D, 분석 분모(§10.9)는 명세 원문 그대로.
- LLM 사용처는 S4 조언 변환 1종뿐. 캐릭터 대화는 고정 스크립트(`dialogue.mode=script`).
- S5~S9 개인 기록은 외부 LLM에 절대 전송하지 않는다. 외부 전송 = S4 조언 + 캐릭터 summary + automatic_thought.

## 2. 화면 전이 (서버 `transition()`만 결정)
| 현재 | 조건 | 다음 | 원자 저장 |
|---|---|---|---|
| S1 | 두 동의 true + 유효 enrollment | S2 active | sessions 생성, consented_at/consent_version/transfer_consent, enrollments.session_id/consumed_at |
| S2 | 미확인 캐릭터 경험 없음 | S2 | experience_checks 1행(relevance NULL) |
| S2 | 경험 있음 + relevance 1~5 | S3 | experience_checks 1행, sessions.character_id/relevance |
| S2 | 서로 다른 3명 모두 없음(서버 기록) | S11 no_experience | finished_at |
| S3 | 턴 1,2 | S3 | dialogue 1행 |
| S3 | 턴 3 | S4 | dialogue 3번째 행 |
| S4 | attempt1 not_advice | S4(retry) | transform_requests attempt1 completed |
| S4 | attempt1 ok/fallback/safety_hold/unsafe/blaming, attempt2 모든 outcome | S5 | step_responses.S4 요약, sessions.transform_outcome |
| S4 | urgent(규칙) | S11 safety_stop | 원문 일반 저장 없음, LLM 0 |
| S5 | 유효 + outcome=ok | S6 | S5 응답 |
| S5 | 유효 + outcome≠ok | S7 | S5 응답 |
| S6 | 유효 | S7 | final_self = edited_self ?? shown_self |
| S7 | 유효, S6 경유 | S8 / S6 생략 → S9 | 근거 |
| S8 | 유효 | S9 | 판단 |
| S9 | 유효 | S10 | 사후 응답 |
| S10 | shown_items 전부 응답 | S11 completed | 설문 + completed + finished_at |
| S2~S10 | 중단 요청 | S11 withdrawal_pending | withdrawal_from_step, cancel_requested=1, 진행중 호출 abort |
| S11 withdrawal_pending | keep / delete(+receipt_secret) | withdrawn / deletion_pending | deletion_jobs(receipt_hash) 같은 트랜잭션 |
| S2~S10 | urgent·도움 요청·연구자 안전중단 | S11 safety_stop | events(safety_stop: signal_type, step, responder_id) 원문 없음 |
| S11 terminal | 쓰기 | 변경 없음 | 409 |
| deletion_pending | 전수 삭제 검증 0건 | deleted_confirmed | deletion_jobs.confirmation_at, receipt_expires_at=+24h |

- status·current_step·processing_state는 독립 값. 모든 다중 행 전이는 `BEGIN IMMEDIATE` + `status_version` CAS.
- 종료 상태(completed/no_experience/withdrawn/deleted_confirmed/safety_stop)는 과제 쓰기 거부(409). 완료 후 철회는 연구자 CLI(B12).
- 이전 단계로 돌아갈 수 없음. 과거/미래 단계 제출 409, 필드 검증 실패 422.

## 3. API
공통: `127.0.0.1` 바인딩, Host/Origin 검사, 변경 요청은 `Content-Type: application/json` + `X-Requested-With: research-app` 필수(CSRF), CORS 미허용, CSP `default-src 'self'`, body 64KB 제한, 세션 API는 `Authorization: Bearer <resume_secret>` 필수(session_id만으로 접근 금지).

| API | 계약 |
|---|---|
| GET /api/public/ui | S1 동의 고지·S11 종료/상담창구 문구만(세션 전 공개 정보) |
| POST /api/sessions | {participant_code, enrollment_id, request_id, resume_secret, consent:true, transfer_consent:true}. enrollment 사전 발급 필수. 같은 enrollment+request_id+본문 해시+secret → 같은 session_id 재반환, 그 외 409 |
| GET /api/sessions/:id | {status, current_step, transform_state, context}. context는 현재 단계 허용 항목만 |
| GET /api/scenarios(/:id) | id·name·summary·image 공개 필드만 |
| GET /api/scenarios/:id/image | 캐릭터 이미지 |
| GET /api/sessions/:id/dialogue/options | S3 현재 턴 선택지 3개 + 이미 공개된 장면 |
| POST /api/sessions/:id/dialogue | {turn, choice_id, request_id}. 같은 ID+본문 → 저장 결과, 같은 ID+다른 본문 409, 새 ID+과거/미래 턴 409 |
| POST /api/sessions/:id/transform | {advice, request_id}. 202 {status:"pending", request_id} / 200 {outcome, next_step}. 원문·변환문 미포함. 같은 ID+다른 본문 409, 다른 ID 동시 진행 409 PROCESSING |
| POST /api/sessions/:id/steps/:step | {request_id, data}. S2, S5~S10. 현재 단계 정확 일치. 같은 request_id+본문 → 기존 next_step |
| POST /api/sessions/:id/events | [{event_id, type, payload, ts}] 클라이언트 허용 유형·payload 최소화·event_id 멱등 |
| POST /api/sessions/:id/withdraw | withdrawal_pending 즉시 확정, 재요청 멱등 |
| POST /api/sessions/:id/help | 참가자 즉시 도움 요청 → safety_stop (명세 "화면의 도움 요청" 구현용, 경로명은 B13) |
| POST /api/sessions/:id/withdrawal-choice | {choice:"keep"\|"delete", receipt_secret(64 hex, delete 필수)} |
| POST /api/sessions/:id/finish | 항상 409 (클라이언트 임의 상태 지정 금지) |
| POST /api/deletions/status | {receipt_secret} → {state: pending\|error\|confirmed, message}. 세션 토큰 불필요, 없음 404, 만료 410, 호출 제한 |

GET context: S2 남은 캐릭터 요약 / S3 현 턴 선택지+공개 장면 / S4 캐릭터 마지막 말·retry·pending / S5 문항 / S6 ok에서만 final_advice·shown_self / S7 S5 automatic_thought / S8 target_text·automatic_thought·S7 근거 / S9 S5 situation·automatic_thought(view_pre 금지) / S10 shown_items+문항 / S11 종료 유형. 비-ok 경로는 원문·변환문 어디에도 미제공. 시나리오 전체 JSON·미선택 대사·automatic_thought 사전 제공 금지.

## 4. 인증·멱등
- enrollment: 연구자 CLI가 enrollment_id·participant_code 사전 발급.
- resume_secret: 브라우저가 32바이트 난수 생성(sessionStorage). 서버는 SHA-256 해시·생성시각·만료(+4h)·폐기시각만 저장. timing-safe 비교.
- 종료 상태 진입 시 토큰 폐기(withdrawal_pending 제외). 토큰 회전은 연구자 CLI(이전 토큰 즉시 폐기).
- 삭제 영수증: 브라우저 CSPRNG 256비트, 서버는 SHA-256만, 평문 비저장·비로깅.

## 5. 입력 검증 (trim 후 유니코드 코드포인트, 초과/미달 422 + 필드별 min/max, 절단 금지)
S2 experience yes/no, relevance yes→1~5 정수 / no→null · S3 현재 턴 + 서버 선택지 · S4 advice 1~2000 · S5 situation 2~2000, emotion 2~500, automatic_thought 2~500, view_pre 2~2000, belief_pre 0~100 정수 · S6 fidelity 3단계, edited_self 2~1000(선택) · S7 for/against 각 텍스트 2~2000 XOR none=true(none이면 텍스트 "") · S8 common/difference 2~1000 XOR none, verdict accept|modify|hold|reject, reason 2~2000, modify→modified_text 2~1000 필수 · S9 view_post 2~2000, belief_post 0~100 정수 · S10 shown_items 각 1~5 정수, 미표시 문항 전달 시 422.

## 6. LLM 변환 (§5, §10.6)
처리 순서: ①인증·단계 ②(session,attempt) 원자 예약(pending) ③로컬 규칙(urgent→safety_stop / unsafe→blaming, rule_pre, llm_calls 0행) ④try 행 reserved ⑤직렬화 구역에서 status=active·status_version·cancel_requested 확인 후 dispatched+dispatch_intent_at 커밋, 그 뒤 SDK 호출(10초 abort) ⑥raw에서 unsafe/blaming=true 보수 추출·즉시 영속 래치 ⑦스키마+조건부 검증 ⑧실패 시 try2(래치 유지), 최종 실패 fail-closed ⑨최신 상태 확인 후 단일 트랜잭션 기록.
- outcome 결정: urgent→safety_stop > unsafe > blaming > safety_hold > not_advice > ok; 미확정 기술실패 = fallback.
  - 유효 출력 + unsafe=true → unsafe(llm), blaming=true → blaming(llm).
  - 검증 실패 + 래치 → try2. try2 유효+플래그 → 해당 플래그 outcome(llm), 그 외 → safety_hold(llm_partial).
  - 래치 없음 + 2회 실패 → fallback(advice_validity=unknown), fallback 시 규칙 재검사(rule_fallback, 반환 허가 아님).
  - 유효 + 플래그 false: is_advice=false→not_advice, true→ok(type∈{대안적 사고,행동 제안,혼합}, core 1~2개·각 ≤40자, self 비어있지 않음).
- 전체 DB 트랜잭션을 원격 대기 중 열지 않음. 늦은 응답은 상태 불일치 시 raw/parsed 저장 안 함(cancelled).
- 재시작: pending transform → 해당 try reserved/dispatched → unknown, 자동 재송신 0. 래치 있으면 safety_hold, 없으면 fallback(failure_reason=interrupted_fallback). 세션이 active·S4가 아니면 결과 폐기(cancelled).
- 프롬프트: content/prompts/<name>/<ver>.md(front matter + 본문, {{examples}} 치환), 서버 코드에 문구 없음. 호출 로그에 prompt id@ver·sha256, model_id 기록.

## 7. 안전 (urgent 검사 위치)
S4 advice, S5(situation·emotion·automatic_thought·view_pre), S6 edited_self, S7 for/against, S8 common·difference·reason·modified_text, S9 view_post. 저장·전이 전 검사, 적중 시 응답 미저장 + safety_stop + events(원문 없음) + 연구자 콘솔 경보. 진행 중 LLM abort, 이후 try 금지. 규칙 패턴은 content/safety/rules.json(버전 포함).

## 8. 데이터
- 12테이블 DDL 원본 사용, 연결마다 `foreign_keys=ON`, `secure_delete=ON`, WAL.
- S4 원문은 transform_requests.advice_text 단일 보관. step_responses.S4 = {final_attempt, final_request_id, final_outcome, final_advice_ref_request_id}.
- events payload: 유형·선택값·글자 수·변경 여부만(자유서술 금지). server_ts 신뢰.
- 단계 진입 시각: 서버가 전이 시 step_enter 이벤트 기록 → step_responses.entered_at.

## 9. 철회·삭제 (§10.8, §13.2)
D0 deletion_pending + cancel_requested + job(receipt_hash) → D1 영향 analysis_runs invalid·stats invalidated_at·산출물 삭제 → D2 파일(export/coding/interviews/stats/backups 등 설정 경로) 정제·삭제, enrollments 행 DELETE, 세션 종속 행 DELETE, sessions는 tombstone(식별·시각 필드 NULL) → D3 WAL checkpoint(TRUNCATE)·잔존 검색 0건 → deleted_confirmed. D4 재분석은 별도. 삭제 진행 중 export/analyze 차단. 재시작 시 멱등 재개. 정제 불가 파일(바이너리 백업 등) 잔존 시 error.

## 10. 분석 (§7·§8·§10.9)
- export.js: sessions.csv, reexam_sheet, selfapp_sheet, s8_sheet, error_sheet, core_sheet, coding_key, llm_log, timeline_<code>.txt. 블라인드 ID 재사용(기존 coding_key 유지).
- analyze.js: --reliability(가중 κ·κ·일치율·PABAK·AC1·불일치 목록), 전체 통계 파일 목록(§8) + stats 테이블 + analysis_runs(dataset_hash, tool_version_hash, frozen_hash, member manifest).
- 분모: §10.9 표 그대로. n_ok = completed & transform_outcome=ok distinct session.
- 보고서에 LLM 일반 우월성·효과 단정 문구 금지(T31).

## 11. 동결 (§6)
config.frozen=true면 frozen.lock 해시 검증 실패 시 서버 시작 실패(T22). frozen 모드는 콘텐츠 게이트(자리표시자 0, 규칙 패턴 존재, 모델 ID 확정, provider=gemini)도 요구.

## 12. 수용 테스트 매핑
T01~T56 → `test/` (docs/progress.md에 실행 결과 기록). 외부 승인 항목(T45 기관 승인, T46 모집 운영, T48 인터뷰 실시, T50 파일럿)은 시스템이 판정할 수 없으며 해당 게이트 로직/문서만 검증.
