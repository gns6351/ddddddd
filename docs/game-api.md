# 거울상담소 게임 API (앱 연동용)

Android 앱(React Native·Expo)이 부르는 서버 API입니다. 기준 문서는 「거울상담소 중간보고서」의 FR-01~12, NFR-01~08입니다. AI 호출은 모두 서버에서 하고, **앱에는 API 키를 넣지 않습니다**(NFR-04).

- 기본 주소: `http://<서버>:3000/api/game`. 논문용 API(`/api/...`)와 분리되어 있습니다(NFR-08).
- 모든 `POST`에는 `requestId`(영문·숫자·`-`·`_` 8~64자)를 넣습니다. 버튼을 누를 때마다 새로 만들고, 같은 요청을 다시 보낼 때는 같은 값을 씁니다(FR-12).
- `playerId`: 기기마다 한 번 만들어 저장해 두는 익명 ID(영문·숫자·`-`·`_` 6~64자). 세션을 만들 때 본문에 넣고, **그 뒤 모든 요청에는 헤더 `x-player-id`로 보냅니다.** 세션을 만든 플레이어만 읽고 바꿀 수 있습니다(다르면 403 `FORBIDDEN`).
- 응답은 언제나 세션의 **현재 화면 상태(view)** 입니다. 앱은 `stage`를 보고 화면을 고릅니다.

## 단계 (stage)

| stage | 화면 | 다음 요청 |
|---|---|---|
| `worry` | 접수: 걱정 입력 또는 예시 걱정 고르기 | `POST /sessions/:id/worry` |
| `guest` | 손님 맞이: 손님 카드, 다시 만들기(1회) | `POST /sessions/:id/start`, `POST /sessions/:id/guest/reroll` |
| `counsel` | 상담: 손님 대사, 선택지 버튼 또는 입력창 | `POST /sessions/:id/turn`, `POST /sessions/:id/end` |
| `mirror` | 거울 장면: 하이라이트를 앞뒤 발화와 함께 보여 주고 고르게 함 | `POST /sessions/:id/mirror` |
| `judge` | 비교·판단: 원래 걱정·손님에게 한 말·돌아온 말 | `POST /sessions/:id/decision` |
| `done` | 마무리 화면(하이라이트가 없었으면 거울 장면 없이 여기로) | — |
| `help` | 도움 안내(위험 감지). 이 세션의 역할극은 다시 열리지 않음 | — |
| `quit` | 그만하기 | — |

모든 화면에 "그만하기"를 둡니다 → `POST /sessions/:id/quit` (FR-11).

## 요청

| 요청 | 본문 | 설명 |
|---|---|---|
| `GET /config` | — | 동의 문구(수집 목적·외부 AI 전송·보관 기간·삭제 방법), 저장 선택 문구, 걱정 길이(5~300자), 예시 걱정 3종(시험·팀플·취업), 턴 규칙, 도움 안내 문구 |
| `POST /sessions` | `{ requestId, playerId, consent: true, store: true\|false }` | `consent`가 없으면 422 `CONSENT_REQUIRED`(FR-01). `store`는 대화 저장 동의(선택). 미동의 세션은 서버 디스크에 남지 않음 |
| `POST /sessions/:id/worry` | `{ requestId, worry }` 또는 `{ requestId, exampleId }` | 위험 판정(규칙 → AI) + 손님 생성(실패 시 1회 재시도, 또 실패하면 예시 손님) |
| `POST /sessions/:id/guest/reroll` | `{ requestId }` | 손님 다시 만들기, 1회까지(FR-03) |
| `POST /sessions/:id/start` | `{ requestId }` | 상담 시작. 1턴 = 손님 첫 대사 + 선택지 |
| `POST /sessions/:id/turn` | `{ requestId, turn, choiceId }` 또는 `{ requestId, turn, text }` | 플레이어 발화. `turn`은 화면에 보이는 지금 턴 번호(`view.turn.n`)이고, 지난 턴 번호면 409 `STALE_TURN`으로 거절(늦게 온 중복 입력 방지). `turn.input`이 `text`이면 직접 입력만 받음 |
| `POST /sessions/:id/end` | `{ requestId }` | 플레이어가 마무리(언제든). 하이라이트가 있으면 `mirror`, 없으면 `done` |
| `POST /sessions/:id/mirror` | `{ requestId, highlightId }` | 고른 하이라이트를 자기 지향 문장으로 변환·점검 |
| `POST /sessions/:id/decision` | `{ requestId, verdict, edited? }` | `verdict`: `accept`·`modify`·`hold`·`reject`. `edited`: 플레이어가 직접 고친 문장(선택) |
| `POST /sessions/:id/quit` | `{ requestId }` | 그만하기. 도움 안내(`help`) 상태에서는 안내를 그대로 둠 |
| `GET /sessions/:id` | — | 현재 상태 다시 받기(앱 재시작 등) |
| `DELETE /sessions/:id` | — | 세션과 그 카드를 모두 삭제(FR-11) |
| `GET /cards` | — | 저장 동의한 판의 반환 문장 카드 목록 |
| `DELETE /cards/:cardId` | — | 카드와 그 세션을 삭제 |

