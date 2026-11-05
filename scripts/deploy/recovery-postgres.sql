-- REVIEW/INSTALL ONLY into a dedicated, separately authorized evidence database.
-- Not called by application/deployment code. Tests use a disposable local server.
BEGIN;
CREATE SCHEMA meshdrop_recovery;
REVOKE ALL ON SCHEMA meshdrop_recovery FROM PUBLIC;
CREATE TABLE meshdrop_recovery.identity (singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton), store_id uuid NOT NULL);
-- The operator must INSERT the independently pinned store UUID after installation.
CREATE TABLE meshdrop_recovery.access (scope_id text NOT NULL CHECK (scope_id ~ '^[a-f0-9]{64}$'), role_name name NOT NULL, can_append boolean NOT NULL, PRIMARY KEY (scope_id,role_name));
CREATE TABLE meshdrop_recovery.owners (scope_id text PRIMARY KEY, attempt_id uuid NOT NULL);
CREATE TABLE meshdrop_recovery.attempts (scope_id text NOT NULL, attempt_id uuid NOT NULL UNIQUE, manifest_id text NOT NULL, source_commit text NOT NULL, environment text NOT NULL CHECK (environment IN ('preview','production')), sequence integer NOT NULL, hash text NOT NULL, PRIMARY KEY(scope_id,attempt_id));
CREATE TABLE meshdrop_recovery.events (scope_id text NOT NULL, attempt_id uuid NOT NULL, sequence integer NOT NULL, hash text NOT NULL, payload text NOT NULL, PRIMARY KEY(scope_id,attempt_id,sequence));
CREATE TABLE meshdrop_recovery.approvals (approval_id uuid PRIMARY KEY, scope_id text NOT NULL, attempt_id uuid NOT NULL, digest text NOT NULL);
REVOKE ALL ON ALL TABLES IN SCHEMA meshdrop_recovery FROM PUBLIC;

