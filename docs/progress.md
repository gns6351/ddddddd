# 진행 기록

## Phase 1 요구사항 추출 — 완료
- `docs/implementation-contract.md`, `BLOCKERS.md`(B01~B30) 작성. 실험 콘텐츠·승인 미제공 항목은 게이트로 차단, 구현은 계속.

## Phase 2 서버·DB — 완료
- 구현: SQLite 초기화(원본 DDL, FK·secure_delete·WAL), 세션 상태 머신(status_version CAS, BEGIN IMMEDIATE), 입력 검증(코드포인트, 422 필드별), 토큰 인증(SHA-256·4h 만료·폐기·회전), 멱등(S1/S2/S3/S4/단계), 중복·잘못된 단계 409, urgent 선검사, 철회/삭제 작업(D0~D3, 영수증), 재시작 복구(변환 unknown/fallback/safety_hold, 삭제 재개), Host/Origin/CSRF/CSP, 연구자 CLI(`tools/researcher.js`), `tools/validate.js`(게이트·frozen.lock).
- 테스트(실행함, `npx vitest run`): 4 files / 38 tests 통과.
  - T01 T02 T03 T04(a~c) T05 T06 T07(rule) T08 T10 T11 T12 T13 T14 T15 T16 T17 T18 T19 T20(ok·not_advice) T21 T26 T27 T28 T30 T33 T35(S5) T37 T40 T41 T42 T43 T44 T51 T52 T53 T54 T55 T56 — API 수준.
- 실제 콘텐츠(`content/`)로는 서버가 시작되지 않음(시나리오 자리표시자) — 의도된 차단.

## 다음
- Phase 3: S1~S11 화면(public/), Playwright E2E.
