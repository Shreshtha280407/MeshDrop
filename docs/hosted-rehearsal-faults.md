# Task 10 hosted rehearsal with optional fault tests

**This procedure does not authorize deployment, publication, acceptance or rollback.**

Task 10B implements local infrastructure only. It starts from clean main at
`068789cd32a8a7ee1c0086cf2c6f7ccdc3ab0467`. No hosted workflow was run, settings
changed or external database contacted during implementation. Its changes remain
uncommitted until separately reviewed and authorized. A future hosted run must
select the reviewed commit that actually contains these changes, not silently
reuse the older baseline SHA.

## What is implemented versus external

The original `inspect → produce → recover` path remains available with
`fault_tests: false`. With `fault_tests: true`, the workflow requires preview
and adds `faults → attest-faults`. The database-writing fault job has only
contents/actions read permissions. A separate signing job has OIDC/attestation
write permissions and receives no database passwords.

All action references are exact commits. The workflow is manual-dispatch only;
environment-scoped concurrency has cancellation disabled. It invokes only
dependency installation with lifecycle scripts disabled, the fixed rehearsal
CLI commands, and the pinned evidence/attestation actions. Normal CI tests these
boundaries without running a hosted rehearsal. No deployment alias or provider
mutation module is reachable through the reviewed rehearsal import graph.

GitHub environment protection, authorized reviewers, root/tool pins, database
provisioning, restricted roles, retention/backups and a real independent witness
are operator configuration. YAML, booleans, hashes and local fixtures do not
establish those hosted guarantees.

## 1. Human GitHub configuration

Use Settings → Environments to create/review `trust-rehearsal-preview` only for
the first run. Record its numeric ID. Configure authorized **direct user**
reviewers, prevent self-review and restrict selected branch/tag rules to the
reviewed main ref. Review administrative bypass settings. A different human
must review the dispatch; do not weaken this guard if no reviewer is available.

Independently confirm repository and owner numeric IDs. Task 10's public API
observed repository `1421237057`, owner `225167798`; those observations alone are
not operator authorization. Expected workflow path is
`.github/workflows/release-trust-rehearsal.yml`.

Retain the Task 09 repository variables documented in
[the base runbook](hosted-trust-rehearsal.md): repository/owner/environment IDs,
reviewer IDs, roots, root hash/review window, reviewed `gh` path/hash and normal
`REHEARSAL_DATABASES_JSON`. Public roots are JSONL, preserved byte-for-byte;
review validity is at most seven days. Never use `tests/fixtures` roots as a
production/operator trust configuration. Verification never refreshes roots or
downloads tools automatically.

Add repository variable `REHEARSAL_FAULT_DATABASE_JSON` for the separate
non-production fault store. Its exact fields are:

```json
{
  "environment": "preview",
  "environmentName": "trust-rehearsal-preview",
  "environmentId": "ACTUAL_PREVIEW_ENVIRONMENT_ID",
  "rehearsalOnly": true,
  "host": "reviewed-test-database.example",
  "port": 5432,
  "database": "meshdrop_rehearsal_REPLACE_WITH_REVIEWED_LOWERCASE_NAME",
  "user": "reviewed_fault_writer",
  "readerUser": "reviewed_fault_reader",
  "caPem": "EXACT_REVIEWED_PUBLIC_CA_CERTIFICATE_PEM",
  "caSha256": "SHA256_OF_EXACT_CA_BYTES",
  "storeId": "INDEPENDENTLY_PINNED_STORE_UUID",
  "psqlPath": "/absolute/path/to/reviewed/psql",
  "psqlSha256": "SHA256_OF_THAT_EXECUTABLE"
}
```

Placeholders are deliberately invalid. No password belongs in this JSON. Only
the public CA certificate is allowed, never its private key. The database name
must match `^meshdrop_rehearsal_[a-z0-9_]+$`. Host, port, names, UUID and binary
hashes are explicit; there are no defaults or local fallbacks.

Add only these dedicated environment secrets:

- `REHEARSAL_DB_PASSWORD`: existing normal rehearsal writer.
- `REHEARSAL_FAULT_DB_PASSWORD`: dedicated fault writer.
- `REHEARSAL_FAULT_DB_READER_PASSWORD`: separate fault reader.

Do not add Cloudflare, production database, TURN or deployment secrets. Never
paste a password into chat or put it in source control. The fault passwords
are exposed only to the `fault-test all` step, not either signing job.

If production rehearsal identities are separately configured, preserve their
non-secret environment ID in `TRUST_REHEARSAL_PRODUCTION_ENVIRONMENT_ID` and
database/store identity in `REHEARSAL_DATABASES_JSON.production`. Fault mode
rejects matching identities before connecting. These are deny pins, not a reason
to configure or access production during this task.

