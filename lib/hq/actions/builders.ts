"use server";

import { refreshHq } from '../revalidation';
import { z } from 'zod';
import { ColosseumApiError, colosseumProjectUrl, parseColosseumProjectUrl } from '@/lib/colosseum-api';
import { requireMemberActor } from '../actor';
import { isTeamMember } from '../authz';
import { requireMember } from '../member-auth';
import { getTelegramIdentity } from '../identity';
import { authorizedTeam, TEAM_NOT_AVAILABLE } from '../member-teams';
import { BuilderError, builderStore } from '../builder-store';
import { JOIN_LINK_MESSAGES, PROJECT_STAGES, type BuilderResult, type JoinLinkRefusal } from '../builder-types';
import { importColosseumTeam, inviteRetry, previewColosseumTeam, previewTeamInvitation, type ImportFailureReason } from '../project-import';
import { parseJoinCode } from '../member-routes';

// Team actions authorize before access and return TEAM_NOT_AVAILABLE for
// every denial; the store also enforces ownership inside its transaction.

const uuid = z.string().uuid();
const hackathonIdSchema = z.number().int().positive();
const stageSchema = z.enum(PROJECT_STAGES.map(s => s.value));
/** A pasted join link or bare code: normalised in member-routes.ts before it reaches the store. */
const joinInputSchema = z.string().trim().min(1).max(2048);
const fail = (error: unknown): {ok:false;error:string} => ({ ok:false, error: error instanceof BuilderError || error instanceof ColosseumApiError
  ? error.message : error instanceof z.ZodError ? 'Check the details and try again.' : 'We could not save this. Please try again.' });

/** Validate the project before asking the member to choose their Colosseum profile. */
export async function previewBuilderImport(input:{hackathonId:number;url:string}): Promise<
  BuilderResult<{name:string;projectUrl:string;members:{username:string;name:string;avatarUrl:string|null}[]}> |
  {ok:false;error:string;reason:ImportFailureReason;retry:boolean}
> {
  const user = await requireMember();
  try {
    const parsed = z.object({hackathonId:hackathonIdSchema,url:z.string().max(2048)}).parse(input);
    await builderStore().rateLimit(user.id,'import',15);
    const outcome = await previewColosseumTeam(parsed);
    if (!outcome.ok) return {ok:false,error:outcome.message,reason:outcome.reason,retry:inviteRetry(outcome.reason)};
    return {ok:true,data:outcome.project};
  } catch (error) { return fail(error); }
}

/** Re-fetch the project and bind the selected teammate to this signed-in account. */
export async function importBuilderTeam(input: {hackathonId:number;url:string;selectedUsername:string}): Promise<
  BuilderResult<{url:string}> | {ok:false;error:string;reason:ImportFailureReason;retry:boolean}
> {
  const user = await requireMember();
  try {
    const parsed = z.object({hackathonId:hackathonIdSchema,url:z.string().max(2048),selectedUsername:z.string().trim().min(1).max(120)}).parse(input);
    await builderStore().rateLimit(user.id,'import',15);
    const outcome = await importColosseumTeam(user, parsed);
    if (!outcome.ok) return {ok:false,error:outcome.message,reason:outcome.reason,retry:inviteRetry(outcome.reason)};
    refreshHq("builders");
    return {ok:true,data:{url:`/hq/team/${outcome.projectId}`}};
  } catch (error) { return fail(error); }
}


