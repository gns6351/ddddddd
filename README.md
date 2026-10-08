# 상담자 역할 게임 자기적용 시스템 v3.4 (로컬 연구용)

연구자 노트북에서 `127.0.0.1`로만 실행하는 연구 프로토타입. 요구사항은 명세 v3.4(DOCX)와 `db/schema.sql`(schema_v3.4.sql 원본).
- 구현 계약: `docs/implementation-contract.md` · 미확정/충돌: `BLOCKERS.md` · 진행: `docs/progress.md` · 테스트 결과: `docs/test-matrix.md` · 코딩 형식: `docs/coding-format.md`

**현재 상태: 실험 투입 불가.** 실제 시나리오 대사·동의서·안전 규칙 패턴·모델 ID·기관 승인(BLOCKERS B01~B05, B32 등)이 없으므로 서버는 실제 콘텐츠로 시작되지 않는다(의도된 차단).

## 설치
```
npm ci
```
`.env`(커밋 금지): `GEMINI_API_KEY=...`

## 실행
- 개발·시연(가상 시나리오 + Mock LLM, 실제 참가자 사용 금지): `node test/support/dev-server.js` → http://127.0.0.1:3300
- 실험 모드: `npm start` — `node tools/validate.js --gate`가 통과해야 시작된다. 파일럿 승인 후 `node tools/validate.js --write-lock`으로 동결하고 `config/experiment.json`의 `frozen: true`.
- 파일럿은 별도 DB 경로로 운영: `DATA_DIR=./data-pilot npm start`

## 외부 테스트 공유 (데모 모드, 실험 아님)
```
npm run demo            # 0.0.0.0:3300, 같은 네트워크에서 http://<이 컴퓨터 IP>:3300
npm run demo -- --reset # 데모 데이터 초기화
cloudflared tunnel --url http://localhost:3300   # 인터넷 공유가 필요할 때(https 주소 발급, 별도 설치)
```
- 현재 `content/` 초안을 사용하고 LLM은 Mock(가짜 변환 문장)으로 고정. 데이터는 `demo-data/`에만 저장.
- S1의 '데모용 코드 자동 발급' 버튼으로 연구자 없이 시작. 조언 끝에 `#notadvice #unsafe #blaming #badjson #latchbad #timeout`을 붙이면 예외 경로 확인.
- 실명·개인정보·실제 고민 입력 금지(화면 배너 표시). 방화벽에서 해당 포트 허용이 필요할 수 있음.

## 연구자 CLI (네트워크 비노출)
```
node tools/researcher.js enroll <참가자코드>       # S1 전에 enrollment_id 발급
node tools/researcher.js rotate <session_id>       # 토큰 회전·복구 URL
node tools/researcher.js safety-stop <session_id> [담당자ID]
node tools/researcher.js withdraw <session_id> keep|delete
node tools/researcher.js deletion-run [session_id]
node tools/researcher.js interview <session_id>
node tools/researcher.js recruitment
```

## 데이터 처리
```
node tools/export.js                 # export/ : sessions.csv, 블라인드 시트, coding_key.csv(코더 비공개), llm_log.csv, timeline
node tools/analyze.js --reliability  # coding/coder1_*.csv, coder2_*.csv
node tools/analyze.js                # stats/ + analysis_runs·stats 테이블
node tools/pretest.js --prompt transform@v2
```
삭제 작업이 진행 중이면 export/analyze는 차단된다.

## 테스트
```
npx vitest run
npx playwright test     # Chromium: /opt/pw-browsers/chromium 또는 PW_CHROMIUM
```

## 보안·개인정보
- `.env`, `data/`, `export/`, `coding/*`, `interviews/*`, `stats/*`, `backups/`, `*.db`는 `.gitignore` 대상(원시 상담 데이터·API 키 업로드 금지).
- SQLite는 암호화되지 않는다. 노트북 전체 디스크 암호화를 적용한다(§9, B27).
