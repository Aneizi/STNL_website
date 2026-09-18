import 'server-only';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { ImportedProject } from '@/lib/colosseum-api';
import { recordAuditEvent } from './audit';
import { builderDatabase, type BuilderDatabase, type BuilderQuery } from './builder-db';
import { BuilderError, ImportRefusedError, isNetherlands, type BuilderHackathon, type BuilderIdentity, type BuilderTeam, type BuilderUser, type JoinLinkLookup, type ProjectStage } from './builder-types';
import { interpretSubmission, toSnapshotFields, type SubmissionStatus } from './colosseum-snapshot';
import { correctPersonMatch, ensurePersonForAccount, ensurePersonForRosterMember, normalizeColosseumUsername } from './crm-identity';
import { isPlaceholderEmail } from './placeholder-email';
import { enableReporting } from './reporting-enrolment';

// The pool and its handle types live in builder-db.ts; they are re-exported
// here so every existing import path keeps working.
export { BuilderError, builderDatabase };
export type { BuilderDatabase, BuilderQuery };

const hashCode = (code: string) => createHash('sha256').update(code.toUpperCase().replace(/[\s-]/g, '')).digest('hex');
const asDate = (value: unknown) => value ? new Date(String(value)).toISOString() : null;
/** An address the CRM may hold or show: a real email, or nothing. The internal placeholder never reaches a row or a page. */
export const realEmail = (value: unknown): string | null => typeof value === 'string' && value !== '' && !isPlaceholderEmail(value) ? value : null;

const TEAM_SELECT = `SELECT o.*,p.name,h.name AS hackathon_name,
      (SELECT json_agg(json_build_object('id',m.id,'name',m.name,'username',m.colosseum_username,'avatarUrl',m.avatar_url,'joined',m.builder_user_id IS NOT NULL) ORDER BY m.sort)
       FROM hq_project_members m WHERE m.project_id=p.id) AS members
      FROM hq_project_onboarding o JOIN hq_projects p ON p.id=o.project_id JOIN hq_hackathons h ON h.id=o.hackathon_id`;
// The one relationship that makes a team the account's own: a claim it owns
// or a roster row it has joined.
const OWN_TEAM = `(o.owner_user_id=$1 OR EXISTS(SELECT 1 FROM hq_project_members m WHERE m.project_id=o.project_id AND m.builder_user_id=$1))`;
const text = (value: unknown): string | null => (value == null || value === '' ? null : String(value));
/** The normalized Colosseum snapshot as every team surface reads it; see lib/hq/colosseum-snapshot.ts. */
const toSource = (r: Record<string, unknown>): BuilderTeam['source'] => ({
  category: text(r.category),
  tracks: Array.isArray(r.tracks) ? (r.tracks as unknown[]).map(String) : [],
  twitterHandle: text(r.twitter_handle),
  website: text(r.website),
  repoLink: text(r.repo_link),
  presentationLink: text(r.presentation_link),
  technicalDemoLink: text(r.technical_demo_link),
  pitchVideoLink: text(r.pitch_video_link),
  demoVideoLink: text(r.demo_video_link),
  imageUrl: text(r.image_url),
  submissionStatus: (r.submission_status ?? 'not_checked') as SubmissionStatus,
  submittedAt: asDate(r.submitted_at),
  completion: r.completion_is_complete == null ? null
    : { isComplete: Boolean(r.completion_is_complete), missingCount: Number(r.completion_missing_count ?? 0) },
  sourceStatus: (r.source_status ?? 'never') as BuilderTeam['source']['sourceStatus'],
  sourceCheckedAt: asDate(r.source_checked_at),
  sourceErrorCode: text(r.source_error_code),
});
const toTeam = (r: Record<string, unknown>): BuilderTeam => ({ id: String(r.project_id), name: String(r.name), hackathonId: Number(r.hackathon_id), hackathonName: String(r.hackathon_name),
  projectUrl: String(r.project_url), description: String(r.description), stage: r.stage as ProjectStage, verification: r.verification as BuilderTeam['verification'],
  ownerId: String(r.owner_user_id), leadUsername: String(r.lead_username), members: (r.members ?? []) as BuilderTeam['members'], source: toSource(r) });

/**
 * The current edition for a surface with no edition selector of its own: the
 * soonest-ending edition that has not ended yet, else the soonest upcoming
 * one, archived editions excluded — the same ordering `hackathons()` lists
 * by and `syncAccount`'s own default-enrollment pick uses. Shared so a third
 * copy of this SQL never has to be written: `syncAccount` below calls it on
 * its own transaction handle, and `BuilderStore#currentHackathonId` calls it
 * on the pool for a member page (`/hq/captain`) that must never read the
 * operator `hq_hackathon` cookie instead.
 */
async function selectCurrentHackathonId(db: BuilderQuery): Promise<number | null> {
  const { rows } = await db.query(`SELECT id FROM hq_hackathons WHERE archived_at IS NULL
    ORDER BY (end_date >= current_date) DESC, start_date ASC LIMIT 1`);
  return rows.length ? Number(rows[0].id) : null;
}

/** The People role id for a label, created on first use. Shared by account enrollment and roster import so they cannot drift apart. */
async function ensureRoleId(db: BuilderQuery, label: string, filterLabel: string): Promise<string> {
  const { rows } = await db.query(`INSERT INTO hq_people_roles(label,filter_label,color,bg,is_judge,sort)
    VALUES($1,$2,'accent','accent-fill',false,100)
    ON CONFLICT(label) DO UPDATE SET label=EXCLUDED.label RETURNING id`, [label, filterLabel]);
  return String(rows[0].id);
}

/**
 * Imported roster identities, upserted. Shared by `importTeam` and
 * `refreshTeam` so an import and a refresh can never build a different
 * roster from the same response.
 *
 * Unclaimed entries are references, not CRM people. A person is linked only
 * when an authenticated account selects its own entry. Old person links and
 * claimed memberships survive refresh; source_present controls selection.
 */