export async function requestBuilderReview(input:{hackathonId:number;url:string;telegramUsername?:string}): Promise<BuilderResult<{url:string}> | {ok:false;error:string;field:'telegramUsername'}> {
  const user = await requireMember();
  try {
    const parsed = z.object({hackathonId:hackathonIdSchema,url:z.string().max(2048),telegramUsername:z.string().optional()}).parse(input);
    const slug = parseColosseumProjectUrl(parsed.url);
    // The connection can change after the form opens. A typed contact is
    // only for this request and never becomes a verified login identity.
    const telegram = await getTelegramIdentity(user.id);
    const username = parsed.telegramUsername?.trim().replace(/^@/, '') ?? '';
    if (!telegram && !/^[A-Za-z0-9_]{1,32}$/.test(username)) {
      return {ok:false,error:'Enter your Telegram username, such as @yourname.',field:'telegramUsername'};
    }
    const note = telegram
      ? `Import help requested. Telegram connected${telegram.username ? ` as @${telegram.username}` : ' to this HQ account'}.`
      : `Import help requested. Telegram contact (provided): @${username}.`;
    const store = builderStore();
    await store.rateLimit(user.id,'review',5);
    await store.requestReview(user,parsed.hackathonId,colosseumProjectUrl(slug),note);
    refreshHq("builders");
    return {ok:true,data:{url:'/hq/dashboard'}};
  } catch (error) { return fail(error); }
}

/** A reusable team link, available to verified teammates. */
export async function createBuilderInvite(input:{projectId:string;hackathonId:number}): Promise<BuilderResult<{code:string}>> {
  const actor = await requireMemberActor();
  try {
    const {projectId,hackathonId} = z.object({projectId:uuid,hackathonId:hackathonIdSchema}).parse(input);
    const store = builderStore();
    await store.rateLimit(actor.id,'invite',20);
    const team = await authorizedTeam(actor,{projectId,hackathonId,action:'read'});
    // Captains can read assigned teams, but only teammates can share access.
    if (!team || !(await isTeamMember(actor,projectId))) throw new BuilderError(TEAM_NOT_AVAILABLE);
    return {ok:true,data:{code:await store.createInvite(actor.id,projectId)}};
  } catch (error) { return fail(error); }
}

/** Read the available Colosseum teammates behind a valid team link. */
export async function previewBuilderInvite(pasted:string): Promise<
  BuilderResult<{team:string;projectUrl:string;code:string;joinedUrl?:string;members:{id:string;name:string;username:string;avatarUrl:string|null}[]}> |
  {ok:false;error:string;reason:JoinLinkRefusal|ImportFailureReason}
> {
  const user = await requireMember();
  try {
    const code = parseJoinCode(joinInputSchema.parse(pasted));
    if (!code) return {ok:false,error:JOIN_LINK_MESSAGES.invalid,reason:'invalid'};
    const store = builderStore();
    await store.rateLimit(user.id,'join',20);
    const saved = await store.invitation(code);
    if (!saved.ok) return {ok:false,error:JOIN_LINK_MESSAGES[saved.reason],reason:saved.reason};
    if (await store.joinedSeat(saved.data.projectId,user.id)) {
      return {ok:true,data:{team:saved.data.projectName,projectUrl:saved.data.projectUrl,code,members:[],joinedUrl:`/hq/team/${saved.data.projectId}`}};
    }
    const invite = await previewTeamInvitation(code);
    if (!invite.ok) return {ok:false,error:invite.message,reason:invite.reason};
    return {ok:true,data:{team:invite.data.projectName,projectUrl:invite.data.projectUrl,code,members:invite.data.members}};
  } catch (error) { return fail(error); }
}

export async function acceptBuilderInvite(input:{code:string;memberId:string}): Promise<BuilderResult<{url:string}>> {
  const user = await requireMember();
  try {
    const {code:pasted,memberId} = z.object({code:joinInputSchema,memberId:uuid}).parse(input);
    const code = parseJoinCode(pasted);
    if (!code) throw new BuilderError(JOIN_LINK_MESSAGES.invalid);
    const store = builderStore();
    await store.rateLimit(user.id,'redeem',12);
    // Re-read the source on submission; a preview does not reserve a teammate.
    const invite = await previewTeamInvitation(code);
    if (!invite.ok) throw new BuilderError(invite.message);
    const id = await store.redeemInvite(user,code,memberId);
    refreshHq("builders");
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
    refreshHq("builders");
    return {ok:true,data:{saved:true}};
  } catch (error) { return fail(error); }
}
