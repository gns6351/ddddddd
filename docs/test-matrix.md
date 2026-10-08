# 수용 테스트 T01~T56 실행 결과

실행 환경: Node 22, SQLite(better-sqlite3), Mock LLM, `test/fixtures`의 가상 시나리오. 실행 명령 `npx vitest run`(73 tests), `npx playwright test`(5 tests).
판정: **통과** = 자동 테스트로 실제 실행해 합격 / **부분** = 시스템 측 로직만 검증, 나머지는 외부 절차 / **미실행** = 이 환경에서 실행 불가.

| ID | 판정 | 테스트 위치 |
|---|---|---|
| T01 | 통과 | flow.test.js `S1→S11 completed`, e2e `T01/T24/T03` |
| T02 | 통과 | flow.test.js `T02` |
| T03 | 통과 | flow.test.js `T03`, research-data(exclusions) |
| T04 a~c | 통과 | flow.test.js `S3 대화`, e2e 네트워크 payload |
| T05 | 통과 | flow.test.js `T05` |
| T06 | 통과 | flow.test.js `T06`, e2e `T06/T20` |
| T07 | 통과 | safety-withdraw(rule), llm.test(LLM) |
| T08 | 통과 | safety-withdraw `T53/T08` (provider 호출 0, llm_calls 0행) |
| T09 | 통과 | llm.test `T09` |
| T10·T11·T12 | 통과 | flow.test.js `T10/T11/T12` |
| T13 | 통과 | safety-withdraw(abort+delete), integration(abort 무시 공급자+delete, DB 파일 바이트 검색) |
| T14 | 통과 | safety-withdraw `재시작 복구` |
| T15 | 통과 | flow.test.js(API), e2e `T15/T27` |
| T16 | 통과 | flow.test.js `인증` |
| T17·T18 | 통과 | flow.test.js `입력 검증` |
| T19 | 통과 | flow.test.js(API), e2e(UI) |
| T20 | 통과 | integration `T20` 6경로, e2e |
| T21 | 통과 | safety-withdraw `호출 도중 중단→delete`(DB·enrollments·CSV·코더 파일·전사·타임라인·보고서·DB/WAL 바이트·임시파일), 정제 불가 백업 → error |
| T22 | 통과 | integration `T22`(파일 변경·추가 시 동결 모드 시작 실패) |
| T23 | 통과 | research-data `T23` |
| T24 | 통과 | e2e(img onerror 미실행, textContent 렌더). CSV는 HTML로 렌더하지 않음 |
| T25 | 통과 | llm.test `T25` |
| T26 | 통과 | flow.test.js `S1 세션 생성` |
| T27 | 통과 | flow.test.js `인증`(토큰 불일치·만료·회전), e2e 새로고침, 재시작 후 토큰 유지(safety-withdraw) |
| T28 | 통과 | safety-withdraw `T28/T55`(DB 삭제 직후 강제 종료 → 재시작 재개), research-data `T49` |
| T29 | 통과 | llm.test `T29`, research-data(NA 표기) |
| T30 | 통과 | safety-withdraw `T30`, e2e |
| T31 | 통과 | research-data(보고서 금지 패턴 검사) |
| T32 | 통과 | llm.test, research-data(CSV·llm_log·ops), integration(researcher) |
| T33 | 통과 | flow.test.js(API 거부), research-data(CSV true/false/빈칸) |
| T34 | 통과 | research-data(shown_self 보존, q9 원값) |
| T35 | 통과 | flow.test.js(S4·S5), integration(S6~S10 전 필드), integration `T45`(pretest 미합격 시 게이트 차단) |
| T36 | 통과 | research-data `T36/T39/T49` |
| T37 | 통과 | safety-withdraw `T37` |
| T38 | 통과 | research-data(사전 원칙 = final_advice만) |
| T39 | 통과 | research-data `T36/T39/T49` |
| T40 | 통과 | safety-withdraw(enrollments·code·해시 잔존 0) |
| T41 | 통과 | safety-withdraw `T41` |
| T42 | 통과 | safety-withdraw(원문 최대 2행), flow(S4 요약 키만) |
| T43 | 통과 | db-schema.test.js (DDL 한계 1건 B29 기록) |
| T44 | 통과 | safety-withdraw(reserved/dispatched → unknown), integration(호출 수 과대계산 0) |
| T45 | 부분 | integration: 승인 1개 누락 시 게이트 차단, pretest 합격으로 대체 불가. 실제 기관 승인은 외부 |
| T46 | 부분 | research-data(모집 규칙 함수), `tools/researcher.js recruitment`. 실제 모집 운영은 외부 |
| T47 | 통과 | pretest.test.js(Mock, trial 60·try 67·항목 20). 실제 모델 사전 점검은 미실행(B04, B07) |
| T48 | 부분 | integration(경로별 질문·메모 틀·completed만). 실제 인터뷰 진행은 외부 |
| T49 | 통과 | research-data |
| T50 | 부분 | integration(동결 불일치·pretest 해시 불일치 시 시작 차단). 파일럿 판정은 연구자 절차 |
| T51·T52 | 통과 | flow.test.js |
| T53 | 통과 | safety-withdraw |
| T54 | 통과 | safety-withdraw(API), e2e(UI, 세션 GET 미호출) |
| T55 | 통과 | safety-withdraw `T28/T55` |
| T56 | 통과 | safety-withdraw(잘못된 영수증 404·만료 410·평문 미저장), e2e(영수증 소실 안내) |

미실행: 실제 Gemini API 호출(모델 ID·API 키 미제공), 실제 콘텐츠로의 E2E(B01), 기관 승인·파일럿.
