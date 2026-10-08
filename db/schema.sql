-- 상담자 역할 게임 자기적용 시스템 v3.4: SQLite canonical schema
-- Invoke PRAGMA foreign_keys=ON for EVERY database connection.
-- State transitions (status_version compare-and-set, S4 final_request_id, urgent checks)
-- remain service-level invariants; DDL alone does not enforce them.
PRAGMA foreign_keys=ON;

CREATE TABLE enrollments (
 enrollment_id TEXT PRIMARY KEY,
 participant_code TEXT UNIQUE,
 s1_request_id TEXT UNIQUE,
 request_hash TEXT,
 session_id TEXT UNIQUE REFERENCES sessions(session_id) ON DELETE SET NULL,
 resume_secret_hash TEXT,
 token_created_at TEXT,
 token_expires_at TEXT,
 token_revoked_at TEXT,
 consumed_at TEXT
);

CREATE TABLE sessions (
 session_id TEXT PRIMARY KEY,
 participant_code TEXT UNIQUE,
 enrollment_id TEXT UNIQUE REFERENCES enrollments(enrollment_id) ON DELETE SET NULL,
 consented_at TEXT,
 consent_version TEXT,
 transfer_consent INTEGER CHECK(transfer_consent IN (0,1)),
 character_id TEXT,
 relevance INTEGER CHECK(relevance BETWEEN 1 AND 5),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','withdrawal_pending','deletion_pending','completed','no_experience','withdrawn','deleted_confirmed','safety_stop')),
 current_step TEXT NOT NULL DEFAULT 'S2' CHECK(current_step IN ('S1','S2','S3','S4','S5','S6','S7','S8','S9','S10','S11')),
 transform_outcome TEXT CHECK(transform_outcome IS NULL OR transform_outcome IN ('ok','not_advice','unsafe','blaming','fallback','safety_hold')),
 data_use TEXT CHECK(data_use IS NULL OR data_use IN ('delete','keep')),
 started_at TEXT,
 finished_at TEXT,
 withdrawal_from_step TEXT CHECK(withdrawal_from_step IS NULL OR withdrawal_from_step IN ('S1','S2','S3','S4','S5','S6','S7','S8','S9','S10','S11')),
 app_version TEXT,
 script_version TEXT,
 prompt_version TEXT,
 model_id TEXT,
 content_hash TEXT,
 terminated_at TEXT,
 status_version INTEGER NOT NULL DEFAULT 0 CHECK(status_version>=0),
 deletion_state TEXT CHECK(deletion_state IS NULL OR deletion_state IN ('pending','running','verify','confirmed','error'))
);

CREATE TABLE experience_checks (
 session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
 character_id TEXT NOT NULL,
 has_experience INTEGER NOT NULL CHECK(has_experience IN (0,1)),
 relevance INTEGER,
 checked_at TEXT NOT NULL,
 PRIMARY KEY (session_id, character_id),
 CHECK((has_experience=1 AND relevance BETWEEN 1 AND 5) OR (has_experience=0 AND relevance IS NULL))
);

CREATE TABLE dialogue (
 session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
 turn INTEGER NOT NULL CHECK(turn BETWEEN 1 AND 3),
 request_id TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 choice_id TEXT NOT NULL,
 choice_text TEXT NOT NULL,
 reply_text TEXT NOT NULL,
 fact_ids TEXT NOT NULL,
 response_json TEXT NOT NULL,
 ts TEXT NOT NULL,
 PRIMARY KEY (session_id, turn),
 UNIQUE (session_id, request_id)
);

CREATE TABLE transform_requests (
 session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
 attempt INTEGER NOT NULL CHECK(attempt IN (1,2)),
 request_id TEXT NOT NULL,
 advice_hash TEXT NOT NULL,
 advice_text TEXT NOT NULL,
 processing_state TEXT NOT NULL CHECK(processing_state IN ('pending','completed','cancelled')),
 outcome TEXT CHECK(outcome IS NULL OR outcome IN ('ok','not_advice','unsafe','blaming','fallback','safety_hold')),
 advice_validity TEXT NOT NULL DEFAULT 'unknown' CHECK(advice_validity IN ('valid','invalid','unknown')),
 safety_source TEXT NOT NULL DEFAULT 'none' CHECK(safety_source IN ('none','rule_pre','llm','rule_fallback','llm_partial','researcher')),
 unsafe_observed INTEGER NOT NULL DEFAULT 0 CHECK(unsafe_observed IN (0,1)),
 blaming_observed INTEGER NOT NULL DEFAULT 0 CHECK(blaming_observed IN (0,1)),
 cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1)),
 result_json TEXT,
 started_at TEXT NOT NULL,
 finished_at TEXT,
 failure_reason TEXT,
 PRIMARY KEY (session_id,attempt),
 UNIQUE (session_id,request_id)
);