async function upsertRoster(db: BuilderQuery, input: { projectId: string; hackathonId: number; members: ImportedProject['members'] }) {
  await db.query('UPDATE hq_project_members SET source_present=false WHERE project_id=$1::uuid AND colosseum_username IS NOT NULL', [input.projectId]);
  for (const [sort, member] of input.members.entries()) {
    await db.query(`INSERT INTO hq_project_members(project_id,name,colosseum_username,avatar_url,sort,source_present)
      VALUES($1::uuid,$2,$3,$4,$5,true)
      ON CONFLICT (project_id, lower(colosseum_username)) DO UPDATE SET
        name=EXCLUDED.name,avatar_url=EXCLUDED.avatar_url,sort=EXCLUDED.sort,source_present=true`,
      [input.projectId, member.displayName, member.username, member.avatarUrl, sort]);
  }
}

async function enroll(db: BuilderQuery, user: BuilderIdentity, hackathonId: number, participation: 'builder' | 'supporter' = 'builder') {
  const { rows: editions } = await db.query('SELECT id FROM hq_hackathons WHERE id=$1 AND archived_at IS NULL', [hackathonId]);
  if (!editions.length) throw new BuilderError('Choose an available hackathon.');
  await db.query(`INSERT INTO hq_builder_enrollments(user_id,hackathon_id,participation) VALUES($1,$2,$3)
    ON CONFLICT(user_id,hackathon_id) DO UPDATE SET participation=EXCLUDED.participation`, [user.id, hackathonId, participation]);
  const roleId = participation === 'builder'
    ? await ensureRoleId(db, 'Builder', 'Builders')
    : await ensureRoleId(db, 'Community', 'Community');
  // The card's contact is the login email when there is one; a card without
  // a contact is the normal state for a Telegram-only account. On conflict
  // only the role follows the enrollment and a card that has no person yet
  // gets one; an operator's edits and a corrected person link both survive.
  // The person is stamped only when no other card of that edition already
  // carries it (hq_people_person_idx, one card per person per edition), on
  // insert and on conflict alike: a roster card that kept the person after a
  // match correction must never break the member's next login sync.
  const personId = await ensurePersonForAccount(db, { userId: user.id, displayName: user.name });
  await db.query(`INSERT INTO hq_people(hackathon_id,builder_user_id,name,role_id,contact,person_id)
    VALUES($1,$2,$3,$4,$5,
      CASE WHEN EXISTS (SELECT 1 FROM hq_people q WHERE q.hackathon_id=$1 AND q.person_id=$6::uuid) THEN NULL ELSE $6::uuid END)
    ON CONFLICT(hackathon_id,builder_user_id)
    DO UPDATE SET role_id=EXCLUDED.role_id,person_id=COALESCE(hq_people.person_id,EXCLUDED.person_id)`,
    [hackathonId, user.id, user.name, roleId, realEmail(user.email) ?? '', personId]);
}

/** Called only while holding the project's onboarding row lock. */
async function claimRosterSeat(db: BuilderQuery, user: BuilderIdentity, input: { projectId: string; memberId: string; hackathonId: number }) {
  const { rows: members } = await db.query(`SELECT id,name,colosseum_username,person_id,builder_user_id,source_present
    FROM hq_project_members WHERE project_id=$1::uuid AND id=$2::uuid FOR UPDATE`, [input.projectId, input.memberId]);
  const member = members[0];
  if (!member || !member.source_present || !member.colosseum_username) throw new BuilderError('Choose yourself from the current Colosseum team.');
  if (member.builder_user_id === user.id) return;
  if (member.builder_user_id != null) {
    const { rows: available } = await db.query('SELECT 1 FROM hq_project_members WHERE project_id=$1::uuid AND builder_user_id IS NULL AND source_present AND colosseum_username IS NOT NULL LIMIT 1', [input.projectId]);
    if (!available.length) throw new BuilderError('All teammates have joined. Add yourself to the project on Colosseum, then refresh.');
    throw new BuilderError('That teammate has already joined. Choose yourself.');
  }
  const { rows: joined } = await db.query('SELECT 1 FROM hq_project_members WHERE project_id=$1::uuid AND builder_user_id=$2', [input.projectId, user.id]);
  if (joined.length) throw new BuilderError('You have already joined this team.');
  const { rows: captaining } = await db.query(
    'SELECT 1 FROM hq_captain_assignments WHERE project_id=$1::uuid AND captain_user_id=$2 AND unassigned_at IS NULL',
    [input.projectId, user.id],
  );
  if (captaining.length) throw new BuilderError('You currently hold the Captain role for this project. Ask an admin to reassign the Captain before joining.');
  // Existing provisional identities are merged safely, preserving legacy
  // relationships. Only this selected entry gets a person, never its peers.
  const personId = member.person_id == null
    ? await ensurePersonForRosterMember(db, { colosseumUsername: String(member.colosseum_username), displayName: String(member.name) })
    : String(member.person_id);
  await db.query('UPDATE hq_project_members SET person_id=$1::uuid WHERE id=$2::uuid', [personId, input.memberId]);
  await correctPersonMatch(db, {
    personId, toUserId: user.id, reason: 'Selected their own Colosseum team entry', actor: { kind: 'member', id: user.id },
  });
  await db.query('UPDATE hq_project_members SET builder_user_id=$1,joined_at=now() WHERE id=$2::uuid', [user.id, input.memberId]);
  await enroll(db, user, input.hackathonId);
}

/** All mutations are atomic and use authenticated IDs supplied by server actions. */
export class BuilderStore {
  constructor(private readonly db: BuilderDatabase) {}

