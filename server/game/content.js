// 게임 콘텐츠(content/game/)와 게임 전용 프롬프트(content/prompts/game/) 읽기. 요청마다 읽어 수정이 바로 반영된다.
import fs from 'node:fs';
import path from 'node:path';
import { loadPrompt, sha } from '../config.js';

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

export function loadGameContent(contentDir) {
  const dir = path.join(contentDir, 'game');
  const game = readJson(path.join(dir, 'game.json'));
  const examples = readJson(path.join(dir, 'guests', 'examples.json')).guests;
  const rules = readJson(path.join(dir, 'safety', 'rules.json'));
  return { game, examples, rules, hash: sha(JSON.stringify([game, examples, rules])) };
}

export const loadSimContent = (contentDir) => readJson(path.join(contentDir, 'game', 'sim', 'personas.json'));
export const loadRiskCases = (contentDir) => readJson(path.join(contentDir, 'game', 'tests', 'risk-cases.json'));

// 게임 프롬프트: kind = guest | turn | judge | mirror | check | risk | player
export const GAME_PROMPTS = ['guest', 'turn', 'judge', 'mirror', 'check', 'risk', 'player'];
export function loadGamePrompts(contentDir, version) {
  return Object.fromEntries(GAME_PROMPTS.map((k) => [k, loadPrompt(contentDir, path.join('game', k), version)]));
}
