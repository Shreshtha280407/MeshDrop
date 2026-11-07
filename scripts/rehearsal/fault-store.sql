-- OPERATOR REVIEW/INSTALL ONLY in a dedicated NON-PRODUCTION fault-test database.
-- Install recovery-postgres.sql there first. Never called by a runtime or workflow.
BEGIN;
CREATE SCHEMA meshdrop_rehearsal;
REVOKE ALL ON SCHEMA meshdrop_rehearsal FROM PUBLIC;
CREATE TABLE meshdrop_rehearsal.identity (
 singleton boolean PRIMARY KEY CHECK(singleton), store_id uuid NOT NULL,
 purpose text NOT NULL CHECK(purpose='fault-test-only'), environment text NOT NULL CHECK(environment='preview'),
 database_name name NOT NULL CHECK(database_name::text ~ '^meshdrop_rehearsal_[a-z0-9_]+$'),
 environment_id text NOT NULL CHECK(environment_id ~ '^[1-9][0-9]*$'),
 repository_id text NOT NULL CHECK(repository_id ~ '^[1-9][0-9]*$'), owner_id text NOT NULL CHECK(owner_id ~ '^[1-9][0-9]*$')
);
CREATE TABLE meshdrop_rehearsal.scopes(mode text PRIMARY KEY CHECK(mode IN ('replay','concurrency','lost-ack','reconnect','history-integrity')),scope_id text NOT NULL UNIQUE CHECK(scope_id ~ '^[a-f0-9]{64}$'));
REVOKE ALL ON ALL TABLES IN SCHEMA meshdrop_rehearsal FROM PUBLIC;

CREATE FUNCTION meshdrop_rehearsal.check_store(store uuid, env text, repo text, owner_pin text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,meshdrop_rehearsal,pg_temp AS $$
DECLARE i meshdrop_rehearsal.identity;
BEGIN
 SELECT * INTO STRICT i FROM meshdrop_rehearsal.identity WHERE singleton;
 IF i.store_id<>store OR i.environment_id<>env OR i.repository_id<>repo OR i.owner_id<>owner_pin OR
    i.database_name<>current_database() OR i.purpose<>'fault-test-only' OR i.environment<>'preview' OR
    current_database() !~ '^meshdrop_rehearsal_[a-z0-9_]+$' OR pg_is_in_recovery() OR
    NOT coalesce((SELECT ssl FROM pg_catalog.pg_stat_ssl WHERE pid=pg_backend_pid()),false) OR
    EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=session_user AND (rolsuper OR rolcreatedb OR rolcreaterole)) OR
    EXISTS(SELECT 1 FROM pg_catalog.pg_database WHERE datname=current_database() AND datdba=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=session_user)) OR
    EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname IN ('meshdrop_recovery','meshdrop_rehearsal') AND pg_has_role(session_user,nspowner,'MEMBER')) OR
    has_schema_privilege(session_user,'meshdrop_recovery','CREATE') OR has_schema_privilege(session_user,'meshdrop_rehearsal','CREATE') OR
    has_function_privilege(session_user,'meshdrop_recovery.append_event(uuid,text,text,jsonb)','EXECUTE') OR
    has_table_privilege(session_user,'meshdrop_recovery.events','INSERT,UPDATE,DELETE,TRUNCATE') OR
    has_table_privilege(session_user,'meshdrop_recovery.owners','INSERT,UPDATE,DELETE,TRUNCATE') OR
    NOT EXISTS(SELECT 1 FROM meshdrop_recovery.identity WHERE store_id=store) THEN
   RAISE EXCEPTION 'FAULT_STORE_ISOLATION_UNVERIFIED';
 END IF;
 RETURN jsonb_build_object('storeId',i.store_id,'environmentId',i.environment_id,'repositoryId',i.repository_id,'ownerId',i.owner_id,'purpose',i.purpose,'environment',i.environment,'database',i.database_name,'tls',true);
END $$;