## 응답(view)의 주요 필드

```jsonc
{
  "id": "…", "stage": "counsel", "store": false,
  "ai": { "calls": 7, "cap": 60 },                    // 판당 AI 호출 수(NFR-08)
  "worry": "…",
  "guest": { "name": "…", "age": "…", "role": "…", "background": "…", "situation": "…", "source": "ai|example" },
  "canReroll": false,
  "turn": {                                           // stage가 counsel일 때
    "n": 3, "max": 12, "kind": "normal|advice",       // advice = 조언 요청 턴(3·6턴, 8턴까지 하이라이트가 없으면 8턴)
    "guest": "손님 대사",
    "choices": [{ "id": "t3c1", "text": "…" }],       // advice 턴에는 빈 배열
    "input": "choice_or_text|text",
    "suggestEnd": false                               // true면 손님이 마무리를 제안한 대사(6턴 이상 + 하이라이트 있음)
  },
  "transcript": [{ "n": 1, "guest": "…", "player": { "type": "choice|text", "text": "…" }, "highlighted": false }],
  "highlights": [{ "id": "h1", "turn": 3, "text": "플레이어가 직접 쓴 조언 원문" }],   // 기록장(FR-06)
  "mirrorOptions": [{ "id": "h1", "turn": 3, "guestBefore": "…", "text": "…", "guestAfter": "…" }],   // stage가 mirror일 때
  "mirror": { "worry": "…", "original": "…", "returned": "…|null", "shown": "self|original_only" },  // null이면 원문만 보여 줌(FR-08)
  "decision": { "verdict": "modify", "aiDraft": "…", "edited": "…", "final": "…" },
  "endReason": "player|auto|call_cap",
  "help": { "title": "…", "lines": ["자살예방상담전화 109 (24시간)", "…"] }            // stage가 help일 때
}
```

- 손님 카드의 핵심 갈등과 손님 머릿속 생각은 제작자 판정용이라 앱에 보내지 않습니다.
- 응답을 기다리는 동안에는 입력을 잠급니다(FR-04). 서버도 처리 중인 세션의 다른 요청은 `409 BUSY`로 거절합니다.

## 오류

| HTTP | code | 앱이 할 일 |
|---|---|---|
| 422 | (field·reason 포함) | 입력 안내. `reason`: `required`·`too_short`·`too_long`·`text_only` |
| 422 | `CONSENT_REQUIRED` | 동의 화면으로 |
| 409 | `BUSY` | 앞 요청 응답을 기다림 |
| 409 | `HELP_LOCKED` | 도움 안내 화면 유지 |
| 409 | `STALE_TURN` (`turn`: 지금 턴 번호) | 이미 처리된 입력. `GET /sessions/:id`로 화면 갱신 |
| 403 | `FORBIDDEN` | 다른 플레이어의 세션. 새 판 시작 |
| 409 | `WRONG_STAGE` | `GET /sessions/:id`로 현재 상태를 다시 받아 화면 갱신 |
| 409 | `REROLL_USED` | 다시 만들기 버튼 숨김 |
| 503 | `AI_RETRY` (`retryable: true`) | 입력한 내용을 그대로 두고 "다시 시도" 버튼. 상태는 바뀌지 않았음(FR-12). 상담 턴과 거울 장면 모두 해당 |
| 404 | `NOT_FOUND` | 새 판 시작 |

같은 `requestId`로 다시 보내면 저장된 결과를 그대로 돌려주고 `replayed: true`가 붙습니다. 실패한 요청은 저장하지 않아 같은 `requestId`로 다시 시도할 수 있습니다.

## 그 밖의 동작

- **위험 감지**: 걱정, 매 턴 발화, 비교·판단의 수정 문장에서 위험이 감지되면 `stage`가 `help`로 바뀝니다. 응답의 `help` 문구를 보여 주고 상담 화면으로 돌아가는 길을 두지 않습니다.
- **보관 기간**: 저장 동의한 세션과 카드는 `consent.retention_days`(지금 30일, 임시값)가 지나면 서버가 지웁니다.
- **미동의 세션**: 디스크에 쓰지 않고, 끝난 뒤(마무리·그만하기·도움 안내) 10분이 지나면 메모리에서도 지웁니다. 그 뒤 `GET`은 404입니다.
- **거울 장면 시간**: 변환·점검 호출 1회 제한은 5초, 최대 4회라 20초 안에 끝납니다(NFR-01).
