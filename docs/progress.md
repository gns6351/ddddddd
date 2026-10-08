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

## 다음
- Phase 4: Mock LLM 전 경로(T07/T09/T25/T29/T32 등), Gemini 클라이언트 구조화 출력·오류 분류 검증.