  /** Mirrors the login identity onto the profile and guarantees its CRM person. contact_email is self-declared and never touched here. */
  async syncAccount(user: BuilderIdentity): Promise<void> {
    // This also runs while reading a session. An unchanged account needs one
    // indexed read, not a transaction, an UPDATE and several follow-up reads.
    // Missing relationships still take the repair path below.
    const { rows: ready } = await this.db.query(`SELECT 1 FROM hq_builder_profiles p
      WHERE p.id=$1 AND p.email IS NOT DISTINCT FROM $2 AND p.name=$3
        AND EXISTS (SELECT 1 FROM hq_crm_persons c WHERE c.builder_user_id=p.id)
        AND (EXISTS (SELECT 1 FROM hq_builder_enrollments e WHERE e.user_id=p.id)
          OR NOT EXISTS (SELECT 1 FROM hq_hackathons h WHERE h.archived_at IS NULL))`,
      [user.id, realEmail(user.email), user.name]);
    if (ready.length) return;
    await this.db.transaction(async db => {
      await db.query(`INSERT INTO hq_builder_profiles(id,email,name) VALUES($1,$2,$3)
        ON CONFLICT(id) DO UPDATE SET email=EXCLUDED.email,name=EXCLUDED.name`, [user.id, realEmail(user.email), user.name]);
      await ensurePersonForAccount(db, { userId: user.id, displayName: user.name });
      const { rows: existing } = await db.query('SELECT 1 FROM hq_builder_enrollments WHERE user_id=$1 LIMIT 1', [user.id]);
      if (existing.length) return;
      const hackathonId = await selectCurrentHackathonId(db);
      if (hackathonId !== null) await enroll(db, user, hackathonId);
    });
  }

  /** The stored account, or null before its first sync. */
  async profile(userId: string): Promise<BuilderUser | null> {
    const { rows } = await this.db.query('SELECT id,email,contact_email,name FROM hq_builder_profiles WHERE id=$1', [userId]);
    if (!rows.length) return null;
    return { id: String(rows[0].id), email: realEmail(rows[0].email), contactEmail: realEmail(rows[0].contact_email), name: String(rows[0].name) };
  }

  /**
   * The current edition for a member surface with no edition selector: see
   * `selectCurrentHackathonId` above. Member surfaces must never read the
   * operator `hq_hackathon` cookie (`docs/hq/contracts.md`), so this is
   * their one server-side source of "now".
   */
  async currentHackathonId(): Promise<number | null> {
    return selectCurrentHackathonId(this.db);
  }

  async enroll(user: BuilderIdentity, hackathonId: number, participation: 'builder' | 'supporter') {
    await this.db.transaction(db => enroll(db, user, hackathonId, participation));
  }

  async hackathons(): Promise<BuilderHackathon[]> {
    const { rows } = await this.db.query(`SELECT h.id,h.name,h.start_date::text,h.end_date::text,
      o.external_hackathon_id,o.external_hackathon_slug,o.projects_open,o.projects_available_at,
      o.signup_url,o.hosting_enabled FROM hq_hackathons h
      LEFT JOIN hq_hackathon_onboarding o ON o.hackathon_id=h.id
      WHERE h.archived_at IS NULL ORDER BY (h.end_date >= current_date) DESC,h.start_date`);
    return rows.map(r => ({ id: Number(r.id), name: String(r.name), startDate: String(r.start_date), endDate: String(r.end_date),
      externalId: r.external_hackathon_id == null ? null : Number(r.external_hackathon_id), externalSlug: r.external_hackathon_slug as string | null,
      projectsOpen: Boolean(r.projects_open), projectsAvailableAt: asDate(r.projects_available_at),
      signupUrl: String(r.signup_url || 'https://colosseum.com/signup'), hostingEnabled: Boolean(r.hosting_enabled) }));
  }

  async hackathon(id: number): Promise<BuilderHackathon> {
    const value = (await this.hackathons()).find(h => h.id === id);
    if (!value) throw new BuilderError('Choose an available hackathon.');
    return value;
  }

  async rateLimit(userId: string, action: string, maximum = 15) {
    const { rows } = await this.db.query(`INSERT INTO hq_login_limits(key,count,window_start)
      VALUES($1,1,now()) ON CONFLICT(key) DO UPDATE SET
      count=CASE WHEN hq_login_limits.window_start < now()-interval '15 minutes' THEN 1 ELSE hq_login_limits.count+1 END,
      window_start=CASE WHEN hq_login_limits.window_start < now()-interval '15 minutes' THEN now() ELSE hq_login_limits.window_start END
      RETURNING count`, [`builder:${action}:${userId}`]);
    if (Number(rows[0].count) > maximum) throw new BuilderError('Please wait a few minutes before trying again.');
  }

  /**
   * The Colosseum project already in HQ for this edition, or null. Read
   * before anything is written so an already-imported team can be told so
   * plainly; the result deliberately carries no owner, no roster and no
   * member identity, because the plan forbids revealing who imported it.
   */
  async importedProject(hackathonId: number, externalId: number): Promise<{ projectId: string } | null> {
    const { rows } = await this.db.query(
      'SELECT project_id::text AS project_id FROM hq_project_onboarding WHERE hackathon_id=$1 AND external_id=$2',
      [hackathonId, externalId],
    );
    return rows.length ? { projectId: String(rows[0].project_id) } : null;
  }