## 2. Human database configuration — separate authorization

Provision a fresh dedicated **non-production** fault database with no user data.
Use a database name matching the enforced prefix, TLS `verify-full`, a reviewed
hostname/CA and an independently pinned store UUID. Use a protected administrator
as schema owner. Document retention, backups, restore procedure and the actual
provider durability guarantees; local SQL tests cannot certify hosted backups.

The administrator must review and install, in that fault database only:

1. `scripts/deploy/recovery-postgres.sql` — existing transactional engine.
2. `scripts/rehearsal/fault-store.sql` — isolated marker and guarded fault RPCs.

The workflow never installs either schema or runs a migration. Initialize
`meshdrop_recovery.identity` with the pinned UUID. Initialize the single true
row in `meshdrop_rehearsal.identity` with the same UUID, purpose
`fault-test-only`, environment `preview`, exact current database name, preview
environment ID and repository/owner numeric IDs.

Create distinct writer and reader logins, neither privileged nor owner. Require
NOSUPERUSER, NOCREATEDB, NOCREATEROLE and no membership in an owner/admin role.
Do not grant schema CREATE, direct table writes or generic release append access.

Both need database CONNECT, USAGE on `meshdrop_rehearsal`, and EXECUTE on:

```sql
meshdrop_rehearsal.check_store(uuid,text,text,text)
meshdrop_rehearsal.read_attempt(uuid,text,text,text,text,uuid)
```

Only the writer additionally needs EXECUTE on:

```sql
meshdrop_rehearsal.append_probe(uuid,text,text,text,text,text,jsonb)
```

Populate `meshdrop_rehearsal.scopes` with the five exact mode/scope pairs printed
by the configuration checker. For every scope, add `meshdrop_recovery.access`
entries for the writer with `can_append=true` and reader with `can_append=false`.
Grant no production-release scope access. Do not grant direct access to identity,
scope, ownership, history or approval tables.

For a fresh fault database, the following is the one-time administrator template.
It is documentation only, never run by the workflow. Connect using the approved
administrator credential mechanism, set the non-secret psql variables to reviewed
values, and install both schema files before using this template. The five scope
values come from `rehearsal:check-config`; UUID/IDs must be independently pinned.
`fault_database` must be the database to which this administrator session connected.
Do not use this template to overwrite an existing store.

```sql
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO meshdrop_recovery.identity(singleton,store_id)
  VALUES(true, :'store_id'::uuid);
INSERT INTO meshdrop_rehearsal.identity
  (singleton,store_id,purpose,environment,database_name,environment_id,repository_id,owner_id)
  VALUES(true, :'store_id'::uuid, 'fault-test-only', 'preview', current_database(),
    :'preview_environment_id', :'repository_id', :'owner_id');
CREATE ROLE meshdrop_fault_writer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE ROLE meshdrop_fault_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
GRANT CONNECT ON DATABASE :"fault_database" TO meshdrop_fault_writer,meshdrop_fault_reader;
GRANT USAGE ON SCHEMA meshdrop_rehearsal TO meshdrop_fault_writer,meshdrop_fault_reader;
GRANT EXECUTE ON FUNCTION meshdrop_rehearsal.check_store(uuid,text,text,text),
  meshdrop_rehearsal.read_attempt(uuid,text,text,text,text,uuid)
  TO meshdrop_fault_writer,meshdrop_fault_reader;
GRANT EXECUTE ON FUNCTION meshdrop_rehearsal.append_probe(uuid,text,text,text,text,text,jsonb)
  TO meshdrop_fault_writer;
INSERT INTO meshdrop_rehearsal.scopes(mode,scope_id) VALUES
  ('replay', :'replay_scope'), ('concurrency', :'concurrency_scope'),
  ('lost-ack', :'lost_ack_scope'), ('reconnect', :'reconnect_scope'),
  ('history-integrity', :'history_integrity_scope');
INSERT INTO meshdrop_recovery.access(scope_id,role_name,can_append)
  SELECT scope_id,'meshdrop_fault_writer'::name,true FROM meshdrop_rehearsal.scopes;
INSERT INTO meshdrop_recovery.access(scope_id,role_name,can_append)
  SELECT scope_id,'meshdrop_fault_reader'::name,false FROM meshdrop_rehearsal.scopes;
COMMIT;
\password meshdrop_fault_writer
\password meshdrop_fault_reader
```

Use interactive password prompts or the approved secret manager; never supply
passwords as psql command-line variables. Copy the two role names into the
fault database JSON and store their credentials only in the dedicated secrets.
This template grants no generic release append or table-write privileges.

