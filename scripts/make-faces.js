// 캐릭터 표정 이미지(초안) 만들기: content/scenarios/<id>/faces/<표정>.svg
//   node scripts/make-faces.js
// 단순한 도형으로 직접 그린 자체 제작 그림이다(기존 캐릭터를 본뜨지 않음). 같은 이름의 .svg 파일로 바꿔 넣으면 그대로 쓰인다.
// 표정: neutral(기본) anxious(불안) sad(슬픔) hesitant(망설임) softened(조금 누그러짐) — 활짝 웃는 표정은 만들지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../server/config.js';

const PEOPLE = {
  'A-job': { skin: '#f3d3b8', hair: '#3b2a20', shirt: '#6f8fbf', style: 'bob' },
  'B-refusal': { skin: '#e9c39f', hair: '#26221f', shirt: '#7ea67a', style: 'short', glasses: true },
  'C-perfection': { skin: '#f5dac6', hair: '#5b3b2b', shirt: '#c78a9b', style: 'long' },
};

const HAIR = {
  bob: { back: 'M24 60 Q22 22 60 20 Q98 22 96 60 L96 82 Q90 86 84 80 L84 56 L36 56 L36 80 Q30 86 24 82 Z', front: 'M28 52 Q30 24 60 24 Q90 24 92 52 Q78 40 62 42 Q46 40 28 52 Z' },
  short: { back: 'M28 54 Q26 24 60 22 Q94 24 92 54 Z', front: 'M28 50 Q32 24 60 24 Q88 24 92 50 Q84 38 70 38 Q56 34 44 40 Q34 42 28 50 Z' },
  long: { back: 'M22 62 Q20 20 60 18 Q100 20 98 62 L100 104 L20 104 Z', front: 'M26 54 Q28 22 60 22 Q92 22 94 54 Q86 36 60 36 Q40 36 26 54 Z' },
};

const FACES = {
  neutral: { brows: ['M41 47 L53 47', 'M67 47 L79 47'], eyes: 'dots', mouth: 'M52 75 Q60 77 68 75' },
  anxious: { brows: ['M41 48 L53 44', 'M67 44 L79 48'], eyes: 'wide', mouth: 'M51 76 q4.5 -3 9 0 q4.5 3 9 0', sweat: true },
  sad: { brows: ['M41 49 L53 43', 'M67 43 L79 49'], eyes: 'low', mouth: 'M52 78 Q60 71 68 78' },
  hesitant: { brows: ['M41 47 L53 47', 'M67 44 Q73 42 79 45'], eyes: 'aside', mouth: 'M53 76 L66 74' },
  softened: { brows: ['M41 47 Q47 46 53 47', 'M67 47 Q73 46 79 47'], eyes: 'dots', mouth: 'M53 75 Q60 77.5 67 75' },
};

function eyes(kind) {
  const ink = '#2b2420';
  switch (kind) {
    case 'wide': return `<circle cx="47" cy="58" r="3.6" fill="${ink}"/><circle cx="73" cy="58" r="3.6" fill="${ink}"/>`;
    case 'low': return `<ellipse cx="47" cy="59" rx="3.2" ry="2" fill="${ink}"/><ellipse cx="73" cy="59" rx="3.2" ry="2" fill="${ink}"/>`;
    case 'aside': return `<circle cx="45.5" cy="58" r="3" fill="${ink}"/><circle cx="71.5" cy="58" r="3" fill="${ink}"/>`;
    case 'soft': return `<path d="M43.5 58.5 q3.5 -3 7 0" stroke="${ink}" stroke-width="2.2" fill="none" stroke-linecap="round"/><path d="M69.5 58.5 q3.5 -3 7 0" stroke="${ink}" stroke-width="2.2" fill="none" stroke-linecap="round"/>`;
    default: return `<circle cx="47" cy="58" r="3" fill="${ink}"/><circle cx="73" cy="58" r="3" fill="${ink}"/>`;
  }
}

function svg(p, f, label) {
  const hair = HAIR[p.style];
  const ink = '#2b2420';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" role="img" aria-label="${label}">
  <rect width="120" height="120" rx="24" fill="#eef0f4"/>
  <path d="${hair.back}" fill="${p.hair}"/>
  <path d="M22 120 Q24 92 60 90 Q96 92 98 120 Z" fill="${p.shirt}"/>
  <rect x="52" y="80" width="16" height="14" rx="6" fill="${p.skin}"/>
  <ellipse cx="60" cy="58" rx="31" ry="33" fill="${p.skin}"/>
  <path d="${hair.front}" fill="${p.hair}"/>
  ${f.brows.map((d) => `<path d="${d}" stroke="${ink}" stroke-width="2.4" fill="none" stroke-linecap="round"/>`).join('')}
  ${eyes(f.eyes)}
  ${p.glasses ? `<g stroke="${ink}" stroke-width="1.8" fill="none"><circle cx="47" cy="58" r="8"/><circle cx="73" cy="58" r="8"/><path d="M55 58 L65 58"/></g>` : ''}
  <path d="${f.mouth}" stroke="${ink}" stroke-width="2.4" fill="none" stroke-linecap="round"/>
  ${f.sweat ? '<path d="M86 40 q-4 7 0 9 q4 -2 0 -9 Z" fill="#9cc8e8"/>' : ''}
</svg>
`;
}

const LABEL = { neutral: '기본 표정', anxious: '불안한 표정', sad: '슬픈 표정', hesitant: '망설이는 표정', softened: '조금 누그러진 표정' };
for (const [id, p] of Object.entries(PEOPLE)) {
  const dir = path.join(ROOT, 'content', 'scenarios', id, 'faces');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, f] of Object.entries(FACES)) fs.writeFileSync(path.join(dir, `${name}.svg`), svg(p, f, LABEL[name]));
}
console.log('표정 이미지를 만들었어요: content/scenarios/*/faces/*.svg');