  /**
   * A self-service import. Owner change of 14 September 2026: there is no
   * ownership-proof challenge, no pending state and no admin approval queue,
   * so a passing import produces a usable team immediately, owned by the
   * importing account, with their explicitly selected roster entry claimed
   * in the same transaction. Other entries remain source references.
   *
   * `verification` is written `'verified'` rather than retired. That is the
   * documented phase 3 decision (docs/hq/contracts.md, "The verification =
   * 'verified' decision"): the column is the membership marker every existing
   * reader already uses — `loadTeamMembership` in ./authz-sql, and through it
   * `authorizeProjectAction`, `memberTeamView`, `updateTeam`, `createInvite`
   * and `redeemInvite` — so writing it keeps all of them working unmodified,
   * where retiring the concept would have meant following every reader to a
   * replacement rule. What is removed is the *step*, not the column.
   *
   * The gate is re-checked here, inside the transaction and against the
   * edition mapping read under `FOR SHARE`, even though the calling service
   * (./project-import.ts) has already checked it: the service produces the
   * accurate per-case message, this is the last line of defence that a
   * concurrent Admin edit of the mapping cannot slip past.
   */
  async importTeam(user: BuilderIdentity, input: { hackathonId: number; project: ImportedProject; projectUrl: string; selectedUsername: string }): Promise<string> {
    const { project } = input;
    return this.db.transaction(async db => {
      const { rows: config } = await db.query(`SELECT o.* FROM hq_hackathon_onboarding o JOIN hq_hackathons h ON h.id=o.hackathon_id
        WHERE h.id=$1 AND h.archived_at IS NULL FOR SHARE OF o,h`, [input.hackathonId]);
      if (!config.length || config[0].external_hackathon_id == null) throw new ImportRefusedError('edition_not_configured');
      if (Number(config[0].external_hackathon_id) !== project.hackathon.id) throw new ImportRefusedError('wrong_edition');
      if (!isNetherlands(project.country)) throw new ImportRefusedError('not_dutch');
      if (!config[0].projects_open || (config[0].projects_available_at && new Date(String(config[0].projects_available_at)).getTime() > Date.now())) {
        throw new ImportRefusedError('imports_closed');
      }
      const selected = project.members.find(member => normalizeColosseumUsername(member.username) === normalizeColosseumUsername(input.selectedUsername));
      if (!selected) throw new BuilderError('Choose yourself from the Colosseum team.');

      const id = randomUUID();
      const { rows: status } = await db.query(`INSERT INTO hq_project_statuses(slug,label,color,counts_as_active,sort)
        VALUES('onboarding','Onboarding','accent',true,100) ON CONFLICT(slug) DO UPDATE SET slug=EXCLUDED.slug RETURNING id`);
      const { rows: forecast } = await db.query(`INSERT INTO hq_project_forecasts(slug,label,color,sort)
        VALUES('unassessed','Not assessed','muted',100) ON CONFLICT(slug) DO UPDATE SET slug=EXCLUDED.slug RETURNING id`);
      const lead = selected;
      await db.query(`INSERT INTO hq_projects(id,hackathon_id,name,lead_name,status_id,forecast_id,last_check_in)
        VALUES($1,$2,$3,$4,$5,$6,current_date)`, [id, input.hackathonId, project.name, lead.displayName, status[0].id, forecast[0].id]);
      // The unique (hackathon_id, external_id) key is what makes "already
      // imported" race-free: two simultaneous imports of one project both
      // pass the read above, and the loser lands here with no row back and
      // rolls its own hq_projects insert away with the transaction.
      const snapshot = toSnapshotFields(project);
      const { rows: created } = await db.query(
        `INSERT INTO hq_project_onboarding(project_id,hackathon_id,external_id,project_url,slug,description,country,category,tracks,
           twitter_handle,website,repo_link,presentation_link,technical_demo_link,pitch_video_link,demo_video_link,image_url,
           external_hackathon_id,external_hackathon_slug,external_hackathon_name,submitted_at,completion_is_complete,completion_missing_count,
           submission_status,source_status,source_checked_at,source_attempted_at,raw,owner_user_id,verification,stage,lead_username)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::timestamptz,$22,$23,$24,'ok',now(),now(),$25::jsonb,$26,'verified','idea',$27)
         ON CONFLICT (hackathon_id, external_id) DO NOTHING RETURNING project_id`,
        [id, input.hackathonId, project.externalId, input.projectUrl, snapshot.slug, snapshot.description, snapshot.country,
          snapshot.category, snapshot.tracks, snapshot.twitterHandle, snapshot.website, snapshot.repoLink, snapshot.presentationLink,
          snapshot.technicalDemoLink, snapshot.pitchVideoLink, snapshot.demoVideoLink, snapshot.imageUrl,
          snapshot.externalHackathonId, snapshot.externalHackathonSlug, snapshot.externalHackathonName, snapshot.submittedAt,
          snapshot.completionIsComplete, snapshot.completionMissingCount,
          interpretSubmission({ checked: true, submittedAt: snapshot.submittedAt }),
          JSON.stringify(snapshot.raw), user.id, lead.username],
      );
      if (!created.length) throw new ImportRefusedError('already_imported');
      // HQ ownership, written beside the snapshot rather than read out of it.
      // `loadTeamMembership` reads this table, so a project an admin created
      // by hand from a help request and an imported one have the same owner
      // record; nothing here depends on the Colosseum external id any more.
      await db.query(
        `INSERT INTO hq_project_ownership(project_id,hackathon_id,owner_user_id,source) VALUES($1::uuid,$2,$3,'import')
         ON CONFLICT (project_id) DO NOTHING`,
        [id, input.hackathonId, user.id],
      );
      await upsertRoster(db, { projectId: id, hackathonId: input.hackathonId, members: project.members });
      const { rows: selectedRows } = await db.query('SELECT id FROM hq_project_members WHERE project_id=$1::uuid AND lower(colosseum_username)=lower($2)', [id, selected.username]);
      await claimRosterSeat(db, user, { projectId: id, memberId: String(selectedRows[0].id), hackathonId: input.hackathonId });
      // "A team enters reporting as soon as its HQ import succeeds" (plan
      // section 3). In the import's own transaction, so a committed team is
      // never outside reporting and a rolled-back one never leaves an
      // eligibility row: the same reasoning as the audit event below. The
      // member is the actor and no separate audit event is written, because
      // `project.imported` already records this.
      await enableReporting(db, { projectId: id, hackathonId: input.hackathonId });
      // In the import's own transaction, not after it: an import with no
      // trail, or a trail for an import that rolled back, would both be
      // wrong. The member is the actor — this is the first member-actor
      // project event in the audit vocabulary.
      await recordAuditEvent(db, {
        kind: 'project.imported',
        actor: { kind: 'member', id: user.id },
        hackathonId: input.hackathonId,
        projectId: id,
        metadata: { externalId: project.externalId, externalHackathonId: project.hackathon.id, rosterSize: project.members.length },
      });
      await db.query(`INSERT INTO hq_activity(hackathon_id,message) VALUES($1,$2)`, [input.hackathonId, `${project.name} imported from Colosseum`]);
      return id;
    });
  }

