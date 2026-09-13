"use server";

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { assertProjectHackathon, ColosseumApiError, fetchColosseumProject, verifyProjectClaim, parseColosseumProjectUrl } from '@/lib/colosseum-api';
import { requireMemberActor } from '../actor';
import { requireMember } from '../member-auth';
import { authorizedTeam, TEAM_NOT_AVAILABLE } from '../member-teams';
import { BuilderError, builderStore, syncBuilderAccount } from '../builder-store';
import { PROJECT_STAGES, type BuilderResult } from '../builder-types';

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
const inviteSchema = z.string().trim().min(20).max(40).regex(/^[a-fA-F0-9\s-]+$/);
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

export async function previewBuilderProject(input: {hackathonId:number;url:string}) {
  const user = await requireMember();
  try {
    const {hackathonId,url} = z.object({hackathonId:hackathonIdSchema,url:z.string().max(400)}).parse(input);
    const store = builderStore();
    await store.rateLimit(user.id,'preview');
    const edition = await store.hackathon(hackathonId);
    if (!edition.projectsOpen || (edition.projectsAvailableAt && Date.parse(edition.projectsAvailableAt)>Date.now())) throw new BuilderError('Project imports are not open yet. Your HQ account is ready; come back when Colosseum opens project access.');
    if (!edition.externalId || !edition.externalSlug) throw new BuilderError('Superteam NL is confirming this hackathon’s Colosseum registry. You can request help below.');
    const project = await fetchColosseumProject(url);
    assertProjectHackathon(project,{externalId:edition.externalId,slug:edition.externalSlug});
    return {ok:true as const,data:{name:project.name,url:`https://colosseum.com/arena/projects/explore/${project.slug}`,country:project.country,
      members:project.members.map(m=>({username:m.username,name:m.displayName}))}};
  } catch (error) { return fail(error); }
}

export async function beginBuilderVerification(input: {hackathonId:number;url:string;username:string}) {
  const user = await requireMember();
  try {
    const parsed = z.object({hackathonId:hackathonIdSchema,url:z.string().max(400),username:z.string().min(1).max(120)}).parse(input);
    const store = builderStore();
    await store.rateLimit(user.id,'challenge',8);
    await syncBuilderAccount(user);
    const edition = await store.hackathon(parsed.hackathonId);
    if (!edition.projectsOpen || (edition.projectsAvailableAt && Date.parse(edition.projectsAvailableAt)>Date.now()) || !edition.externalId || !edition.externalSlug) throw new BuilderError('Project imports are not open yet. You can request help below.');
    const project = await fetchColosseumProject(parsed.url);
    assertProjectHackathon(project,{externalId:edition.externalId,slug:edition.externalSlug});
    return {ok:true as const,data:await store.issueChallenge(user,edition.id,project,parsed.username)};
  } catch (error) { return fail(error); }
}

export async function completeBuilderImport(input:{challengeId:string;leadUsername:string;stage:string;manual:boolean}): Promise<BuilderResult<{url:string}>> {
  const user = await requireMember();
  try {
    const parsed = z.object({challengeId:uuid,leadUsername:z.string().min(1).max(120),stage:stageSchema,manual:z.boolean()}).parse(input);
    const store = builderStore();
    await store.rateLimit(user.id,'verify',15);
    const challenge = await store.challenge(user.id,parsed.challengeId);
    const edition = await store.hackathon(challenge.hackathonId);
    if (!edition.externalId || !edition.externalSlug) throw new BuilderError('The Colosseum registry is not configured yet.');
    let project = await fetchColosseumProject(challenge.projectUrl);
    assertProjectHackathon(project,{externalId:edition.externalId,slug:edition.externalSlug});
    let proof = null;
    if (!parsed.manual) {
      const verified = await verifyProjectClaim(project,{code:challenge.code,issuedAt:challenge.issuedAt,claimedUsername:challenge.username});
      project = verified.project;
      proof = verified.proof;
      if (project.country?.trim().toLowerCase()!=='netherlands') throw new BuilderError('Set your project country to Netherlands on Colosseum, then try again.');
      if (!proof) throw new BuilderError('We could not find the code from your selected Colosseum profile yet. Try again, or ask for a manual review.');
    }
    const id = await store.importTeam(user,challenge.id,project,parsed.leadUsername,parsed.stage,proof);
    refresh();
    return {ok:true,data:{url:`/hq/team/${id}`}};
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

export async function createBuilderInvite(input:{projectId:string;hackathonId:number;memberId:string}): Promise<BuilderResult<{code:string}>> {
  const actor = await requireMemberActor();
  try {
    const {projectId,hackathonId,memberId} = z.object({projectId:uuid,hackathonId:hackathonIdSchema,memberId:uuid}).parse(input);
    const store = builderStore();
    await store.rateLimit(actor.id,'invite',20);
    // Inviting is a membership change: the verified team lead's alone.
    const team = await authorizedTeam(actor,{projectId,hackathonId,action:'membership.change'});
    if (!team) throw new BuilderError(TEAM_NOT_AVAILABLE);
    const member = team.members.find(m=>m.id===memberId);
    const project = await fetchColosseumProject(team.projectUrl);
    const edition = await store.hackathon(team.hackathonId);
    assertProjectHackathon(project,{externalId:edition.externalId??0,slug:edition.externalSlug??''});
    if (!member || !project.members.some(m=>m.username===member.username)) throw new BuilderError('This teammate is no longer listed on Colosseum.');
    return {ok:true,data:{code:await store.createInvite(actor.id,projectId,memberId)}};
  } catch (error) { return fail(error); }
}

export async function previewBuilderInvite(code:string) {
  const user = await requireMember();
  try {
    const value = inviteSchema.parse(code);
    const store = builderStore();
    await store.rateLimit(user.id,'join',20);
    const invite = await store.invitation(value);
    return {ok:true as const,data:{name:invite.name,username:invite.username,team:invite.projectName}};
  } catch (error) { return fail(error); }
}

export async function acceptBuilderInvite(input:{code:string;confirmed:boolean}): Promise<BuilderResult<{url:string}>> {
  const user = await requireMember();
  try {
    const {code} = z.object({code:inviteSchema,confirmed:z.literal(true)}).parse(input);
    const store = builderStore();
    await store.rateLimit(user.id,'redeem',12);
    await syncBuilderAccount(user);
    const invite = await store.invitation(code);
    const project = await fetchColosseumProject(invite.projectUrl);
    const edition = await store.hackathon(invite.hackathonId);
    assertProjectHackathon(project,{externalId:edition.externalId??0,slug:edition.externalSlug??''});
    if (!project.members.some(m=>m.username===invite.username)) throw new BuilderError('This profile is no longer listed on the Colosseum team. Ask the team owner for help.');
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
