import 'server-only';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { ImportedProject, ProjectProof } from '@/lib/colosseum-api';
import { builderDatabase, type BuilderDatabase, type BuilderQuery } from './builder-db';
import { BuilderError, type BuilderHackathon, type BuilderIdentity, type BuilderTeam, type BuilderUser, type ProjectStage } from './builder-types';
import { ensurePersonForAccount } from './crm-identity';
import { isPlaceholderEmail } from './placeholder-email';

// The pool and its handle types live in builder-db.ts; they are re-exported
// here so every existing import path keeps working.
export { BuilderError, builderDatabase };
export type { BuilderDatabase, BuilderQuery };

const hashCode = (code: string) => createHash('sha256').update(code.toUpperCase().replace(/[\s-]/g, '')).digest('hex');
const asDate = (value: unknown) => value ? new Date(String(value)).toISOString() : null;
/** An address the CRM may hold or show: a real email, or nothing. The internal placeholder never reaches a row or a page. */
export const realEmail = (value: unknown): string | null => typeof value === 'string' && value !== '' && !isPlaceholderEmail(value) ? value : null;

const TEAM_SELECT = `SELECT o.*,p.name,h.name AS hackathon_name,
      (SELECT json_agg(json_build_object('id',m.id,'name',m.name,'username',m.colosseum_username,'joined',m.builder_user_id IS NOT NULL) ORDER BY m.sort)
       FROM hq_project_members m WHERE m.project_id=p.id) AS members
      FROM hq_project_onboarding o JOIN hq_projects p ON p.id=o.project_id JOIN hq_hackathons h ON h.id=o.hackathon_id`;
// The one relationship that makes a team the account's own, shared by
// teams() and hasTeams() so the menu and the dashboard cannot disagree.
const OWN_TEAM = `(o.owner_user_id=$1 OR EXISTS(SELECT 1 FROM hq_project_members m WHERE m.project_id=o.project_id AND m.builder_user_id=$1))`;
const toTeam = (r: Record<string, unknown>): BuilderTeam => ({ id: String(r.project_id), name: String(r.name), hackathonId: Number(r.hackathon_id), hackathonName: String(r.hackathon_name),
  projectUrl: String(r.project_url), description: String(r.description), stage: r.stage as ProjectStage, verification: r.verification as BuilderTeam['verification'],
  ownerId: String(r.owner_user_id), leadUsername: String(r.lead_username), members: (r.members ?? []) as BuilderTeam['members'] });

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

async function enroll(db: BuilderQuery, user: BuilderIdentity, hackathonId: number, participation: 'builder' | 'supporter' = 'builder') {
  const { rows: editions } = await db.query('SELECT id FROM hq_hackathons WHERE id=$1 AND archived_at IS NULL', [hackathonId]);
  if (!editions.length) throw new BuilderError('Choose an available hackathon.');
  await db.query(`INSERT INTO hq_builder_enrollments(user_id,hackathon_id,participation) VALUES($1,$2,$3)
    ON CONFLICT(user_id,hackathon_id) DO UPDATE SET participation=EXCLUDED.participation`, [user.id, hackathonId, participation]);
  const label = participation === 'builder' ? 'Builder' : 'Community';
  const { rows: roles } = await db.query(`INSERT INTO hq_people_roles(label,filter_label,color,bg,is_judge,sort)
    VALUES($1,$2,'accent','accent-fill',false,100)
    ON CONFLICT(label) DO UPDATE SET label=EXCLUDED.label RETURNING id`, [label, participation === 'builder' ? 'Builders' : 'Community']);
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
    [hackathonId, user.id, user.name, roles[0].id, realEmail(user.email) ?? '', personId]);
}

/** All mutations are atomic and use authenticated IDs supplied by server actions. */
export class BuilderStore {
  constructor(private readonly db: BuilderDatabase) {}