  /**
   * The hand-made half of the plan's Request help route: an operator creates
   * the HQ project for an account whose Colosseum project cannot be fetched
   * yet, and that account owns it.
   *
   * "Model HQ project ownership independently of a successful external
   * snapshot ... Do not invent external IDs, and do not mark an unavailable
   * source Submitted." So there is no `hq_project_onboarding` row here at
   * all: no external id is fabricated to satisfy its NOT NULL column, no
   * `project_url` is claimed and no submission status is written. The project
   * is an ordinary `hq_projects` row with an `hq_project_ownership` row
   * beside it, which is exactly what `loadTeamMembership` reads, so its owner
   * can open it, write weekly updates and be given a Captain like anyone
   * else. What it does not have is a roster, a Colosseum link and a
   * submission badge, because it genuinely does not have those yet.
   *
   * Tied to the request, in the request's own transaction: the request is
   * resolved and points at the project it became, and the unique index on
   * that column means a second press finds the request already answered
   * rather than creating a second project for it.
   */
  async createProjectForRequest(input: {
    requestId: string; hackathonId: number; name: string; operatorId: string;
  }): Promise<{ projectId: string; ownerUserId: string } | null> {
    return this.db.transaction(async db => {
      const { rows: requests } = await db.query(
        `SELECT r.id, r.user_id, r.project_id, b.name AS owner_name, b.contact_email, b.email
         FROM hq_project_import_requests r JOIN hq_builder_profiles b ON b.id = r.user_id
         WHERE r.id=$1::uuid AND r.hackathon_id=$2 FOR UPDATE OF r`,
        [input.requestId, input.hackathonId],
      );
      if (!requests.length) return null;
      const request = requests[0];
      if (request.project_id != null) throw new BuilderError('This request already has a project. Open it from Projects instead.');
      const ownerUserId = String(request.user_id);

      const id = randomUUID();
      const { rows: status } = await db.query(`INSERT INTO hq_project_statuses(slug,label,color,counts_as_active,sort)
        VALUES('onboarding','Onboarding','accent',true,100) ON CONFLICT(slug) DO UPDATE SET slug=EXCLUDED.slug RETURNING id`);
      const { rows: forecast } = await db.query(`INSERT INTO hq_project_forecasts(slug,label,color,sort)
        VALUES('unassessed','Not assessed','muted',100) ON CONFLICT(slug) DO UPDATE SET slug=EXCLUDED.slug RETURNING id`);
      await db.query(`INSERT INTO hq_projects(id,hackathon_id,name,lead_name,status_id,forecast_id,last_check_in)
        VALUES($1,$2,$3,$4,$5,$6,current_date)`, [id, input.hackathonId, input.name, String(request.owner_name), status[0].id, forecast[0].id]);
      await db.query(`INSERT INTO hq_project_ownership(project_id,hackathon_id,owner_user_id,source,created_by_user_id)
        VALUES($1::uuid,$2,$3,'admin',$4::uuid)`, [id, input.hackathonId, ownerUserId, input.operatorId]);
      await db.query(`UPDATE hq_project_import_requests SET status='resolved',project_id=$2::uuid WHERE id=$1::uuid`, [input.requestId, id]);
      // The owner is enrolled in the edition the way an importer is, so the
      // project shows up on their dashboard and their People card exists.
      await enroll(db, { id: ownerUserId, name: String(request.owner_name), email: realEmail(request.email) ?? '' }, input.hackathonId);
      await recordAuditEvent(db, {
        kind: 'project.created',
        actor: { kind: 'operator', id: input.operatorId },
        hackathonId: input.hackathonId,
        projectId: id,
        subjectUserId: ownerUserId,
        metadata: { requestId: input.requestId, name: input.name, source: 'admin' },
      });
      await db.query(`INSERT INTO hq_activity(hackathon_id,user_id,message) VALUES($1,$2::uuid,$3)`,
        [input.hackathonId, input.operatorId, `${input.name} created by hand from a project help request`]);
      return { projectId: id, ownerUserId };
    });
  }

  /**
   * The other half: the Colosseum project becomes available, and its snapshot
   * is attached to the HQ project that already exists.
   *
   * "Later source reconciliation attaches the real source ID without
   * replacing the HQ project or its history." So the onboarding row is
   * written against the project id that is already there: the Captain
   * assignment, the weekly reporting, the entries and the audit trail all
   * keep pointing at the same project, because it is the same project. The
   * owner stays whoever `hq_project_ownership` says; `owner_user_id` on the
   * onboarding row is written from it rather than from whoever ran this.
   *
   * Refuses a project that already has a source, and a Colosseum project
   * already imported elsewhere in the edition — the same unique
   * `(hackathon_id, external_id)` key that makes a double import safe.
   */
  async attachSourceToProject(input: {
    projectId: string; hackathonId: number; project: ImportedProject; projectUrl: string; operatorId: string;
  }): Promise<void> {
    const { project } = input;
    await this.db.transaction(async db => {
      const { rows: owners } = await db.query(
        `SELECT w.owner_user_id FROM hq_project_ownership w JOIN hq_projects p ON p.id=w.project_id
         WHERE w.project_id=$1::uuid AND p.hackathon_id=$2 FOR UPDATE OF w`,
        [input.projectId, input.hackathonId],
      );
      if (!owners.length) throw new BuilderError('This project has no HQ owner to attach a Colosseum project to.');
      const ownerUserId = String(owners[0].owner_user_id);
      const snapshot = toSnapshotFields(project);
      const lead = project.members[0];
      const { rows: created } = await db.query(
        `INSERT INTO hq_project_onboarding(project_id,hackathon_id,external_id,project_url,slug,description,country,category,tracks,
           twitter_handle,website,repo_link,presentation_link,technical_demo_link,pitch_video_link,demo_video_link,image_url,
           external_hackathon_id,external_hackathon_slug,external_hackathon_name,submitted_at,completion_is_complete,completion_missing_count,
           submission_status,source_status,source_checked_at,source_attempted_at,raw,owner_user_id,verification,stage,lead_username)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21::timestamptz,$22,$23,$24,'ok',now(),now(),$25::jsonb,$26,'verified','idea',$27)
         ON CONFLICT (hackathon_id, external_id) DO NOTHING RETURNING project_id`,
        [input.projectId, input.hackathonId, project.externalId, input.projectUrl, snapshot.slug, snapshot.description, snapshot.country,
          snapshot.category, snapshot.tracks, snapshot.twitterHandle, snapshot.website, snapshot.repoLink, snapshot.presentationLink,
          snapshot.technicalDemoLink, snapshot.pitchVideoLink, snapshot.demoVideoLink, snapshot.imageUrl,
          snapshot.externalHackathonId, snapshot.externalHackathonSlug, snapshot.externalHackathonName, snapshot.submittedAt,
          snapshot.completionIsComplete, snapshot.completionMissingCount,
          interpretSubmission({ checked: true, submittedAt: snapshot.submittedAt }),
          JSON.stringify(snapshot.raw), ownerUserId, lead.username],
      );
      if (!created.length) throw new BuilderError('That Colosseum project is already in HQ for this hackathon, or this project already has one.');
      await db.query('UPDATE hq_projects SET name=$2 WHERE id=$1::uuid', [input.projectId, snapshot.name]);
      await upsertRoster(db, { projectId: input.projectId, hackathonId: input.hackathonId, members: project.members });
      await recordAuditEvent(db, {
        kind: 'project.source_attached',
        actor: { kind: 'operator', id: input.operatorId },
        hackathonId: input.hackathonId,
        projectId: input.projectId,
        subjectUserId: ownerUserId,
        metadata: { externalId: project.externalId, externalHackathonId: project.hackathon.id, rosterSize: project.members.length },
      });
      await db.query(`INSERT INTO hq_activity(hackathon_id,user_id,message) VALUES($1,$2::uuid,$3)`,
        [input.hackathonId, input.operatorId, `${snapshot.name} linked to its Colosseum project`]);
    });
  }

