# HQ migrations

Run `npm run hq:migrate` with `DATABASE_URL_UNPOOLED` pointing at the intended database.
The command holds one dedicated PostgreSQL connection and an advisory lock. Each
migration and its `hq_migrations` ledger row commit together. Failed migrations
roll back and can be retried; already applied migrations are checksum-checked and
skipped. The command never infers that an existing database is already current.

`0001-legacy-bootstrap` preserves the existing upgrade path for fresh databases
and older staging databases. Its immutable inputs are `../schema.sql`,
`../upgrades.ts`, `../member-auth-schema.sql`, and `../builder-schema.sql`.
Keep those files and the legacy upgrade tests; do not edit or delete them after
the baseline has been applied. Historical transformations run only on the first
adoption of the ledger, inside one transaction. No existing tables are dropped
as part of adopting the ledger beyond transformations already in that legacy path.

First adoption preserves existing `Other` role and `rejected` stage settings.
The `call` and `mailing` renames match only the exact historical seed labels
`Called` and `Mailing sent to their list`, preserving custom wording.
The snapshot normalization columns and `source_status` were introduced together.
Their historical raw-payload backfill applies only to `source_status = 'never'`
rows, the default given to older imports. Existing `ok` and `error` rows retain
their normalized values, including intentional NULLs and empty tracks. Missing
CRM identities, open pause history and ownership records still receive their
guarded legacy backfills; existing records are retained. All schema upgrades
still run, without inferring schema completeness from these data markers.

`0002-builder-role-after-team-setup` adds the neutral User role (no visible tag) and corrects account-linked
Builder cards that have no successfully initialized team in that edition. Verified
owners and joined teammates, admin-created project owners, hand-entered cards and
custom roles are preserved. No accounts, project data, notes or capabilities are
removed. Deploy the matching enrollment change so new sign-ins and help requests
remain untagged until their team setup succeeds or a capability is granted.

For the next schema change, add `0003-description.sql` here, followed by ascending
four-digit versions. SQL files execute whole, so quoted semicolons and `DO $$`
bodies work. Do not put transaction control or operations that cannot run inside
a transaction (such as `CREATE INDEX CONCURRENTLY`) in a migration. Never change
an applied file or edit ledger rows to bypass a checksum mismatch; restore the
original file and add a new forward migration. Deployment from an older checkout
is refused when its migration catalog is missing applied history.

The ledger is infrastructure history and must survive any operational data reset.
