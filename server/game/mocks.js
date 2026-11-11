// 거울상담소 모의(mock) AI 응답. 키 없이 화면·흐름·테스트를 돌릴 때 쓴다(내용은 의미 없음).
// 입력에 태그를 붙이면 경로를 시험할 수 있다:
//   걱정:  #guestbad(손님 생성 계속 실패 → 예시 손님) #guestbad1(첫 생성만 실패) #sameguest(다시 만들어도 같은 손님) #risk(위험)
//   발화:  #risk(위험) #notadvice #blame(조언 판정) #error(AI 오류) #slow(시간 초과) #banned(금지 표현이 섞인 대사) #fact(사실로 기억)
//   반환:  #mirrorfail(점검이 계속 실패 → 원문만) #mirrorfail1(첫 변환만 실패 → 재변환 통과)
const tags = (text) => new Set(String(text ?? '').match(/#\w+/g) || []);
const strip = (text) => String(text ?? '').replace(/#\w+/g, '').trim();
const fail = (t) => {
  if (t.has('#error')) throw Object.assign(new Error('mock error'), { status: 503 });
  if (t.has('#slow')) throw Object.assign(new Error('mock timeout'), { name: 'AbortError' });
};
const ATT = ['empathy', 'specify', 'explore'];
const choiceSet = (n, turn) => Array.from({ length: n }, (_, i) => ({ text: `(모의) ${turn}턴 ${['공감', '구체화', '탐색'][i]} 선택지`, attitude: ATT[i] }));

export const GAME_MOCKS = {
  g_guest({ worry, attempt, previous }) {
    const t = tags(worry);
    fail(t);
    if (t.has('#guestbad') || (t.has('#guestbad1') && attempt === 1)) return '{"name": "모';
    return JSON.stringify({
      name: previous && !t.has('#sameguest') ? '(모의) 서준' : '(모의) 하린', age: previous ? '24살' : '22살', role: '대학생', background: '(모의) 배경을 바꾼 손님이다.',
      situation: '(모의) 걱정과 비슷한 일을 겪고 있다.', core_conflict: '(모의) 걱정의 핵심 갈등을 그대로 가진다.',
      automatic_thought: '(모의) 나는 결국 안 될 거야.', opening: '(모의) 안녕하세요… 요즘 고민이 있어서 왔어요.',
      choices: choiceSet(3, 1),
    });
  },
  g_risk({ text }) {
    const t = tags(text);
    fail(t);
    return JSON.stringify({ risk: t.has('#risk') });
  },
  g_turn({ utterance, turn, choices }) {
    const t = tags(utterance);
    fail(t);
    const reply = t.has('#banned') ? `(모의) 이 방법이 효과가 있을까요? ${turn}턴` : `(모의) 손님의 ${turn}턴 대사예요.`;
    return JSON.stringify({ reply, choices: choiceSet(choices, turn), facts: t.has('#fact') ? [strip(utterance).slice(0, 60)] : [], player_risk: t.has('#risk') });
  },
  g_judge({ utterance }) {
    const t = tags(utterance);
    fail(t);
    const verdict = t.has('#risk') ? 'risk' : t.has('#blame') ? 'blame' : t.has('#notadvice') ? 'not_advice' : 'ok';
    return JSON.stringify({ verdict });
  },
  g_mirror({ advice, attempt }) {
    const t = tags(advice);
    fail(t);
    const body = strip(advice).replace(/네가|니가/g, '내가').replace(/너는|넌/g, '나는').replace(/당신/g, '나').replace(/(?<![가-힣])너(?![가-힣])/g, '나');
    const bad = t.has('#mirrorfail') || (t.has('#mirrorfail1') && attempt === 1);
    return JSON.stringify({ self: `(모의) ${body}${bad ? ' #reversal' : ''}` });
  },
  g_check(text) {
    const t = tags(text);
    const reversal = t.has('#reversal');
    return JSON.stringify({ reversal, addition: t.has('#addition'), forcing: t.has('#forcing'), note: reversal ? '(모의) 점검 실패' : '' });
  },
  g_context() { return JSON.stringify({ consistent: true, note: '' }); },
  // 테스트용 플레이어: 성향대로 움직이는 간단한 규칙
  g_player({ persona, view, step }) {
    if (!view) return JSON.stringify({ action: 'text', text: `(모의) ${persona.id} 플레이어의 걱정이에요. 요즘 계속 불안해요.${persona.risk ? ' 다 끝내고 싶어요 #risk' : ''}` });
    if (persona.end_after && step >= persona.end_after) return JSON.stringify({ action: 'end' });
    if (view.input === 'text' || (persona.text_rate >= 0.5 && step % 2 === 0)) {
      const text = persona.risk && step >= 3 ? '(모의) 나도 요즘 다 끝내고 싶어요 #risk' : persona.id === 'harsh' ? '(모의) 그건 결국 네 탓이야' : `(모의) ${persona.id}: 너무 걱정하지 말고 하나씩 해 봐.`;
      return JSON.stringify({ action: 'text', text });
    }
    return JSON.stringify({ action: 'choice', choice: step % Math.max(1, view.choices.length) });
  },
};
