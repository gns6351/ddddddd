// T43: DDL 12개 테이블, foreign_key_check=0, 의도된 제약 위반 거부
const { openDb } = require('../../core/db');

describe('T43 schema_v3.4 DDL', () => {
  const db = openDb(':memory:');
  const ins = (sql, ...a) => () => db.prepare(sql).run(...a);

  it('12 tables, FK on, check clean', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
    expect(tables).toEqual(['analysis_runs', 'coding_scores', 'deletion_jobs', 'dialogue', 'enrollments', 'events', 'experience_checks', 'llm_calls', 'sessions', 'stats', 'step_responses', 'transform_requests']);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('secure_delete', { simple: true })).toBe(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('rejects enum/CHECK/UNIQUE/FK violations', () => {
    db.prepare("INSERT INTO sessions(session_id, participant_code) VALUES ('s1','P1')").run();
    expect(ins("INSERT INTO sessions(session_id,status) VALUES ('s2','bogus')")).toThrow(/CHECK/);
    expect(ins("INSERT INTO sessions(session_id,current_step) VALUES ('s3','S12')")).toThrow(/CHECK/);
    expect(ins("INSERT INTO sessions(session_id,participant_code) VALUES ('s4','P1')")).toThrow(/UNIQUE/);
    // DDL 한계(B29): has_experience=1 + relevance NULL은 SQLite CHECK의 NULL 통과 규칙상 DB가 거부하지 못함 → 서비스 계층 422로 보증
    expect(ins("INSERT INTO experience_checks VALUES ('s1','A',1,NULL,'t')")).not.toThrow();
    db.prepare("DELETE FROM experience_checks").run();
    expect(ins("INSERT INTO experience_checks VALUES ('s1','A',1,6,'t')")).toThrow(/CHECK/);
    expect(ins("INSERT INTO experience_checks VALUES ('s1','A',0,3,'t')")).toThrow(/CHECK/);
    expect(ins("INSERT INTO experience_checks VALUES ('nope','A',0,NULL,'t')")).toThrow(/FOREIGN KEY/);
    expect(ins("INSERT INTO dialogue VALUES ('s1',4,'r','h','c','t','r','[]','{}','t')")).toThrow(/CHECK/);
    expect(ins("INSERT INTO transform_requests(session_id,attempt,request_id,advice_hash,advice_text,processing_state,started_at) VALUES ('s1',3,'r','h','a','pending','t')")).toThrow(/CHECK/);
    db.prepare("INSERT INTO transform_requests(session_id,attempt,request_id,advice_hash,advice_text,processing_state,started_at) VALUES ('s1',1,'r1','h','a','pending','t')").run();
    expect(ins("INSERT INTO transform_requests(session_id,attempt,request_id,advice_hash,advice_text,processing_state,started_at) VALUES ('s1',2,'r1','h','a','pending','t')")).toThrow(/UNIQUE/);
    expect(ins("INSERT INTO llm_calls(session_id,attempt,try_no,request_id,status,ts) VALUES ('s1',2,1,'r','reserved','t')")).toThrow(/FOREIGN KEY/);
    expect(ins("INSERT INTO llm_calls(session_id,attempt,try_no,request_id,status,ts) VALUES ('s1',1,3,'r','reserved','t')")).toThrow(/CHECK/);
    expect(ins("INSERT INTO llm_calls(session_id,attempt,try_no,request_id,status,ts) VALUES ('s1',1,1,'r','sent','t')")).toThrow(/CHECK/);
    expect(ins("INSERT INTO step_responses(session_id,step,data_json,submitted_at) VALUES ('s1','S3','{}','t')")).toThrow(/CHECK/);
    expect(ins("INSERT INTO deletion_jobs(job_id,receipt_hash,session_id,phase,requested_at) VALUES ('j','abc','s1','pending','t')")).toThrow(/CHECK/);
    expect(ins("INSERT INTO deletion_jobs(job_id,receipt_hash,session_id,phase,requested_at) VALUES ('j','"+ 'a'.repeat(64) +"','s1','done','t')")).toThrow(/CHECK/);
    expect(ins("INSERT INTO coding_scores VALUES ('s1','i','reexam','3','{}','t')")).toThrow(/CHECK/);
    expect(ins("INSERT INTO analysis_runs VALUES ('r','d','t','f',NULL,'ok','t',NULL,NULL)")).toThrow(/CHECK/);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('cascade delete removes dependents (llm_calls via transform_requests)', () => {
    db.prepare("INSERT INTO llm_calls(session_id,attempt,try_no,request_id,status,ts) VALUES ('s1',1,1,'r1','reserved','t')").run();
    db.prepare("DELETE FROM sessions WHERE session_id='s1'").run();
    expect(db.prepare('SELECT count(*) c FROM llm_calls').get().c).toBe(0);
    expect(db.prepare('SELECT count(*) c FROM transform_requests').get().c).toBe(0);
  });
});
