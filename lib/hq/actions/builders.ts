"use server";

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { assertProjectHackathon, ColosseumApiError, fetchColosseumProject, parseColosseumProjectUrl } from '@/lib/colosseum-api';
import { requireMemberActor } from '../actor';
import { requireMember } from '../member-auth';
import { authorizedTeam, TEAM_NOT_AVAILABLE } from '../member-teams';
import { BuilderError, builderStore, syncBuilderAccount } from '../builder-store';
import { JOIN_LINK_MESSAGES, PROJECT_STAGES, type BuilderResult, type JoinLinkRefusal } from '../builder-types';
import { importColosseumTeam, inviteRetry, refreshColosseumTeam, type ImportFailureReason } from '../project-import';
import { parseJoinCode } from '../member-routes';

// Actions that take a team id from the client go through the central
// authorization helper (lib/hq/member-teams.ts over lib/hq/authz.ts) before
// any read or write: the edition the member asked under travels in the body
// and is checked against the project, and every denial is the same
// TEAM_NOT_AVAILABLE result, so a foreign, other-edition or unknown id
// reveals nothing. The store's own ownership predicates still run inside the
// write transaction as the last line of defence, not as the decision.

const uuid = z.string().uuid();
const hackathonIdSchema = z.number().int().positive();
const stageSchema = z.enum(PROJECT_STAGES.map(s => s.value));
/** A pasted join link or bare code: normalised in member-routes.ts before it reaches the store. */
const joinInputSchema = z.string().trim().min(1).max(2048);
const fail = (error: unknown): {ok:false;error:string} => ({ ok:false, error: error instanceof BuilderError || error instanceof ColosseumApiError
  ? error.message : error instanceof z.ZodError ? 'Check the details and try again.' : 'We could not save this. Please try again.' });
function refresh() { revalidatePath('/hq', 'layout'); }

export async function chooseBuilderPath(input: { hackathonId: number; path: 'initialize'|'join'|'supporter' }): Promise<BuilderResult<{url:string}>> {
  const user = await requireMember();
  try {
    const parsed = z.object({hackathonId:hackathonIdSchema,path:z.enum(['initialize','join','supporter'])}).parse(input);
    await syncBuilderAccount(user);
    await builderStore().hackathon(parsed.hackathonId);
    if (parsed.path==='supporter') await builderStore().enroll(user,parsed.hackathonId,'supporter');
    refresh();
    return {ok:true,data:{url:parsed.path==='supporter'?'/hq/dashboard':`/hq/${parsed.path}?hackathon=${parsed.hackathonId}`}};
  } catch (error) { return fail(error); }
}

/**
 * The whole self-service import, in one call: fetch, gate on country plus the
 * configured external edition id, write. No preview step, no teammate
 * selection, no verification code, no approval — "A Dutch project in the
 * current edition imports in one step".
 *
 * The result carries `reason` as well as `error` so the screen can answer
 * each failure differently: `already_imported` renders the Telegram group
 * control instead of a retry, and `retry` marks the transport failures that
 * are worth trying again. The reason is a fixed HQ vocabulary
 * (`ImportFailureReason`), never upstream text.
 */
export async function importBuilderTeam(input: {hackathonId:number;url:string}): Promise<
  BuilderResult<{url:string}> | {ok:false;error:string;reason:ImportFailureReason;retry:boolean}
> {
  const user = await requireMember();
  try {
    const parsed = z.object({hackathonId:hackathonIdSchema,url:z.string().max(2048)}).parse(input);
    const store = builderStore();
    await store.rateLimit(user.id,'import',15);
    await syncBuilderAccount(user);
    const outcome = await importColosseumTeam(user, parsed);
    if (!outcome.ok) return {ok:false, error: outcome.message, reason: outcome.reason, retry: inviteRetry(outcome.reason)};
    refresh();
    return {ok:true,data:{url:`/hq/team/${outcome.projectId}`}};
  } catch (error) { return fail(error); }
}

/**
 * A fresh Colosseum snapshot and submission check for a team the caller is
 * already a member of. Rate limited, idempotent, and separate from importing:
 * it never creates a team and never changes who belongs to one.
 */
export async function refreshBuilderTeam(input: {projectId:string;hackathonId:number}): Promise<
  BuilderResult<{submission:string}> | {ok:false;error:string;reason:ImportFailureReason;retry:boolean}
> {
  const actor = await requireMemberActor();
  try {
    const value = z.object({projectId:uuid,hackathonId:hackathonIdSchema}).parse(input);
    const team = await authorizedTeam(actor,{projectId:value.projectId,hackathonId:value.hackathonId,action:'read'});
    if (!team) throw new BuilderError(TEAM_NOT_AVAILABLE);
    await builderStore().rateLimit(actor.id,'source',10);
    const outcome = await refreshColosseumTeam({projectId:team.id,hackathonId:team.hackathonId,projectUrl:team.projectUrl});
    refresh();
    if (!outcome.ok) return {ok:false, error: outcome.message, reason: outcome.reason, retry: inviteRetry(outcome.reason)};
    return {ok:true,data:{submission:outcome.submission}};
  } catch (error) { return fail(error); }
}