CREATE TABLE llm_calls (
 session_id TEXT NOT NULL,
 attempt INTEGER NOT NULL CHECK(attempt IN (1,2)),
 try_no INTEGER NOT NULL CHECK(try_no IN (1,2)),
 request_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('reserved','dispatched','succeeded','failed','cancelled','unknown')),
 dispatch_intent_at TEXT,
 provider_response_at TEXT,
 input_json TEXT,
 raw_output TEXT,
 parsed_json TEXT,
 prompt_id TEXT,
 prompt_hash TEXT,
 model_id TEXT,
 safety_source TEXT NOT NULL DEFAULT 'none' CHECK(safety_source IN ('none','rule_pre','llm','rule_fallback','llm_partial','researcher')),
 unsafe_observed INTEGER NOT NULL DEFAULT 0 CHECK(unsafe_observed IN (0,1)),
 blaming_observed INTEGER NOT NULL DEFAULT 0 CHECK(blaming_observed IN (0,1)),
 rule_hits TEXT,
 latency_ms INTEGER CHECK(latency_ms IS NULL OR latency_ms>=0),
 failure_code TEXT,
 ts TEXT NOT NULL,
 PRIMARY KEY (session_id,attempt,try_no),
 FOREIGN KEY (session_id,attempt) REFERENCES transform_requests(session_id,attempt) ON DELETE CASCADE
);

CREATE TABLE step_responses (
 session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
 step TEXT NOT NULL CHECK(step IN ('S4','S5','S6','S7','S8','S9','S10')),
 request_id TEXT,
 request_hash TEXT,
 data_json TEXT NOT NULL,
 entered_at TEXT,
 submitted_at TEXT NOT NULL,
 PRIMARY KEY (session_id,step)
);

CREATE TABLE events (
 session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
 event_id TEXT NOT NULL,
 type TEXT NOT NULL,
 payload_json TEXT NOT NULL,
 client_ts TEXT,
 server_ts TEXT NOT NULL,
 PRIMARY KEY (session_id,event_id)
);

CREATE TABLE coding_scores (
 session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
 item_id TEXT NOT NULL,
 measure TEXT NOT NULL CHECK(measure IN ('reexam','self_app','advice_quality','error')),
 coder TEXT NOT NULL CHECK(coder IN ('1','2','final')),
 value_json TEXT NOT NULL,
 ts TEXT NOT NULL,
 PRIMARY KEY (session_id,item_id,measure,coder)
);

CREATE TABLE deletion_jobs (
 job_id TEXT PRIMARY KEY,
 receipt_hash TEXT UNIQUE, -- SHA-256 hex of client-generated 256-bit secret; never store plaintext
 receipt_expires_at TEXT, -- confirmation timestamp + 24 hours, then clear receipt_hash
 session_id TEXT NOT NULL UNIQUE REFERENCES sessions(session_id) ON DELETE CASCADE,
 phase TEXT NOT NULL CHECK(phase IN ('pending','running','verify','confirmed','error')),
 requested_at TEXT NOT NULL,
 last_attempt_at TEXT,
 retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count>=0),
 confirmation_at TEXT,
 failure_code TEXT,
 output_manifest_hash TEXT,
 CHECK(receipt_hash IS NULL OR length(receipt_hash)=64),
 CHECK(phase = 'confirmed' OR receipt_hash IS NOT NULL)
);

CREATE TABLE analysis_runs (
 run_id TEXT PRIMARY KEY,
 dataset_hash TEXT NOT NULL,
 tool_version_hash TEXT NOT NULL,
 frozen_hash TEXT NOT NULL,
 member_manifest_path TEXT,
 status TEXT NOT NULL CHECK(status IN ('valid','invalid','rebuild_required')),
 created_at TEXT NOT NULL,
 invalidated_at TEXT,
 output_manifest_hash TEXT
);

CREATE TABLE stats (
 run_id TEXT NOT NULL REFERENCES analysis_runs(run_id) ON DELETE CASCADE,
 rq TEXT NOT NULL,
 metric TEXT NOT NULL,
 "group" TEXT NOT NULL DEFAULT '',
 value TEXT,
 exploratory INTEGER NOT NULL DEFAULT 0 CHECK(exploratory IN (0,1)),
 run_at TEXT NOT NULL,
 analysis_plan_version TEXT NOT NULL,
 dataset_hash TEXT NOT NULL,
 tool_hash TEXT NOT NULL,
 output_hash TEXT,
 invalidated_at TEXT,
 PRIMARY KEY (run_id,rq,metric,"group")
);

CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_transform_session_state ON transform_requests(session_id, processing_state);
CREATE INDEX idx_llm_calls_status ON llm_calls(status);
CREATE INDEX idx_analysis_status ON analysis_runs(status);
CREATE INDEX idx_deletion_phase ON deletion_jobs(phase);
