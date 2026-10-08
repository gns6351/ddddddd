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

## Phase 6 통합 검증 — 완료(외부 승인 항목 제외)
- 보강: 운영 승인 체크리스트 게이트(`config.approvals`, B32)·사전 점검 게이트(현재 프롬프트 해시·모델 일치 + 자동 지표 합격), 인터뷰 프로토콜(`content/interview/protocol.json`, `researcher.js interview`), 모집 규칙 CLI, 2차 try 예약 전 상태 확인, 영수증 소실 안내 화면.
- 테스트(실행함): Vitest 8 files / 73 tests 통과, Playwright 5/5 통과. 매핑은 `docs/test-matrix.md` — 통과 52항목, 부분 4항목(T45·T46·T48·T50: 시스템 측 로직만), 미실행: 실제 Gemini 호출·실제 콘텐츠 E2E·기관 승인·파일럿.
- CLI 실행 확인: enroll / recruitment / export / analyze / analyze --reliability / validate --gate(실제 콘텐츠로 exit 1 = 의도된 차단).

## 남은 일(외부 입력 필요)
- B01~B08·B20·B32 실제 콘텐츠·승인 입력 → `node tools/validate.js --gate` 통과 → 실제 모델로 `tools/pretest.js` → 파일럿 → `--write-lock` 동결.
- [결정] 항목(B09~B19, B21, B24, B28, B30, B31) 연구자 확정. 확정 결과가 기본값과 다르면 해당 코드·테스트 수정 필요.

## 추가 작업 (연구자 요청)
- 시나리오 A·B·C, 화면 문구, 안전 규칙 패턴, 사전 점검 29문항 **초안** 작성. 각 파일의 version/_status에 `[미확정]` 표시를 남겨 검토 전 실험 사용을 게이트로 차단.
- 이미지 미사용(스키마 `image` 선택 항목).
- 데모 모드(`npm run demo`): 외부 기기 URL 접속 테스트용.
- 결함 수정: S3 3턴 대답(자동적 사고)이 S4 전환으로 화면에 표시되지 않던 문제 → S4에 공개된 대화 표시.
- 테스트(실행함): Vitest 10 files / 77 tests, Playwright 6/6 통과. 실제 IP 주소로 데모 서버 접속·외부 Origin 차단을 curl로 확인.

## v4 간편판으로 전환 (연구자 요청)
- 참고 프로젝트(self-advice-study) 방식으로 재구성: Express + 세션당 JSON 파일, 참가자 화면 레이아웃 교체, 연구자 웹 대시보드(`/admin`: 통계·세션 기록·내보내기·보고서), Cloudflare 터널 링크(`npm run tunnel`).
- 유지: S1~S11 흐름과 분기(ok → S6·S8, 그 외 → 생략), S10 표시 문항, 변환 프롬프트 v2·스키마, 시나리오 3종, 안전 키워드 규칙, AI 전송 범위(S4 조언 + 캐릭터 상황만).
- 단순화: 등록 ID·재개 토큰·멱등 request_id·삭제 영수증·동결/승인 게이트·SQLite 제거. 동의는 체크 하나, 위험 신호는 안내 표시 + 기록 후 진행 계속, 그만하기는 기록 보존(대시보드에서 삭제 가능).
- 테스트(실행함): `npm test` 14/14 통과(흐름·분기·409/422·규칙·fallback·동시 제출·위험 키워드·그만하기/삭제·Gemini 요청 형식(가짜 클라이언트)·thinking 미지원 재시도·대시보드 접근·입장 코드·통계 scipy 대조), `npm run test:e2e` 2/2 통과(브라우저 완주 + 대시보드, 360px 가로 스크롤 없음).
- 미검증: 실제 Gemini API 호출(이 환경에 키 없음), cloudflared 터널(이 환경에 미설치).
- RQ3 추가: 규칙 기반 비교 변환(`server/rulebased.js`), 출처를 가린 웹 코딩(코더1·2·합의, `server/rq3.js`, 대시보드 'RQ3 코딩' 탭), 방식별 오류율·유형·심각도·코더 일치도(κ·PABAK·AC1)·입력 차수 기준 ok 성공률·S6×코더 판정 집계, 출처 공개 CSV. 테스트: `npm test` 16/16, e2e 2/2(RQ3 코딩 포함).
- 명세 대조 검토 후 수정: S2·S4~S10 문구를 v3.4 명세 문구로 복원(간편판에서 바뀐 S5 안내·라벨, S6 원문/자기지향 문장, S7 근거 부족, S8 수용·수정·보류·거부, S10 q9 "S6에서", 5단계 척도 라벨), S8에 S7 근거 표시·수정 문장 빈칸 시작·target_text 저장, S10 미표시 문항 422, S3 fact_ids 저장. 변환: urgent 조언은 외부 전송 없이 safety_hold, raw unsafe/blaming 래치 → safety_hold(llm_partial), 비조언 응답 필드 조건 검사, try당 10초, 프롬프트 temperature 전달, safety_source 기록. 대시보드: 설문 중앙값[IQR]·역문항 표시, 믿음 검정은 참고로 표시, 모의 세션 섞임 경고. 테스트 `npm test` 19/19, e2e 2/2.