CREATE FUNCTION meshdrop_recovery.append_event(store uuid, event_text text, payload_text text, expected jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, meshdrop_recovery, pg_temp AS $$
DECLARE e jsonb; o meshdrop_recovery.attempts; owner_attempt uuid; inserted integer;
BEGIN
  PERFORM set_config('synchronous_commit','on',true);
  IF NOT EXISTS (SELECT 1 FROM meshdrop_recovery.identity WHERE store_id=store) OR
     current_setting('fsync') <> 'on' OR current_setting('full_page_writes') <> 'on' THEN
    RAISE EXCEPTION 'STORE_IDENTITY_OR_DURABILITY_UNVERIFIED';
  END IF;
  IF octet_length(event_text)>262144 OR octet_length(payload_text)>262144 THEN RAISE EXCEPTION 'EVENT_LIMIT'; END IF;
  e := event_text::jsonb;
  IF NOT (e ?& ARRAY['schemaVersion','scopeId','attemptId','manifestId','environment','sourceCommit','sequence','previousHash','kind','record','approval','hash']) OR
     (e->>'sequence')::int NOT BETWEEN 0 AND 9999 OR e->>'kind' NOT IN ('START','CHECKPOINT','APPROVAL_CHECKED','APPROVAL_REJECTED') THEN RAISE EXCEPTION 'INVALID_EVENT'; END IF;
  IF e->>'schemaVersion' <> '1' OR e->>'scopeId' !~ '^[a-f0-9]{64}$' OR
     e->>'manifestId' !~ '^[a-f0-9]{64}$' OR e->>'sourceCommit' !~ '^[a-f0-9]{40}$' OR
     e->>'hash' <> encode(sha256(convert_to(payload_text,'UTF8')),'hex') OR
     (payload_text::jsonb || jsonb_build_object('hash',e->>'hash')) <> e THEN RAISE EXCEPTION 'INVALID_EVENT'; END IF;
  IF NOT EXISTS (SELECT 1 FROM meshdrop_recovery.access WHERE scope_id=e->>'scopeId' AND role_name=session_user AND can_append) THEN RAISE EXCEPTION 'SCOPE_ACCESS_DENIED'; END IF;
  IF expected IS NULL THEN
    IF e->>'kind'<>'START' OR (e->>'sequence')::int<>0 OR e->>'previousHash' IS NOT NULL OR e->'approval'<>'null'::jsonb OR e->'record'->>'state'<>'PREPARED' OR (e->'record'->>'sequence')::int<>0 THEN RAISE EXCEPTION 'INVALID_START'; END IF;
    INSERT INTO meshdrop_recovery.owners VALUES(e->>'scopeId',(e->>'attemptId')::uuid) ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS inserted=ROW_COUNT;
    IF inserted<>1 THEN RAISE EXCEPTION 'ENVIRONMENT_ALREADY_OWNED'; END IF;
    INSERT INTO meshdrop_recovery.attempts VALUES(e->>'scopeId',(e->>'attemptId')::uuid,e->>'manifestId',e->>'sourceCommit',e->>'environment',-1,'');
  END IF;
  SELECT attempt_id INTO STRICT owner_attempt FROM meshdrop_recovery.owners WHERE scope_id=e->>'scopeId' FOR UPDATE;
  IF owner_attempt<>(e->>'attemptId')::uuid THEN RAISE EXCEPTION 'ENVIRONMENT_OWNERSHIP_CONFLICT'; END IF;
  SELECT * INTO STRICT o FROM meshdrop_recovery.attempts WHERE scope_id=e->>'scopeId' AND attempt_id=owner_attempt FOR UPDATE;
  IF o.attempt_id<>(e->>'attemptId')::uuid OR o.manifest_id<>e->>'manifestId' OR o.source_commit<>e->>'sourceCommit' OR o.environment<>e->>'environment' OR
    (expected IS NOT NULL AND (expected<>jsonb_build_object('scopeId',o.scope_id,'attemptId',o.attempt_id,'sequence',o.sequence,'hash',o.hash) OR e->>'previousHash'<>o.hash OR (e->>'sequence')::int<>o.sequence+1 OR e->>'kind'='START')) THEN RAISE EXCEPTION 'HEAD_CONFLICT'; END IF;
  IF e->'approval'<>'null'::jsonb THEN
    INSERT INTO meshdrop_recovery.approvals VALUES((e->'approval'->>'approvalId')::uuid,o.scope_id,o.attempt_id,e->'approval'->>'digest');
  END IF;
  INSERT INTO meshdrop_recovery.events VALUES(o.scope_id,o.attempt_id,(e->>'sequence')::int,e->>'hash',event_text);
  UPDATE meshdrop_recovery.attempts SET sequence=(e->>'sequence')::int,hash=e->>'hash' WHERE scope_id=o.scope_id AND attempt_id=o.attempt_id;
  RETURN jsonb_build_object('storeId',store,'head',jsonb_build_object('scopeId',o.scope_id,'attemptId',o.attempt_id,'sequence',(e->>'sequence')::int,'hash',e->>'hash'));
END $$;

CREATE FUNCTION meshdrop_recovery.read_history(store uuid, scope text, attempt uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, meshdrop_recovery, pg_temp AS $$
DECLARE o meshdrop_recovery.attempts; history jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM meshdrop_recovery.identity WHERE store_id=store) THEN RAISE EXCEPTION 'STORE_IDENTITY_MISMATCH'; END IF;
  IF NOT EXISTS (SELECT 1 FROM meshdrop_recovery.access WHERE scope_id=scope AND role_name=session_user) THEN RAISE EXCEPTION 'SCOPE_ACCESS_DENIED'; END IF;
  SELECT * INTO STRICT o FROM meshdrop_recovery.attempts WHERE scope_id=scope AND attempt_id=attempt;
  IF o.sequence>9999 THEN RAISE EXCEPTION 'HISTORY_LIMIT'; END IF;
  SELECT jsonb_agg(payload::jsonb ORDER BY sequence) INTO history FROM meshdrop_recovery.events WHERE scope_id=scope AND attempt_id=attempt;
  RETURN jsonb_build_object('storeId',store,'head',jsonb_build_object('scopeId',scope,'attemptId',attempt,'sequence',o.sequence,'hash',o.hash),'events',history);
END $$;
REVOKE ALL ON FUNCTION meshdrop_recovery.append_event(uuid,text,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION meshdrop_recovery.read_history(uuid,text,uuid) FROM PUBLIC;
-- Owner stays a protected administrator. Grant named login roles USAGE on schema
-- and EXECUTE on only the required functions; never table writes or ownership.
-- Populate access with exact scope/role bindings. No default grants/credentials.
COMMIT;