CREATE FUNCTION meshdrop_rehearsal.append_probe(store uuid, env text, repo text, owner_pin text, event_text text, payload_text text, expected jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,meshdrop_rehearsal,pg_temp AS $$
DECLARE e jsonb; n integer; result jsonb; message text; constraint_id text;
BEGIN
 PERFORM meshdrop_rehearsal.check_store(store,env,repo,owner_pin);
 IF octet_length(event_text)>32768 OR octet_length(payload_text)>32768 THEN RAISE EXCEPTION 'FAULT_EVENT_LIMIT'; END IF;
 e:=event_text::jsonb; n:=(e->>'sequence')::int;
 IF e->>'environment' IS DISTINCT FROM 'preview' OR e->'approval' IS DISTINCT FROM 'null'::jsonb OR
    e->'record'->>'purpose' IS DISTINCT FROM 'trust-rehearsal-fault-test' OR e->'record'->>'state' IS DISTINCT FROM 'PREPARED' OR
    e->'record'->'publicationEnabled' IS DISTINCT FROM 'false'::jsonb OR e->'record'->'acceptanceEnabled' IS DISTINCT FROM 'false'::jsonb OR e->'record'->'productionApproved' IS DISTINCT FROM 'false'::jsonb OR
    e->'record'->'artifact'->'publicationEnabled' IS DISTINCT FROM 'false'::jsonb OR e->'record'->'artifact'->'acceptanceEnabled' IS DISTINCT FROM 'false'::jsonb OR e->'record'->'artifact'->'productionApproved' IS DISTINCT FROM 'false'::jsonb OR
    e->'record'->'artifact'->>'environment' IS DISTINCT FROM 'preview' OR
    e->'record'->'artifact'->>'repository' IS DISTINCT FROM 'https://github.com/Shreshtha280407/MeshDrop' OR
    e->'record'->'artifact'->>'purpose' IS DISTINCT FROM 'trust-rehearsal' OR
    e->'record'->'artifact'->>'workflow' IS DISTINCT FROM '.github/workflows/release-trust-rehearsal.yml' OR
    e->'record'->'artifact'->>'repositoryId' IS DISTINCT FROM repo OR e->'record'->'artifact'->>'ownerId' IS DISTINCT FROM owner_pin OR
    n IS NULL OR n NOT BETWEEN 0 AND 2 OR e->'record'->'sequence' IS DISTINCT FROM e->'sequence' OR
    e->'record'->>'phase' IS DISTINCT FROM (ARRAY['RESERVED','EVIDENCE','CLOSED'])[n+1] OR
    e->'record'->'evidenceId' IS DISTINCT FROM (CASE WHEN n=1 THEN e->'attemptId' ELSE 'null'::jsonb END) OR
    NOT EXISTS(SELECT 1 FROM meshdrop_rehearsal.scopes WHERE mode=e->'record'->>'mode' AND scope_id=e->>'scopeId') THEN
   RETURN jsonb_build_object('storeId',store,'outcome','REJECTED','code','FAULT_INVALID_RECORD');
 END IF;
 BEGIN
   result:=meshdrop_recovery.append_event(store,event_text,payload_text,expected);
   RETURN result || jsonb_build_object('outcome','APPENDED');
 EXCEPTION
   WHEN raise_exception THEN
     GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
     IF message IN ('ENVIRONMENT_ALREADY_OWNED','ENVIRONMENT_OWNERSHIP_CONFLICT','HEAD_CONFLICT','INVALID_START') THEN
       RETURN jsonb_build_object('storeId',store,'outcome','REJECTED','code',message);
     END IF;
     RAISE;
   WHEN unique_violation THEN
     GET STACKED DIAGNOSTICS constraint_id=CONSTRAINT_NAME;
     IF constraint_id IN ('attempts_attempt_id_key','events_pkey') THEN
       RETURN jsonb_build_object('storeId',store,'outcome','REJECTED','code','DUPLICATE_RECOVERY_IDENTIFIER');
     END IF;
     RAISE;
 END;
END $$;

CREATE FUNCTION meshdrop_rehearsal.read_attempt(store uuid, env text, repo text, owner_pin text, mode_pin text, attempt uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,meshdrop_rehearsal,pg_temp AS $$
DECLARE scope text;
BEGIN
 PERFORM meshdrop_rehearsal.check_store(store,env,repo,owner_pin);
 SELECT scope_id INTO STRICT scope FROM meshdrop_rehearsal.scopes WHERE mode=mode_pin;
 RETURN meshdrop_recovery.read_history(store,scope,attempt);
END $$;
REVOKE ALL ON FUNCTION meshdrop_rehearsal.check_store(uuid,text,text,text),meshdrop_rehearsal.append_probe(uuid,text,text,text,text,text,jsonb),meshdrop_rehearsal.read_attempt(uuid,text,text,text,text,uuid) FROM PUBLIC;
-- Administrator initializes identity, five pinned scopes, and exact role ACLs.
-- Writer: USAGE + EXECUTE append_probe/check_store/read_attempt, scoped append ACL.
-- Reader: USAGE + EXECUTE read_attempt/check_store, scoped read ACL. No table writes.
-- Do not grant runtime roles ownership, superuser, generic append or administrative rights.
COMMIT;