  /**
   * A fresh snapshot for a team that is already in HQ: a separate, idempotent
   * operation from importing, and never a second route into ownership.
   *
   * It rewrites the normalized source fields and upserts roster identities.
   * It deliberately does NOT touch `owner_user_id`, `verification`, `stage`,
   * `lead_username`, `high_potential`, notes, contacts or Captain
   * assignments, and it never deletes a roster row: "External roster changes
   * must not automatically grant or revoke HQ account access", so a member
   * who has since left the Colosseum roster keeps their claimed HQ
   * membership and their historical participation instead of being removed.
   */
  async refreshTeam(input: { projectId: string; hackathonId: number; project: ImportedProject; forJoining?: boolean }): Promise<SubmissionStatus> {
    const snapshot = toSnapshotFields(input.project);
    const submission = interpretSubmission({ checked: true, submittedAt: snapshot.submittedAt });
    await this.db.transaction(async db => {
      const { rows: existing } = await db.query(
        `SELECT external_id,external_hackathon_id FROM hq_project_onboarding
         WHERE project_id=$1::uuid AND hackathon_id=$2 FOR UPDATE`,
        [input.projectId, input.hackathonId],
      );
      if (!existing.length) throw new BuilderError('This team is no longer in HQ.');
      if (Number(existing[0].external_id) !== input.project.externalId
        || Number(existing[0].external_hackathon_id) !== input.project.hackathon.id) {
        throw new BuilderError('Colosseum returned a different project or hackathon for this link. Your saved team is unchanged. Ask an admin to check its Colosseum link.');
      }
      if (input.forJoining) {
        const { rows: config } = await db.query(`SELECT o.external_hackathon_id FROM hq_hackathon_onboarding o
          JOIN hq_hackathons h ON h.id=o.hackathon_id WHERE h.id=$1 AND h.archived_at IS NULL FOR SHARE OF o,h`, [input.hackathonId]);
        if (!config.length || config[0].external_hackathon_id == null) throw new ImportRefusedError('edition_not_configured');
        if (Number(config[0].external_hackathon_id) !== input.project.hackathon.id) throw new ImportRefusedError('wrong_edition');
        if (!isNetherlands(input.project.country)) throw new ImportRefusedError('not_dutch');
      }
      const { rows } = await db.query(
        `UPDATE hq_project_onboarding SET description=$2,country=$3,category=$4,tracks=$5,twitter_handle=$6,website=$7,repo_link=$8,
           presentation_link=$9,technical_demo_link=$10,pitch_video_link=$11,demo_video_link=$12,image_url=$13,slug=$14,
           external_hackathon_id=$15,external_hackathon_slug=$16,external_hackathon_name=$17,submitted_at=$18::timestamptz,
           completion_is_complete=$19,completion_missing_count=$20,submission_status=$21,
           source_status='ok',source_checked_at=now(),source_attempted_at=now(),source_error_code=NULL,source_error_message=NULL,raw=$22::jsonb
         WHERE project_id=$1::uuid RETURNING project_id`,
        [input.projectId, snapshot.description, snapshot.country, snapshot.category, snapshot.tracks, snapshot.twitterHandle,
          snapshot.website, snapshot.repoLink, snapshot.presentationLink, snapshot.technicalDemoLink, snapshot.pitchVideoLink,
          snapshot.demoVideoLink, snapshot.imageUrl, snapshot.slug, snapshot.externalHackathonId, snapshot.externalHackathonSlug,
          snapshot.externalHackathonName, snapshot.submittedAt, snapshot.completionIsComplete, snapshot.completionMissingCount,
          submission, JSON.stringify(snapshot.raw)],
      );
      if (!rows.length) throw new BuilderError('This team is no longer in HQ.');
      await db.query('UPDATE hq_projects SET name=$2 WHERE id=$1::uuid', [input.projectId, snapshot.name]);
      await upsertRoster(db, { projectId: input.projectId, hackathonId: input.hackathonId, members: input.project.members });
    });
    return submission;
  }

