# 진행 기록

## Phase 1 요구사항 추출 — 완료
- `docs/implementation-contract.md`, `BLOCKERS.md`(B01~B30) 작성. 실험 콘텐츠·승인 미제공 항목은 게이트로 차단, 구현은 계속.

## Phase 2 서버·DB — 완료
- 구현: SQLite 초기화(원본 DDL, FK·secure_delete·WAL), 세션 상태 머신(status_version CAS, BEGIN IMMEDIATE), 입력 검증(코드포인트, 422 필드별), 토큰 인증(SHA-256·4h 만료·폐기·회전), 멱등(S1/S2/S3/S4/단계), 중복·잘못된 단계 409, urgent 선검사, 철회/삭제 작업(D0~D3, 영수증), 재시작 복구(변환 unknown/fallback/safety_hold, 삭제 재개), Host/Origin/CSRF/CSP, 연구자 CLI(`tools/researcher.js`), `tools/validate.js`(게이트·frozen.lock).
- 테스트(실행함, `npx vitest run`): 4 files / 38 tests 통과.
  - T01 T02 T03 T04(a~c) T05 T06 T07(rule) T08 T10 T11 T12 T13 T14 T15 T16 T17 T18 T19 T20(ok·not_advice) T21 T26 T27 T28 T30 T33 T35(S5) T37 T40 T41 T42 T43 T44 T51 T52 T53 T54 T55 T56 — API 수준.
- 실제 콘텐츠(`content/`)로는 서버가 시작되지 않음(시나리오 자리표시자) — 의도된 차단.

## Phase 3 화면 — 완료
- `public/` 단일 페이지(Vanilla JS). 화면 선택은 서버 `current_step/status`만 사용, 모든 텍스트 `textContent` 렌더, CSP self.
- S2~S10 상단 참여 중단·즉시 도움 요청 버튼, 코드포인트 글자 수 안내, 422 필드 안내, S4 pending 폴링, 응답 유실 시 동일 request_id 재사용, S11 delete 영수증(요청 전 생성·sessionStorage) 상태 조회, 토큰 회전 복구(`#resume=` → sessionStorage 후 주소 제거), 다음 참가자 준비(sessionStorage 비움).
- 수정한 결함: S10 완료 직후 토큰 폐기로 종료 유형이 일반 안내로 표시되던 문제, `[hidden]` CSS 우선순위.
- 테스트(실행함): Playwright 5/5 통과 — T01(UI), T03·S3 네트워크 payload 실측, T06/T20(UI 5문항), T15/T27(뒤로가기·새로고침), T19(UI), T24(HTML 비실행), T30(UI), T54(UI). Vitest 38/38 재통과.

## Phase 4 LLM — 완료(실제 Gemini 호출은 미검증)
- Mock 전 경로: ok / not_advice / unsafe / blaming / both / JSON·조건 오류 / raw 래치 / 타임아웃 / HTTP 오류 / 네트워크 불명(unknown, 재송신 0) / 공급자 차단(B14) / rule_fallback.
- Gemini 클라이언트: `@google/genai` generateContent에 responseMimeType=application/json, responseJsonSchema(schema.json), temperature(프롬프트 머리말), thinkingConfig.thinkingLevel, abortSignal 전달. 모델 ID 미확정·API 키 없음이면 호출 자체 거부.
- `tools/pretest.js` + `core/pretest.js`: trial/try/고유 항목 분모 분리, 자동 게이트 지표.
- 테스트(실행함): Vitest 6 files / 57 tests 통과 — 추가로 T07(LLM) T09 T25 T29 T32(DB) T47, 개인 기록 비전송·프롬프트 치환 주입 방지, 판정기 단위, Gemini 요청 형식(가짜 클라이언트 주입).
- **미검증**: 실제 Gemini API 호출(모델 ID B04 미확정, 이 환경에 GEMINI_API_KEY 없음). 실제 모델의 responseJsonSchema·thinkingLevel 지원 여부는 모델 확정 후 pretest로 확인 필요.

## Phase 5 연구 데이터 — 완료
- `tools/export.js`: sessions.csv(빈칸=null, NA=비해당, true/false), reexam/selfapp/s8/error/core/advice 시트(무작위 순서·블라인드 ID 재사용), sheet_denominators.csv, coding_key.csv, llm_log.csv, timeline_<코드>.txt. 삭제 작업 진행 중 차단.
- `tools/rulebased.js`(치환표 v0-provisional, B16), `tools/analyze.js`(--reliability: 가중 κ·κ·일치율·PABAK·AC1·유형별 일치·불일치 목록 / 전체: RQ1~3·ops·exclusions·report.md·fig_prepost.svg + analysis_runs·stats·멤버/출력 매니페스트).
- 분모: §10.9 그대로(n_ok = completed & ok, 자기적용 ok 완료만, q9×q2/q10×q11 표시·응답 세션만, RQ3 ok 변환 + 전체 입력 차수 성공률 병기).
- 테스트(실행함): Vitest 7 files / 64 tests 통과 — 추가 T23 T31 T32(CSV) T33(CSV) T34 T36 T38 T39 T46 T49, κ/AC1 수치 검증.

## 다음
- Phase 6: T01~T56 전수 매핑·누락분(T22 동결, T45 게이트, T48 인터뷰 등) 실행, 결과표 작성.