The marker validates actual database, environment, repository/owner/store pins,
TLS, primary status and restricted role privileges before operations. Existing
SQL enforces scope ACLs, exclusive ownership, sequence/head compare-and-swap,
unique attempts and event hashes. SQL constraint failures are reported as a
small sanitized rejection enum; connection/authentication/timeout failures are
fatal, not counted as successful negative tests.

The administrator's configuration is a trust assumption. A deliberately
misconfigured or compromised administrator is not made trustworthy by a marker.
The independent witness remains unavailable.

## 3. Pre-dispatch read-only configuration check

Use a trusted operator shell with non-secret settings exported from independently
reviewed configuration. Set:

```text
REHEARSAL_ENVIRONMENT=preview
REHEARSAL_GITHUB_ENVIRONMENT_NAME=trust-rehearsal-preview
REHEARSAL_FAULT_TESTS=true
REHEARSAL_FAULT_MODE=rehearsal-only
REHEARSAL_EXPECTED_SOURCE=<the reviewed commit containing Task 10B>
REHEARSAL_EXPECTED_REF=refs/heads/main
```

Also supply the base runbook variables and `REHEARSAL_FAULT_DATABASE_JSON`.
Inject the three rehearsal passwords using the approved credential mechanism;
do not put their values in shell command history. Then run:

```sh
pnpm rehearsal:check-config
```

Output is `READY_FOR_HOSTED_REHEARSAL` only for structurally valid supplied
settings and required credential presence. Missing/invalid inputs produce
`NOT_READY_FOR_HOSTED_REHEARSAL`, exact known configuration names and a nonzero
exit. Secrets are reported only as `present: true/false`. The command performs
no GitHub request, database connection, provisioning, dispatch or file write.

READY is explicitly **structural readiness**, not authentication of GitHub
protection, provider state or a release authority. The workflow's actual
environment GET, signature verification, runtime file/hash checks and database
marker checks still have to succeed. The runtime creates private CA/password
files outside the checkout and validates them before connecting. A cleanup
failure prevents a successful completion record.

Each fault scope hashes the canonical repository URL, preview, fixed fault
purpose and mode. Use the checker's output rather than hand-maintained hashes.
The normal scope uses the same canonical repository URL, without a fault mode;
older examples using only owner/repository were corrected in the base runbook.

## 4. Human dispatch

After reviewing/authorizing publication of the new **source code only** in a
separate step, manually dispatch the rehearsal workflow for the reviewed commit:

```text
workflow: .github/workflows/release-trust-rehearsal.yml
ref: main
environment: preview
expected_source_sha: <exact reviewed commit containing Task 10B>
expected_ref: refs/heads/main
fault_tests: true
prepared_manifest_sha256: empty unless a real prepared manifest was independently reviewed
```

Task 10B does not commit, push or dispatch. If main or the reviewed source
changes, stop and review; do not change a pin merely to bypass a failure.
With `fault_tests:false`, the normal rehearsal remains available and all five
fault summary fields stay NOT_RUN. Production plus fault tests fails before a
GitHub preflight request or any database access.

The guarded command is:

```sh
pnpm exec tsx scripts/rehearsal/cli.ts fault-test all
```

It also accepts one of `replay`, `concurrency`, `lost-ack`, `reconnect` or
`history-integrity`. Writes require the real hosted runtime, exact authenticated
MeshDrop artifact readback and explicit preview-only configuration. The test
constructor accepts isolated local connections but can only report
`offline-fixture`; it cannot enter the hosted factory with a success boolean.

## 5. Defined fault scenarios

| Mode              | Operation and passing evidence                                                                                                                                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| replay            | First valid event succeeds; duplicate reservation, repeated event, stale head, duplicate evidence and a deliberately forged next-attempt claim are rejected; saved head/history remain unchanged                        |
| concurrency       | Two independent psql processes race for the same mode scope; exactly one reservation wins; loser cannot append/reuse ownership; one intact final history                                                                |
| lost-ack          | Save proposed event/head, execute real append, wait for SQL process exit, deliberately discard its application acknowledgement, then reconcile through a fresh reader; no blind retry                                   |
| reconnect         | Writer processes reserve/write and exit; a fresh reader uses only configured store/scope/attempt identity and reconstructs artifact/history from durable storage; no automatic resume                                   |
| history-integrity | Validate real stored history, then reject missing/deleted-copy, modified, reordered, previous-hash, scope, store, attempt, stale-head and duplicate variants in reader memory; stored history is never deleted/modified |

Lost-ack is a controlled post-commit acknowledgement suppression boundary, not a
claim that a real network partition was produced. Every execute opens/exits a
separate psql session; the reader receives no cached writer head. The coordinator
retains original expected identity/proposed bytes only to verify reconciliation.
Concurrency joins both client processes even when one transport fails.

