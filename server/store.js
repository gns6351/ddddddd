// 세션 기록 저장소: 세션당 JSON 파일 하나 (data/sessions/<id>.json)
import fs from 'node:fs/promises';
import path from 'node:path';

export function createStore(dataDir) {
  const dir = path.join(dataDir, 'sessions');
  const queues = new Map(); // 같은 세션 쓰기는 순서대로

  const fileOf = (id) => {
    if (!/^[a-f0-9-]{36}$/.test(String(id))) throw Object.assign(new Error('잘못된 세션 ID'), { status: 400 });
    return path.join(dir, `${id}.json`);
  };

  async function write(session) {
    await fs.mkdir(dir, { recursive: true });
    const file = fileOf(session.id);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(session, null, 2), 'utf8');
    await fs.rename(tmp, file);
  }

  async function get(id) {
    try {
      return JSON.parse(await fs.readFile(fileOf(id), 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  // mutator(session)가 세션을 직접 고친다. 던지면 저장하지 않는다.
  function update(id, mutator) {
    const prev = queues.get(id) || Promise.resolve();
    const next = prev.catch(() => {}).then(async () => {
      const session = await get(id);
      if (!session) throw Object.assign(new Error('세션을 찾을 수 없습니다'), { status: 404 });
      const result = await mutator(session);
      session.updatedAt = new Date().toISOString();
      await write(session);
      return result === undefined ? session : result;
    });
    queues.set(id, next);
    next.finally(() => { if (queues.get(id) === next) queues.delete(id); }).catch(() => {});
    return next;
  }

  async function list() {
    await fs.mkdir(dir, { recursive: true });
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json'));
    const all = await Promise.all(files.map((f) => get(f.slice(0, -5)).catch(() => null)));
    return all.filter(Boolean).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async function remove(id) {
    await fs.rm(fileOf(id), { force: true });
  }

  return { create: write, get, update, list, remove };
}