export async function requestBuilderReview(input:{hackathonId:number;url:string;note:string}): Promise<BuilderResult<{url:string}>> {
  const user = await requireMember();
  try {
    const parsed = z.object({hackathonId:hackathonIdSchema,url:z.string().max(400),note:z.string().trim().min(5).max(1500)}).parse(input);
    const slug = parseColosseumProjectUrl(parsed.url);
    const store = builderStore();
    await store.rateLimit(user.id,'review',5);
    await syncBuilderAccount(user);
    await store.requestReview(user,parsed.hackathonId,`https://colosseum.com/arena/projects/explore/${slug}`,parsed.note);
    refresh();
    return {ok:true,data:{url:'/hq/dashboard'}};
  } catch (error) { return fail(error); }
}

/** One join link per unclaimed roster seat, created by the team's own importer. Returns the path; the page makes it absolute. */
export async function createBuilderInvite(input:{projectId:string;hackathonId:number;memberId:string}): Promise<BuilderResult<{code:string}>> {
  const actor = await requireMemberActor();
  try {
    const {projectId,hackathonId,memberId} = z.object({projectId:uuid,hackathonId:hackathonIdSchema,memberId:uuid}).parse(input);
    const store = builderStore();
    await store.rateLimit(actor.id,'invite',20);
    // Creating a join link is a membership change: the team lead's alone.
    const team = await authorizedTeam(actor,{projectId,hackathonId,action:'membership.change'});
    if (!team) throw new BuilderError(TEAM_NOT_AVAILABLE);
    const member = team.members.find(m=>m.id===memberId);
    if (!member) throw new BuilderError('Choose a teammate from your imported team.');
    return {ok:true,data:{code:await store.createInvite(actor.id,projectId,memberId)}};
  } catch (error) { return fail(error); }
}

/**
 * What a join link opens, or why it cannot be used. Accepts the whole pasted
 * link or a bare code (see `parseJoinCode`), and every refusal is its own
 * message that names nothing about the team.
 */
export async function previewBuilderInvite(pasted:string): Promise<
  BuilderResult<{name:string;username:string;team:string;code:string}> | {ok:false;error:string;reason:JoinLinkRefusal}
> {
  const user = await requireMember();
  try {
    const code = parseJoinCode(joinInputSchema.parse(pasted));
    if (!code) return {ok:false, error: JOIN_LINK_MESSAGES.invalid, reason: 'invalid'};
    const store = builderStore();
    await store.rateLimit(user.id,'join',20);
    const invite = await store.invitation(code);
    if (!invite.ok) return {ok:false, error: JOIN_LINK_MESSAGES[invite.reason], reason: invite.reason};
    return {ok:true,data:{name:invite.data.name,username:invite.data.username,team:invite.data.projectName,code}};
  } catch (error) { return fail(error); }
}

export async function acceptBuilderInvite(input:{code:string;confirmed:boolean}): Promise<BuilderResult<{url:string}>> {
  const user = await requireMember();
  try {
    const {code:pasted} = z.object({code:joinInputSchema,confirmed:z.literal(true)}).parse(input);
    const code = parseJoinCode(pasted);
    if (!code) throw new BuilderError(JOIN_LINK_MESSAGES.invalid);
    const store = builderStore();
    await store.rateLimit(user.id,'redeem',12);
    await syncBuilderAccount(user);
    const invite = await store.invitation(code);
    if (!invite.ok) throw new BuilderError(JOIN_LINK_MESSAGES[invite.reason]);
    // The roster the seat belongs to is re-read from Colosseum, so a seat
    // that no longer exists upstream cannot be claimed. A transport failure
    // here is the adapter's own distinct message, not a generic one.
    const project = await fetchColosseumProject(invite.data.projectUrl);
    const edition = await store.hackathon(invite.data.hackathonId);
    assertProjectHackathon(project,{externalId:edition.externalId??0,slug:edition.externalSlug??''});
    if (!project.members.some(m=>m.username===invite.data.username)) throw new BuilderError('That teammate is no longer listed on the Colosseum team. Ask whoever sent you the link for help.');
    const id = await store.redeemInvite(user,code);
    refresh();
    return {ok:true,data:{url:`/hq/team/${id}`}};
  } catch (error) { return fail(error); }
}

export async function saveBuilderTeam(input:{projectId:string;hackathonId:number;stage:string;leadUsername:string}):Promise<BuilderResult<{saved:true}>> {
  const actor = await requireMemberActor();
  try {
    const value = z.object({projectId:uuid,hackathonId:hackathonIdSchema,stage:stageSchema,leadUsername:z.string().min(1).max(120)}).parse(input);
    // Choosing the lead is a membership change: the verified team lead's alone.
    if (!(await authorizedTeam(actor,{projectId:value.projectId,hackathonId:value.hackathonId,action:'membership.change'}))) throw new BuilderError(TEAM_NOT_AVAILABLE);
    await builderStore().updateTeam(actor.id,value.projectId,value.stage,value.leadUsername);
    refresh();
    return {ok:true,data:{saved:true}};
  } catch (error) { return fail(error); }
}

export async function requestBuilderEvent(input:{hackathonId:number;title:string;details:string}):Promise<BuilderResult<{saved:true}>> {
  const user = await requireMember();
  try {
    const value = z.object({hackathonId:hackathonIdSchema,title:z.string().trim().min(3).max(120),details:z.string().trim().min(10).max(3000)}).parse(input);
    await builderStore().rateLimit(user.id,'event',5);
    await builderStore().requestEvent(user.id,value.hackathonId,value.title,value.details);
    refresh();
    return {ok:true,data:{saved:true}};
  } catch (error) { return fail(error); }
}
