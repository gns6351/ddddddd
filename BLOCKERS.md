# BLOCKERS — 명세 미확정·충돌 항목

상태 표기: **[외부]** 연구자/기관이 제공해야 하는 실제 콘텐츠·승인(시스템이 만들어내지 않음) · **[결정]** 명세가 불완전해 연구자 확정이 필요한 해석 · **[충돌]** 명세 내부 충돌(적용한 해소 근거 명시).
[결정] 항목은 참가자 경로·분모를 바꾸지 않는 가장 보수적인 기본값으로 임시 구현했고, 해당 위치를 코드/설정에 표시했다. 실험 투입 전 반드시 확정해야 한다.

구현은 이 항목들 때문에 멈추지 않는다. 대신 `config.frozen=true`(실험 모드)에서는 콘텐츠 게이트(`node tools/validate.js --gate`)가 통과하지 않으면 서버가 시작되지 않는다. 개발/테스트는 `test/fixtures/`의 **가상 테스트 데이터**로만 수행한다.

| ID | 구분 | 항목 | 현재 처리 |
|---|---|---|---|
| B01 | 외부 | 시나리오 A·B·C의 캐릭터 이름·상황 소개·사실 카드·3턴×3선택지 문구·대사 (§4, §11.2[C]) | Claude가 title·명세 표(고민·자동적 사고·감정/행동)와 명세 예시 사실·1턴 질문을 근거로 **초안** 작성. 연구자·IRB 검토 후 `version`의 `[미확정:B01]` 표시를 실제 버전으로 바꿔야 게이트 통과. 캐릭터 이미지는 연구자 결정으로 사용하지 않음(명세 §4·§10.1의 이미지 요건과 다름, `image` 필드는 선택 항목으로 변경) |
| B02 | 외부 | S1 동의 고지문(연구 목적·치료 아님·수집 항목·국외 이전 수령 주체/국가/보유기간·중단 시 처리·미제출 글 비복구·입력 중 미감시 한계), IRB 승인 동의서 버전 (§3, §9, §10.1) | `content/ui/strings.json`에 `[미확정:B02]`, `config.consent_version` 미확정 |
| B03 | 외부 | S11 학내 상담센터·정신건강 상담 창구 정보, 상태별 종료 안내문 (§3, §9) | `[미확정:B03]` |
| B04 | 외부 | Gemini 모델 고정 ID, 지원 thinking/temperature(1.0 활성화는 사전 점검 합격 후), SDK 확인 일시, API 데이터 처리·보유 조건 (§5, §9, §11.2[B]) | `config.model` 미확정 → 실제 Gemini 호출 차단(Mock만 동작) |
| B05 | 외부 | 안전 규칙 패턴(urgent·unsafe·blaming), 위험 분류 규칙, 연구자 대응 매뉴얼, 담당자 ID, 경보 전달 방식 (§5, §9, §10.8) | `content/safety/rules.json` 패턴 비어 있음 → 게이트 실패. 경보는 서버 콘솔 + events(원문 없음)로만 구현 |
| B06 | 외부 | `transform/v1.md` 본문(“원래 v1 보존”이라 했으나 원문 미제공) (§6) | v1 파일 미생성. `pretest --compare transform@v1` 불가 |
| B07 | 외부 | 사전 점검 세트 20~30문항(A·B·C 고르게, 시나리오 지정, ‘위험 조언’ 실제 문장) (§5, §10.10) | 명세 표의 예시 문장만 `tests.json`에 기록(scenario 미지정). 게이트 실패 |
| B08 | 외부 | 화면 문구 미제공분: S4 안내·재입력 안내, S5 각 칸의 정확한 질문문, S9 안내, S10 리커트 1~5 앵커 라벨, S6/S8 버튼 라벨 | 명세에 있는 문구는 원문 그대로 사용. 없는 문구는 `[미확정:B08]` |
| B09 | 결정 | S6 edited_self의 “선택/필수 조건”(§10.5) 미정의 | 모든 충실도 단계에서 선택 입력(수정 강제 없음) |
| B10 | 결정 | S8 target_text가 final_self(S6 확정 자기지향 문장)인지 final_advice(원문)인지 (§3 “S6에서 본 최종 조언”) | final_self로 구현 |
| B11 | 결정 | S8 공통점·차이점 “없음/판단 어려움”이 단일 선택인지 두 선택인지 (필드는 common_none 1개) | 단일 boolean 체크 “없음/판단 어려움” |
| B12 | 결정 | 연구자 인증 방식·연구자 화면 (enrollment 발급, 토큰 회전, 수동 안전중단, 완료 후 철회) | 네트워크 노출 없는 로컬 CLI `tools/researcher.js`(노트북 파일 접근 = 연구자 권한). safety_stop 세션 철회는 `--safety-policy-confirmed` 필요 |
| B13 | 결정 | 참가자 “즉시 도움 요청” 버튼의 API 경로(명세 API 표에 없음) | `POST /api/sessions/:id/help` → safety_stop(signal=help_request) |
| B14 | 결정 | Gemini 공급자 자체 안전 차단(blockReason/finishReason=SAFETY)의 분류 | 위험 플래그 관측이 아닌 기술 실패로 기록(failure_code=PROVIDER_BLOCKED) → 재시도 1회 → fallback. 참가자 경로·S10 문항은 safety_hold와 동일 |
| B15 | 결정 | fallback 중 rule_fallback 적중 시 outcome 라벨 | unsafe/blaming + safety_source=rule_fallback (경로 동일) |
| B16 | 결정 | 규칙 기반 비교 변환의 치환표·틀 선택 규칙(§6 “치환 + 동일 틀”만 명시) | `content/rulebased/rules.json` v0-provisional(최소 2인칭→1인칭 치환, “나도 비슷한 상황이라면, …라고 생각해볼 수 있다”) |
| B17 | 결정 | 삭제 후 동의·철회 입증 잔존 범위(IRB 승인 항목만) | tombstone에 session_id·status·withdrawal_from_step·deletion_state만 유지, 시각·식별 필드 NULL |
| B18 | 결정 | 백업·녹음 파일 저장 위치와 삭제 검색 대상 경로 | `config.storage_paths`(export/, coding/, interviews/, stats/, backups/). 정제 불가 파일에서 잔존 발견 시 error(삭제 완료 보고 안 함) |
| B19 | 결정 | 파일럿 데이터 분리 방식 | 파일럿은 별도 DB 경로(`DATA_DIR`)로 운영 |
| B20 | 외부 | analysis_plan_version 날짜(2026-10-XX) | 미확정 → analyze 결과에 그대로 표시, 게이트 실패 |
| B21 | 충돌 | §5 예외흐름 “위험 신호 없으면 재시도 1회” vs §10.6 “긍정 신호는 모든 재시도 간 유지”·T25 “unsafe 발견 후 재시도 타임아웃” | §10/§13 우선 규정에 따라: 검증 실패면 래치 여부와 무관하게 try2 수행, 래치는 해제하지 않음 |
| B22 | 충돌 | §7 본문 “총 아홉 테이블” vs “총 12개” | §13.1·schema_v3.4.sql 기준 12개 |
| B23 | 정보 | 요청문에 언급된 별도 “감사 보고서” 파일은 첨부되지 않음 | DOCX §11~§14 감사 내용으로 교차 확인 |
| B24 | 결정 | 종료 후 세션 토큰 폐기 시점 | completed/no_experience/withdrawn/safety_stop/deletion_pending 진입 시 즉시 폐기. S11 안내는 공개 문구(GET /api/public/ui)로 표시 |
| B25 | 결정 | S2 캐릭터 제시 순서(고정/무작위) | config.scenarios 순서 고정 |
| B26 | 외부 | 인터뷰 메모 틀·themes.csv·코더 시트 열 형식의 정식 양식 | export가 생성하는 열 형식을 임시 표준으로 사용(`docs/coding-format.md`) |
| B27 | 외부 | 디스크 암호화/SQLCipher 적용 (§9) | 운영 절차 항목. 코드에서 미구현 |
| B28 | 충돌 | §5 “시간 초과 → 재시도 1회”·T37 vs T44 “공급자 무응답 → unknown, 자동 재전송 0” | 앱 10초 제한 초과(TIMEOUT)는 failed로 기록 후 try2 허용. 응답 없이 연결이 끊긴 네트워크 장애는 unknown으로 기록하고 재송신하지 않음(fallback/safety_hold). 서버 재시작 시 reserved/dispatched는 unknown |
| B29 | 정보 | DDL `experience_checks` CHECK는 SQLite의 NULL 평가 규칙상 has_experience=1·relevance NULL 행을 거부하지 못함 | 정식 DDL은 수정하지 않고 서비스 계층(422)에서 보증. 테스트로 확인 |
| B30 | 결정 | advice_validity 값 매핑(명세는 fallback=unknown만 명시) | ok=valid, not_advice=invalid, unsafe/blaming/safety_hold/fallback=unknown |
| B31 | 결정 | 조언 질(advice_quality) 코딩 시트 위치(명세 내보내기 표에 없음) | 별도 `advice_sheet.csv`(final_advice 기준) |
| B32 | 외부 | §10.1 동의/운영 게이트 승인 근거(IRB 결정, 참여·국외 이전·녹음 동의서, 만 19세 확인 절차, LLM 제공자 국가·보유·활용 조건, 긴급 대응 매뉴얼·연락 체계·모의훈련, 연구자 교육, 사전 점검 수동 검토) | `config.approvals`에 근거 기록 전에는 서버 시작 차단 |
| B33 | 외부 | §13.5 인터뷰 프로토콜: 질문 문구는 명세 원문 사용, 코드북·경로별 보조 질문 세부는 미제공 | `content/interview/protocol.json`(명세 Q1~Q6·표준 문구 원문)과 연구자 CLI `interview` 명령으로 경로별 질문·메모 틀만 제공 |
