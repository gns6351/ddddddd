// 게임 세션 저장소
//   - 모든 세션은 메모리에 둔다. 저장 동의(consent.store)한 세션만 data/game/sessions/<id>.json에 쓴다(FR-01, NFR-04).
//   - 미동의 세션은 끝나면(done·quit·help) 10분 뒤, 진행 중이면 마지막 사용 후 ttl이 지나면 메모리에서도 지운다.
//   - 반환 문장 카드는 저장 동의 시에만 data/game/cards/<playerId>.json에 보관한다(FR-11).
//   - 일반 로그(data/game/logs/calls-날짜.jsonl)에는 원문 없이 호출 메타데이터만 쓴다(NFR-04, NFR-08).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const ID = /^[a-f0-9-]{36}$/;
const PLAYER = /^[A-Za-z0-9_-]{6,64}$/;

export function createGameStore(dataDir, { ttlMinutes = 120, endedGraceMinutes = 10 } = {}) {
  const root = path.join(dataDir, 'game');
  const sessDir = path.join(root, 'sessions');
  const cardDir = path.join(root, 'cards');
  const logDir = path.join(root, 'logs');
  const mem = new Map();

  const file = (id) => path.join(sessDir, `${id}.json`);
  async function writeJson(f, data) {
    await fsp.mkdir(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
    await fsp.rename(tmp, f);
  }

  async function get(id) {
    if (!ID.test(String(id))) return null;
    if (mem.has(id)) { const s = mem.get(id); s._touched = Date.now(); return s; }
    try {
      const s = JSON.parse(await fsp.readFile(file(id), 'utf8'));
      mem.set(id, Object.assign(s, { _touched: Date.now() }));
      return s;
    } catch { return null; }
  }

  async function save(s) {
    s.updatedAt = new Date().toISOString();
    s._touched = Date.now();
    mem.set(s.id, s);
    if (s.consent.store) {
      const { _touched, ...data } = s;
      await writeJson(file(s.id), data);
    }
  }

  async function remove(id) {
    const s = await get(id);
    mem.delete(id);
    await fsp.rm(file(id), { force: true });
    if (s?.cardId) await removeCard(s.playerId, s.cardId);
    return !!s;
  }

  // ---- 카드 ----
  const cardFile = (playerId) => path.join(cardDir, `${playerId}.json`);
  async function cards(playerId) {
    if (!PLAYER.test(String(playerId))) return [];
    try { return JSON.parse(await fsp.readFile(cardFile(playerId), 'utf8')).cards; } catch { return []; }
  }
  async function addCard(card) {
    const list = await cards(card.playerId);
    list.push(card);
    await writeJson(cardFile(card.playerId), { cards: list });
  }
  async function removeCard(playerId, cardId) {
    const list = await cards(playerId);
    const next = list.filter((c) => c.id !== cardId);
    if (next.length !== list.length) await writeJson(cardFile(playerId), { cards: next });
    return next.length !== list.length;
  }

  // ---- 일반 로그 (원문 없음) ----
  function log(entry) {
    try {
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(path.join(logDir, `calls-${new Date().toISOString().slice(0, 10)}.jsonl`), `${JSON.stringify(entry)}\n`);
    } catch { /* 로그를 못 써도 게임은 계속 */ }
  }

  // 메모리 정리. 끝난 미동의 세션(done·quit·help)은 마지막 화면을 다시 받을 시간(endedGraceMinutes)만 두고 지운다(FR-01).
  // 동의 세션은 파일에 있으니 오래 안 쓰면 메모리에서만 비운다.
  const ENDED = new Set(['done', 'quit', 'help']);
  function sweep(now = Date.now()) {
    for (const [id, s] of mem) {
      const idle = now - (s._touched || 0);
      if (!s.consent.store && ENDED.has(s.stage) && idle > endedGraceMinutes * 60_000) mem.delete(id);
      else if (idle > ttlMinutes * 60_000) mem.delete(id);
    }
  }
  const timer = setInterval(sweep, 60_000);
  timer.unref?.();

  return { get, save, remove, cards, addCard, removeCard, log, sweep, logDir, memSize: () => mem.size, isPlayerId: (p) => PLAYER.test(String(p)) };
}