  /**
   * A failed refresh: record what went wrong and when it was attempted, and
   * change nothing else. "Failed refreshes retain the previous known status
   * and show freshness/error information rather than changing green to red",
   * so `submission_status` and `source_checked_at` (the last *successful*
   * read) are untouched here on purpose.
   */
  async recordSourceFailure(projectId: string, errorCode: string, sourceMessage: string | null): Promise<void> {
    await this.db.query(
      `UPDATE hq_project_onboarding SET source_status='error',source_attempted_at=now(),source_error_code=$2,source_error_message=$3 WHERE project_id=$1::uuid`,
      [projectId, errorCode, sourceMessage],
    );
  }

  async requestReview(user: BuilderIdentity, hackathonId: number, projectUrl: string, note: string) {
    await this.db.transaction(async db => {
      await enroll(db,user,hackathonId);
      await db.query(`INSERT INTO hq_project_import_requests(user_id,hackathon_id,project_url,note) VALUES($1,$2,$3,$4)
        ON CONFLICT(user_id,hackathon_id,project_url) DO UPDATE SET note=EXCLUDED.note,status='pending'`, [user.id,hackathonId,projectUrl,note]);
    });
  }

  /** The account's own teams for its dashboard: every claim it owns and every roster row it has joined, whatever the verification state. */
  async teams(userId: string): Promise<BuilderTeam[]> {
    const { rows } = await this.db.query(`${TEAM_SELECT} WHERE ${OWN_TEAM} ORDER BY o.created_at DESC`, [userId]);
    return rows.map(toTeam);
  }

  /**
   * The account's HQ projects that have no Colosseum snapshot yet: the ones
   * an operator created from a Request help submission.
   *
   * Deliberately a separate, smaller shape rather than a `BuilderTeam` with
   * empty strings in it. A `BuilderTeam` is the normalized Colosseum record,
   * and this project genuinely has none: no project URL, no roster, no
   * submission status. Saying so with a different type is honest; filling
   * those fields with placeholders would make every reader of `BuilderTeam`
   * responsible for spotting them.
   */
  async ownedProjects(userId: string): Promise<{ id: string; name: string; hackathonId: number; hackathonName: string }[]> {
    const { rows } = await this.db.query(
      `SELECT p.id::text AS id, p.name, p.hackathon_id, h.name AS hackathon_name
       FROM hq_project_ownership w JOIN hq_projects p ON p.id=w.project_id JOIN hq_hackathons h ON h.id=p.hackathon_id
       WHERE w.owner_user_id=$1 AND NOT EXISTS(SELECT 1 FROM hq_project_onboarding o WHERE o.project_id=w.project_id)
       ORDER BY w.created_at DESC`,
      [userId],
    );
    return rows.map(row => ({ id: String(row.id), name: String(row.name), hackathonId: Number(row.hackathon_id), hackathonName: String(row.hackathon_name) }));
  }

  /** One such project by id, with no relationship filter. Only for a caller that has already authorized the reader, like teamById above. */
  async projectById(projectId: string): Promise<{ id: string; name: string; hackathonId: number; hackathonName: string } | null> {
    const { rows } = await this.db.query(
      `SELECT p.id::text AS id, p.name, p.hackathon_id, h.name AS hackathon_name
       FROM hq_projects p JOIN hq_hackathons h ON h.id=p.hackathon_id WHERE p.id=$1::uuid`,
      [projectId],
    );
    return rows.length
      ? { id: String(rows[0].id), name: String(rows[0].name), hackathonId: Number(rows[0].hackathon_id), hackathonName: String(rows[0].hackathon_name) }
      : null;
  }

  /**
   * One imported team by id, with no relationship filter. Only for a caller
   * that has already authorized the reader through lib/hq/authz (see
   * lib/hq/member-teams.ts); never a member-facing read on its own.
   */
  async teamById(projectId: string): Promise<BuilderTeam | null> {
    const { rows } = await this.db.query(`${TEAM_SELECT} WHERE o.project_id=$1::uuid`, [projectId]);
    return rows.length ? toTeam(rows[0]) : null;
  }

  /** Any joined member or owner can share a reusable link for this project. */
  async createInvite(userId: string, projectId: string) {
    const code = await this.db.transaction(async db => {
      const { rows } = await db.query(`SELECT o.project_id FROM hq_project_onboarding o
        JOIN hq_hackathons h ON h.id=o.hackathon_id
        WHERE o.project_id=$1::uuid AND o.verification='verified' AND h.archived_at IS NULL
          AND (o.owner_user_id=$2 OR EXISTS(SELECT 1 FROM hq_project_members m WHERE m.project_id=o.project_id AND m.builder_user_id=$2))
        FOR UPDATE OF o`, [projectId,userId]);
      if (!rows.length) throw new BuilderError('Only a team member can create a join link.');
      const { rows: existing } = await db.query('SELECT share_code FROM hq_team_invites WHERE project_id=$1::uuid AND member_id IS NULL', [projectId]);
      if (existing.length && existing[0].share_code) return String(existing[0].share_code);
      const created = randomBytes(12).toString('hex').toUpperCase();
      await db.query(`INSERT INTO hq_team_invites(project_id,member_id,created_by,token_hash,expires_at,share_code)
        VALUES($1,NULL,$2,$3,NULL,$4)`, [projectId,userId,hashCode(created),created]);
      return created;
    });
    return code.match(/.{1,6}/g)!.join('-');
  }

