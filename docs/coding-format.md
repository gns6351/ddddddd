# 코딩 시트·코더 파일 형식 (임시 표준, B26)

`node tools/export.js` → `export/`:
- `sessions.csv` 참가자당 1행. 빈칸=null(미응답·미표시), `NA`=경로상 비해당, `true/false`=불리언.
- `reexam_sheet.csv` (blind_id, text, score) — S5·S9 해석문만, 시점·조언 미제공, 무작위 순서. 완료 세션 전체.
- `selfapp_sheet.csv` (blind_id, principles, text, score) — ok 완료만. principles는 그 시점까지 참가자가 확인한 문장(S5=final_advice만). 시점 추정 가능성 한계.
- `s8_sheet.csv` (blind_id, principles, common, common_none, difference, difference_none, verdict, reason, modified_text, score) — ok 완료만.
- `error_sheet.csv` (blind_id, final_advice, sentence, error_types, severity, frame_diff) — ok 변환별 LLM·규칙 주절 2행, 상황절은 `[상황]`.
- `core_sheet.csv` (blind_id, final_advice, situation_clause, core, char_fact, core_error_types) — LLM만(보조).
- `advice_sheet.csv` (blind_id, final_advice, score 0~2) — 조언 질. 명세에 시트 위치가 없어 별도 시트로 둠(B31).
- `sheet_denominators.csv` 시트별 대상 세션·행·제외 사유. `coding_key.csv`는 코더 비공개. `llm_log.csv`, `timeline_<코드>.txt`.

코더 입력: `coding/coder1_<sheet>.csv`, `coding/coder2_<sheet>.csv`, 확정 `coding/final_<sheet>.csv` (sheet = reexam·selfapp·s8·error·core·advice). 시트를 복사해 같은 열에 값 입력.
- score: reexam·selfapp·s8 0~3, advice 0~2 정수.
- error_types: `정상` 또는 `의미 추가;의미 왜곡;의미 반전;의미 누락;강도 변경;과도한 일반화;캐릭터 사실 포함;형식·어조 위반` 중 복수(`;` 구분). severity `심각|중간|경미`. frame_diff `true|false`(오류 이진 판정에 미포함).
- core: char_fact `true|false`, core_error_types 위와 같은 형식.

기타 입력: `coding/final_exclusions.csv` (participant_code, excluded true|false, reason) — 분석 제외 기준 D, 연구자 2인 합의 결과. `coding/themes.csv` (participant_code, theme) — 인터뷰 주제.