Cross-attempt replay uses an explicitly forged next-attempt probe against the
existing immutable attempt identity; it is not represented as a second genuinely
authenticated workflow. Approval IDs are null and their replay is NOT APPLICABLE.
An unavailable database cannot count as a confirmed rejection.

Normal success modes have three events; lost-ack/reconnect retain two and require
reconciliation. All five mode owners remain reserved. No ownership removal,
automatic retry, unlock, rollback or resume exists. A later run will fail closed
against an already-owned store. Retain its history and use a separately reviewed
fresh non-production store for another run, rather than deleting/resetting it.
Disposable automated test databases are isolated from these operator stores.

## 6. Evidence download and independent verification

Download exact immutable artifact IDs from the run, not another run/name:

- Producer: `rehearsal.json`, `bundle.json`.
- Normal recovery: `events.json`, `head.json`, `summary.json`.
- Fault writer: `fault-results.json`, `fault-summary.json`, `fault-heads.json`.
- Separate fault attester: the same fault files plus `fault-bundle.json`.

On failure, available fault diagnostics are uploaded from exact whitelisted
paths. The signing job requires successful fault execution and complete bound
results; partial/fixture results are not signed as complete. Password/CA runtime
directories, generic logs and hidden files are never uploaded.

Each report binds the original artifact ID/UUID, repository IDs, source, run and
attempt, store UUID, derived recovery attempt, final head, counts and result
digests. Digests alone are content integrity. The separate fault attestation
cryptographically binds the complete report to the exact workflow/source/run.
Neither signature authenticates a human approval or proves the database
administrator honest.

Outside the producing runner, use reviewed roots and the exact base policy and
expectation formats from the base runbook:

```sh
pnpm exec tsx scripts/rehearsal/cli.ts verify-files \
  rehearsal.json bundle.json reviewed-roots.jsonl policy.json expectation.json
pnpm exec tsx scripts/rehearsal/cli.ts verify-faults \
  rehearsal.json bundle.json reviewed-roots.jsonl policy.json expectation.json \
  fault-results.json fault-bundle.json
```

Both original and fault signatures must verify against independently pinned
source/workflow/repository/run identities. Fault payload/history/digest checks
then enforce the same parent artifact and false capability flags. Local tests
use genuine upstream signatures for negative fixture-promotion checks; no real
MeshDrop hosted success is fabricated.

Re-read the exact durable histories using the independent restricted reader and
compare each exported head. An exported copy alone is not an independently
authenticated latest head. Keep `independentWitnessVerified:false`; the hosted
witness factory remains blocked. The expanded future witness contract requires
store/scope/attempt/sequence/head, artifact/UUID, identity/time and a monotonic
counter. Same-database/history blobs, unsigned files and fixture witnesses are
rejected; no new witness authority is invented.

If a runner stops before exporting results, recover the signed parent artifact
first. Derive candidate recovery attempt IDs locally from that artifact, not
from a guessed UUID or workflow timestamp:

```sh
node --import tsx --input-type=module -e '
import {readFileSync} from "node:fs";
import {parseArtifact} from "./scripts/rehearsal/contract.ts";
import {FAULT_MODES,faultAttempt} from "./scripts/rehearsal/fault-contract.ts";
const artifact=parseArtifact(JSON.parse(readFileSync("rehearsal.json","utf8")));
for(const mode of FAULT_MODES)for(const writer of [0,1])
  console.log(JSON.stringify({mode,writer,attemptId:faultAttempt(artifact,mode,writer)}));
'
```

Using the separately configured reader login, TLS `verify-full`, reviewed public
CA and approved private password-file mechanism, the read-only SQL is:

```sql
SELECT meshdrop_rehearsal.read_attempt(
  :'store_id'::uuid, :'preview_environment_id', :'repository_id', :'owner_id',
  :'mode', :'attempt_id'::uuid);
```

These are non-secret psql variables, supplied from independently reviewed pins
and the derived identity. A missing attempt is an explicit query failure, not a
successful empty history. Preserve the response/head and compare with retained
prior/proposed heads. For concurrency, inspect both candidate attempts; never
guess the winner. Do not resume writes, retry blindly or remove ownership during
this reconciliation. A separately observed database head still is not a witness.

All five check fields are exactly PASS, FAIL or NOT_RUN. No partial result becomes
accepted. Keep `publicationEnabled`, `acceptanceEnabled`, `productionApproved`
and `humanAuthorizationVerified` false. GitHub environment review observations
are not full Task 07 authorization. A successful Task 10 proves rehearsal
plumbing only; no deployment, admission change or production operation follows.