  /** A valid bearer opens current unclaimed entries, never other accounts' identities. */
  async invitation(code: string): Promise<JoinLinkLookup> {
    const { rows } = await this.db.query(`SELECT i.id,i.member_id,i.project_id,i.consumed_at,
        i.expires_at IS NOT NULL AND i.expires_at<=now() AS expired,
        m.builder_user_id AS claimed_by,p.name AS project_name,o.project_url,o.hackathon_id,
        o.verification,h.archived_at IS NOT NULL AS archived
      FROM hq_team_invites i
      LEFT JOIN hq_project_members m ON m.id=i.member_id AND m.project_id=i.project_id
      JOIN hq_project_onboarding o ON o.project_id=i.project_id JOIN hq_projects p ON p.id=i.project_id
      JOIN hq_hackathons h ON h.id=o.hackathon_id
      WHERE i.token_hash=$1`, [hashCode(code)]);
    if (!rows.length) return { ok: false, reason: 'invalid' };
    const r = rows[0];
    if (r.consumed_at != null || (r.member_id != null && r.claimed_by != null)) return { ok: false, reason: 'used' };
    if (r.expired) return { ok: false, reason: 'expired' };
    if (r.archived || r.verification !== 'verified') return { ok: false, reason: 'other_edition' };
    const { rows: members } = await this.db.query(`SELECT id,name,colosseum_username,avatar_url FROM hq_project_members
      WHERE project_id=$1::uuid AND builder_user_id IS NULL AND source_present AND colosseum_username IS NOT NULL
        AND ($2::uuid IS NULL OR id=$2::uuid) ORDER BY sort,id`, [r.project_id,r.member_id]);
    return { ok: true, data: {
      id: String(r.id), projectId: String(r.project_id), projectName: String(r.project_name),
      projectUrl: String(r.project_url), hackathonId: Number(r.hackathon_id),
      members: members.map(member => ({ id: String(member.id), name: String(member.name), username: String(member.colosseum_username),
        avatarUrl: member.avatar_url == null ? null : String(member.avatar_url) })),
    } };
  }

  async joinedSeat(projectId: string, userId: string): Promise<string | null> {
    const { rows } = await this.db.query('SELECT id FROM hq_project_members WHERE project_id=$1::uuid AND builder_user_id=$2', [projectId,userId]);
    return rows.length ? String(rows[0].id) : null;
  }

  async redeemInvite(user: BuilderIdentity, code: string, memberId: string) {
    return this.db.transaction(async db => {
      const { rows } = await db.query(`SELECT i.id,i.member_id,i.project_id,o.hackathon_id,o.country,
          o.external_hackathon_id,config.external_hackathon_id AS configured_external_id FROM hq_team_invites i
        JOIN hq_project_onboarding o ON o.project_id=i.project_id JOIN hq_hackathons h ON h.id=o.hackathon_id
        JOIN hq_hackathon_onboarding config ON config.hackathon_id=o.hackathon_id
        WHERE i.token_hash=$1 AND i.consumed_at IS NULL AND (i.expires_at IS NULL OR i.expires_at>now())
          AND o.verification='verified' AND h.archived_at IS NULL FOR UPDATE OF i,o FOR SHARE OF config,h`, [hashCode(code)]);
      if (!rows.length) throw new BuilderError('This join link is no longer usable. Ask your team for a new one.');
      const invite = rows[0];
      if (invite.configured_external_id == null) throw new ImportRefusedError('edition_not_configured');
      if (Number(invite.configured_external_id) !== Number(invite.external_hackathon_id)) throw new ImportRefusedError('wrong_edition');
      if (!isNetherlands(invite.country == null ? null : String(invite.country))) throw new ImportRefusedError('not_dutch');
      if (invite.member_id != null && String(invite.member_id) !== memberId) throw new BuilderError('This older join link is for a different teammate. Ask for the team link.');
      // The onboarding lock serializes claims with each other and with a
      // Captain assignment. The unique account/seat indexes remain the last
      // line of defence; every person and membership write is atomic here.
      await claimRosterSeat(db,user,{ projectId: String(invite.project_id), memberId, hackathonId: Number(invite.hackathon_id) });
      if (invite.member_id != null) {
        await db.query('UPDATE hq_team_invites SET consumed_at=now(),consumed_by=$1 WHERE id=$2', [user.id,invite.id]);
      }
      await db.query('INSERT INTO hq_activity(hackathon_id,message) VALUES($1,$2)', [invite.hackathon_id,`${user.name} joined an imported team`]);
      return String(invite.project_id);
    });
  }

  async dashboard(userId: string) {
    const [profile, requests, enrollments, events] = await Promise.all([
      this.db.query('SELECT tier FROM hq_builder_profiles WHERE id=$1', [userId]),
      this.db.query(`SELECT r.id,r.hackathon_id,r.project_url,r.status,h.name FROM hq_project_import_requests r JOIN hq_hackathons h ON h.id=r.hackathon_id WHERE r.user_id=$1 ORDER BY r.created_at DESC`, [userId]),
      this.db.query('SELECT hackathon_id,participation FROM hq_builder_enrollments WHERE user_id=$1', [userId]),
      this.db.query('SELECT e.id,e.hackathon_id,e.title,e.status,h.name FROM hq_event_host_requests e JOIN hq_hackathons h ON h.id=e.hackathon_id WHERE e.user_id=$1 ORDER BY e.created_at DESC', [userId]),
    ]);
    return { tier: String(profile.rows[0]?.tier??'regular'), requests:requests.rows, enrollments:enrollments.rows, events:events.rows };
  }

  /** The last line of defence behind `authorizedTeam(... 'membership.change')`: the same verified-owner predicate the decision makes, so a caller that forgot the decision gets no looser rule. */
  async updateTeam(userId: string, projectId: string, stage: ProjectStage, leadUsername: string) {
    await this.db.transaction(async db => {
      const { rows } = await db.query(`UPDATE hq_project_onboarding o SET stage=$1,lead_username=$2
        WHERE o.project_id=$3 AND o.owner_user_id=$4 AND o.verification='verified'
          AND EXISTS(SELECT 1 FROM hq_project_members m WHERE m.project_id=o.project_id AND m.colosseum_username=$2)
        RETURNING project_id`, [stage,leadUsername,projectId,userId]);
      if (!rows.length) throw new BuilderError('Choose a lead from your imported team.');
      await db.query(`UPDATE hq_projects SET lead_name=(SELECT name FROM hq_project_members WHERE project_id=$1 AND colosseum_username=$2)
        WHERE id=$1`, [projectId,leadUsername]);
    });
  }
}

export function builderStore() { return new BuilderStore(builderDatabase()); }
export async function syncBuilderAccount(user: BuilderIdentity) { await builderStore().syncAccount(user); }