  /** Mirrors the login identity onto the profile and guarantees its CRM person. contact_email is self-declared and never touched here. */
  async syncAccount(user: BuilderIdentity): Promise<void> {
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

  async issueChallenge(user: BuilderIdentity, hackathonId: number, project: ImportedProject, username: string) {
    const member = project.members.find(m => m.username.toLowerCase() === username.toLowerCase());
    if (!member) throw new BuilderError('Choose your profile from the Colosseum team.');
    const { rows: existing } = await this.db.query(`SELECT project_id FROM hq_project_onboarding WHERE hackathon_id=$1 AND external_id=$2 AND verification='verified'`, [hackathonId, project.externalId]);
    if (existing.length) throw new BuilderError('This team is already in HQ. Ask its owner for an invite code.');
    const code = String(randomInt(10_000_000, 100_000_000));
    const { rows } = await this.db.query(`INSERT INTO hq_project_challenges(user_id,hackathon_id,project_url,external_id,claimed_username,code)
      VALUES($1,$2,$3,$4,$5,$6) RETURNING id,issued_at,expires_at`,
      [user.id, hackathonId, `https://colosseum.com/arena/projects/explore/${project.slug}`, project.externalId, member.username, code]);
    return { id: String(rows[0].id), code, issuedAt: asDate(rows[0].issued_at)!, expiresAt: asDate(rows[0].expires_at)! };
  }

  async challenge(userId: string, id: string) {
    const { rows } = await this.db.query(`SELECT * FROM hq_project_challenges WHERE id=$1 AND user_id=$2 AND consumed_at IS NULL AND expires_at>now()`, [id,userId]);
    if (!rows.length) throw new BuilderError('This verification code expired. Load your project again for a new code.');
    const r = rows[0];
    return { id: String(r.id), hackathonId: Number(r.hackathon_id), projectUrl: String(r.project_url), externalId: Number(r.external_id),
      username: String(r.claimed_username), code: String(r.code), issuedAt: asDate(r.issued_at)! };
  }

  async importTeam(user: BuilderIdentity, challengeId: string, project: ImportedProject, leadUsername: string, stage: ProjectStage, proof: ProjectProof | null) {
    return this.db.transaction(async db => {
      const { rows: challenges } = await db.query(`UPDATE hq_project_challenges SET consumed_at=now()
        WHERE id=$1 AND user_id=$2 AND consumed_at IS NULL AND expires_at>now() AND external_id=$3 RETURNING *`, [challengeId,user.id,project.externalId]);
      if (!challenges.length) throw new BuilderError('This code has expired or has already been used.');
      const challenge = challenges[0];
      const lead = project.members.find(m => m.username === leadUsername);
      const owner = project.members.find(m => m.username === challenge.claimed_username);
      if (!lead || !owner) throw new BuilderError('The Colosseum roster changed. Load your project again.');
      if (proof && (proof.username.toLowerCase() !== owner.username.toLowerCase() || project.country?.toLowerCase() !== 'netherlands')) {
        throw new BuilderError('Register the project under Netherlands before verifying.');
      }
      const { rows: config } = await db.query(`SELECT o.* FROM hq_hackathon_onboarding o JOIN hq_hackathons h ON h.id=o.hackathon_id
        WHERE h.id=$1 AND h.archived_at IS NULL FOR SHARE OF o,h`, [challenge.hackathon_id]);
      if (!config.length || Number(config[0].external_hackathon_id) !== project.hackathon.id || config[0].external_hackathon_slug !== project.hackathon.slug) {
        throw new BuilderError('This project belongs to a different hackathon.');
      }
      if (!config[0].projects_open || (config[0].projects_available_at && new Date(String(config[0].projects_available_at)).getTime() > Date.now())) {
        throw new BuilderError('Project imports are not open. Your account is ready; try again when imports open.');
      }
      const { rows: prior } = await db.query(`SELECT project_id,verification FROM hq_project_onboarding WHERE hackathon_id=$1 AND external_id=$2 FOR UPDATE`, [challenge.hackathon_id,project.externalId]);
      // Same lock order as lib/hq/captains.ts#assignCaptain (see its header
      // comment): this FOR UPDATE is the row that service also locks before
      // deciding whether to assign, so by the time we read
      // hq_captain_assignments below it is real, committed state, not a
      // pre-race snapshot. A brand new project (no prior row) can never have
      // an existing Captain, so the check only applies to recovering one.
      if (prior.length) {
        const { rows: captaining } = await db.query(
          `SELECT 1 FROM hq_captain_assignments WHERE project_id=$1 AND captain_user_id=$2 AND unassigned_at IS NULL`,
          [prior[0].project_id, user.id],
        );
        if (captaining.length) throw new BuilderError('You currently hold the Captain role for this project. Ask an admin to reassign the Captain before claiming it as a team member.');
      }
      if (prior.length && (prior[0].verification === 'verified' || !proof)) {
        throw new BuilderError(prior[0].verification === 'verified' ? 'This team is already verified. Ask its owner for an invite.' : 'This team is awaiting review. Verify your Colosseum comment to claim it, or contact Superteam NL.');
      }
      // A genuine roster member can recover an unapproved claim with proof.
      // A pending request alone never reserves ownership of a public project.
      const id = prior.length ? String(prior[0].project_id) : randomUUID();
      const { rows: status } = await db.query(`INSERT INTO hq_project_statuses(slug,label,color,counts_as_active,sort)
        VALUES('onboarding','Onboarding','accent',true,100) ON CONFLICT(slug) DO UPDATE SET slug=EXCLUDED.slug RETURNING id`);
      const { rows: forecast } = await db.query(`INSERT INTO hq_project_forecasts(slug,label,color,sort)
        VALUES('unassessed','Not assessed','muted',100) ON CONFLICT(slug) DO UPDATE SET slug=EXCLUDED.slug RETURNING id`);
      await db.query(`INSERT INTO hq_projects(id,hackathon_id,name,lead_name,status_id,forecast_id,last_check_in)
        VALUES($1,$2,$3,$4,$5,$6,current_date) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,lead_name=EXCLUDED.lead_name`, [id,challenge.hackathon_id,project.name,lead.displayName,status[0].id,forecast[0].id]);
      await db.query(`INSERT INTO hq_project_onboarding(project_id,hackathon_id,external_id,project_url,slug,description,country,raw,owner_user_id,verification,stage,lead_username,proof_comment_id,proof_author_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14)
        ON CONFLICT(project_id) DO UPDATE SET raw=EXCLUDED.raw,description=EXCLUDED.description,country=EXCLUDED.country,project_url=EXCLUDED.project_url,slug=EXCLUDED.slug,
          owner_user_id=EXCLUDED.owner_user_id,verification=EXCLUDED.verification,stage=EXCLUDED.stage,lead_username=EXCLUDED.lead_username,
          proof_comment_id=EXCLUDED.proof_comment_id,proof_author_id=EXCLUDED.proof_author_id`,
        [id,challenge.hackathon_id,project.externalId,challenge.project_url,project.slug,project.description,project.country,JSON.stringify(project.raw),user.id,proof ? 'verified':'pending',stage,lead.username,proof?.commentId??null,proof?.authorId??null]);
      if (prior.length) await db.query('DELETE FROM hq_project_members WHERE project_id=$1', [id]);
      for (const [sort, member] of project.members.entries()) {
        const isOwner = member.username === owner.username;
        await db.query(`INSERT INTO hq_project_members(project_id,name,colosseum_username,sort,builder_user_id,joined_at)
          VALUES($1,$2,$3,$4,$5,CASE WHEN $5::text IS NULL THEN NULL ELSE now() END)`, [id,member.displayName,member.username,sort,isOwner ? user.id:null]);
      }
      await enroll(db,user,Number(challenge.hackathon_id));
      await db.query(`INSERT INTO hq_activity(hackathon_id,message) VALUES($1,$2)`, [challenge.hackathon_id,`${project.name} imported from Colosseum${proof ? ' and verified' : ', awaiting approval'}`]);
      return id;
    });
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

  /** Whether teams() would return anything, without loading a team or its roster: the menu asks only this, on every member request. */
  async hasTeams(userId: string): Promise<boolean> {
    const { rows } = await this.db.query(`SELECT EXISTS(SELECT 1 FROM hq_project_onboarding o WHERE ${OWN_TEAM}) AS found`, [userId]);
    return Boolean(rows[0].found);
  }

  async team(userId: string, id: string) {
    const team = (await this.teams(userId)).find(t => t.id === id);
    if (!team) throw new BuilderError('This team is not available to your account.');
    return team;
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

  /**
   * The account's own claim on a project that is not, or no longer, verified:
   * the import it submitted, awaiting or refused review. Read by account like
   * the dashboard's import requests, it shows the claimant their own
   * submission and its status; it authorizes nothing on the project, and a
   * verified team is never returned here.
   */
  async ownClaim(userId: string, projectId: string): Promise<BuilderTeam | null> {
    const { rows } = await this.db.query(`${TEAM_SELECT} WHERE o.project_id=$1::uuid AND o.owner_user_id=$2 AND o.verification<>'verified'`, [projectId, userId]);
    return rows.length ? toTeam(rows[0]) : null;
  }

  async createInvite(userId: string, projectId: string, memberId: string) {
    const code = randomBytes(12).toString('hex').toUpperCase();
    await this.db.transaction(async db => {
      const { rows } = await db.query(`SELECT m.id FROM hq_project_members m JOIN hq_project_onboarding o ON o.project_id=m.project_id
        JOIN hq_hackathons h ON h.id=o.hackathon_id
        WHERE m.id=$1 AND m.project_id=$2 AND o.owner_user_id=$3 AND o.verification='verified'
        AND m.builder_user_id IS NULL AND m.colosseum_username IS NOT NULL AND h.archived_at IS NULL FOR UPDATE OF m`, [memberId,projectId,userId]);
      if (!rows.length) throw new BuilderError('Only the owner of a verified team can invite an unclaimed teammate.');
      await db.query(`DELETE FROM hq_team_invites WHERE member_id=$1 AND consumed_at IS NULL`, [memberId]);
      await db.query(`INSERT INTO hq_team_invites(project_id,member_id,created_by,token_hash) VALUES($1,$2,$3,$4)`, [projectId,memberId,userId,hashCode(code)]);
    });
    return code.match(/.{1,6}/g)!.join('-');
  }

  async invitation(code: string) {
    const { rows } = await this.db.query(`SELECT i.id,i.member_id,i.project_id,m.name,m.colosseum_username,p.name AS project_name,o.project_url,o.hackathon_id
      FROM hq_team_invites i JOIN hq_project_members m ON m.id=i.member_id AND m.project_id=i.project_id
      JOIN hq_project_onboarding o ON o.project_id=i.project_id JOIN hq_projects p ON p.id=i.project_id
      JOIN hq_hackathons h ON h.id=o.hackathon_id
      WHERE i.token_hash=$1 AND i.consumed_at IS NULL AND i.expires_at>now() AND m.builder_user_id IS NULL
        AND o.verification='verified' AND h.archived_at IS NULL`, [hashCode(code)]);
    if (!rows.length) throw new BuilderError('This invite is invalid, expired or already used. Ask your team for a new code.');
    const r = rows[0];
    return { id: String(r.id),memberId:String(r.member_id),projectId:String(r.project_id),name:String(r.name),username:String(r.colosseum_username),projectName:String(r.project_name),projectUrl:String(r.project_url),hackathonId:Number(r.hackathon_id) };
  }

  async redeemInvite(user: BuilderIdentity, code: string) {
    return this.db.transaction(async db => {
      const { rows } = await db.query(`SELECT i.id,i.member_id,i.project_id,o.hackathon_id FROM hq_team_invites i
        JOIN hq_project_onboarding o ON o.project_id=i.project_id JOIN hq_hackathons h ON h.id=o.hackathon_id
        WHERE i.token_hash=$1 AND i.consumed_at IS NULL AND i.expires_at>now() AND o.verification='verified'
          AND h.archived_at IS NULL FOR UPDATE OF i,o`, [hashCode(code)]);
      if (!rows.length) throw new BuilderError('This invite has expired or has already been used.');
      const invite = rows[0];
      // Same lock order as lib/hq/captains.ts#assignCaptain (see its header
      // comment): this FOR UPDATE OF i,o is the same hq_project_onboarding
      // row that service also locks before deciding whether to assign, so by
      // the time we read hq_captain_assignments below it is real, committed
      // state, not a pre-race snapshot. "If a Captain would become a member
      // of their assigned project, require reassignment first" — this is
      // that refusal. The message is shown to the member joining, who is
      // themself the Captain here, so naming their own role is accurate and
      // names no one else.
      const { rows: captaining } = await db.query(
        `SELECT 1 FROM hq_captain_assignments WHERE project_id=$1 AND captain_user_id=$2 AND unassigned_at IS NULL`,
        [invite.project_id, user.id],
      );
      if (captaining.length) throw new BuilderError('You currently hold the Captain role for this project. Ask an admin to reassign the Captain before joining as a team member.');
      const { rows: claimed } = await db.query(`UPDATE hq_project_members SET builder_user_id=$1,joined_at=now()
        WHERE id=$2 AND project_id=$3 AND builder_user_id IS NULL RETURNING id`, [user.id,invite.member_id,invite.project_id]);
      if (!claimed.length) throw new BuilderError('This teammate has already joined.');
      await db.query('UPDATE hq_team_invites SET consumed_at=now(),consumed_by=$1 WHERE id=$2', [user.id,invite.id]);
      await enroll(db,user,Number(invite.hackathon_id));
      await db.query('INSERT INTO hq_activity(hackathon_id,message) VALUES($1,$2)', [invite.hackathon_id,`${user.name} joined an imported team`]);
      return String(invite.project_id);
    });
  }

  async dashboard(userId: string) {
    const [profile, requests, enrollments, events] = await Promise.all([
      this.db.query('SELECT tier FROM hq_builder_profiles WHERE id=$1', [userId]),
      this.db.query(`SELECT r.id,r.project_url,r.status,h.name FROM hq_project_import_requests r JOIN hq_hackathons h ON h.id=r.hackathon_id WHERE r.user_id=$1 ORDER BY r.created_at DESC`, [userId]),
      this.db.query('SELECT hackathon_id,participation FROM hq_builder_enrollments WHERE user_id=$1', [userId]),
      this.db.query('SELECT id,title,status FROM hq_event_host_requests WHERE user_id=$1 ORDER BY created_at DESC', [userId]),
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

  async requestEvent(userId: string, hackathonId: number, title: string, details: string) {
    const { rows } = await this.db.query(`INSERT INTO hq_event_host_requests(user_id,hackathon_id,title,details)
      SELECT p.id,o.hackathon_id,$3,$4 FROM hq_builder_profiles p JOIN hq_builder_enrollments e ON e.user_id=p.id
      JOIN hq_hackathon_onboarding o ON o.hackathon_id=e.hackathon_id JOIN hq_hackathons h ON h.id=o.hackathon_id
      WHERE p.id=$1 AND p.tier='member' AND o.hackathon_id=$2 AND o.hosting_enabled AND h.archived_at IS NULL RETURNING id`, [userId,hackathonId,title,details]);
    if (!rows.length) throw new BuilderError('Event applications are not open for this account and hackathon.');
  }
}

export function builderStore() { return new BuilderStore(builderDatabase()); }
export async function syncBuilderAccount(user: BuilderIdentity) { await builderStore().syncAccount(user); }
