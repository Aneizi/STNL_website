import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  member: vi.fn(), actor: vi.fn(), authorized: vi.fn(), isTeamMember: vi.fn(),
  rateLimit: vi.fn(), storedInvitation:vi.fn(), joinedSeat:vi.fn(), createInvite: vi.fn(), redeemInvite: vi.fn(),
  preview: vi.fn(), importTeam: vi.fn(), invitation: vi.fn(), revalidate: vi.fn(),
}));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath:mocks.revalidate }));
vi.mock('@/lib/hq/member-auth', () => ({ requireMember:mocks.member }));
vi.mock('@/lib/hq/actor', () => ({ requireMemberActor:mocks.actor }));
vi.mock('@/lib/hq/authz', () => ({ isTeamMember:mocks.isTeamMember }));
vi.mock('@/lib/hq/identity', () => ({ getTelegramIdentity:vi.fn() }));
vi.mock('@/lib/hq/member-teams', () => ({ authorizedTeam:mocks.authorized, TEAM_NOT_AVAILABLE:'This team is not available to your account.' }));
vi.mock('@/lib/hq/builder-store', async () => ({
  BuilderError:(await import('@/lib/hq/builder-types')).BuilderError,
  builderStore:() => ({ rateLimit:mocks.rateLimit,invitation:mocks.storedInvitation,joinedSeat:mocks.joinedSeat,createInvite:mocks.createInvite,redeemInvite:mocks.redeemInvite }),
}));
vi.mock('@/lib/hq/project-import', () => ({
  previewColosseumTeam:mocks.preview,importColosseumTeam:mocks.importTeam,previewTeamInvitation:mocks.invitation,
  refreshColosseumTeam:vi.fn(),inviteRetry:(reason:string) => reason==='timed_out',
}));

import { acceptBuilderInvite, createBuilderInvite, importBuilderTeam, previewBuilderImport, previewBuilderInvite } from '@/lib/hq/actions/builders';

const USER = {id:'signed-in',name:'Builder',email:null};
const PROJECT_ID = '00000000-0000-4000-8000-000000000011';
const MEMBER_ID = '00000000-0000-4000-8000-000000000012';
const CODE = '917F94-8CE496-4D2C7A-4C70F1';
const URL = 'https://colosseum.com/arena/projects/explore/example';
const MEMBER = {id:MEMBER_ID,username:'builder',name:'Builder',avatarUrl:null};
const invitation = (members=[MEMBER]) => ({ok:true,data:{projectId:PROJECT_ID,projectName:'Example',projectUrl:URL,hackathonId:41,members}});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.member.mockResolvedValue(USER);
  mocks.actor.mockResolvedValue({...USER,kind:'member'});
  mocks.authorized.mockResolvedValue({id:PROJECT_ID});
  mocks.isTeamMember.mockResolvedValue(true);
  mocks.createInvite.mockResolvedValue(CODE);
  mocks.redeemInvite.mockResolvedValue(PROJECT_ID);
  mocks.invitation.mockResolvedValue(invitation());
  mocks.storedInvitation.mockResolvedValue(invitation());
  mocks.joinedSeat.mockResolvedValue(null);
});

describe('preview and selected import', () => {
  it('authenticates and rate limits the preview without creating a team', async () => {
    const project={name:'Example',projectUrl:URL,members:[{username:'builder',name:'Builder',avatarUrl:null}]};
    mocks.preview.mockResolvedValue({ok:true,project});
    expect(await previewBuilderImport({hackathonId:41,url:URL})).toEqual({ok:true,data:project});
    expect(mocks.member).toHaveBeenCalledOnce();
    expect(mocks.rateLimit).toHaveBeenCalledWith(USER.id,'import',15);
    expect(mocks.preview).toHaveBeenCalledWith({hackathonId:41,url:URL});
    expect(mocks.importTeam).not.toHaveBeenCalled();
  });

  it('requires an explicit teammate and uses only the signed-in identity', async () => {
    const input={hackathonId:41,url:URL,selectedUsername:''};
    expect(await importBuilderTeam(input)).toMatchObject({ok:false});
    expect(mocks.importTeam).not.toHaveBeenCalled();
    mocks.importTeam.mockResolvedValue({ok:true,projectId:PROJECT_ID});
    expect(await importBuilderTeam({...input,selectedUsername:' builder '})).toEqual({ok:true,data:{url:`/hq/team/${PROJECT_ID}`}});
    expect(mocks.importTeam).toHaveBeenCalledWith(USER,{hackathonId:41,url:URL,selectedUsername:'builder'});
  });

  it('preserves actionable source failures in both steps', async () => {
    const failure={ok:false,reason:'timed_out',message:'Colosseum timed out. Try again.'};
    mocks.preview.mockResolvedValue(failure);
    mocks.importTeam.mockResolvedValue(failure);
    const expected={ok:false,reason:'timed_out',error:failure.message,retry:true};
    expect(await previewBuilderImport({hackathonId:41,url:URL})).toEqual(expected);
    expect(await importBuilderTeam({hackathonId:41,url:URL,selectedUsername:'builder'})).toEqual(expected);
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
});

describe('reusable team join links', () => {
  it('lets a verified teammate share a generic link and excludes a captain-only reader', async () => {
    expect(await createBuilderInvite({projectId:PROJECT_ID,hackathonId:41})).toEqual({ok:true,data:{code:CODE}});
    expect(mocks.createInvite).toHaveBeenCalledWith(USER.id,PROJECT_ID);
    mocks.isTeamMember.mockResolvedValue(false);
    expect(await createBuilderInvite({projectId:PROJECT_ID,hackathonId:41})).toEqual({ok:false,error:'This team is not available to your account.'});
    expect(mocks.createInvite).toHaveBeenCalledTimes(1);
  });

  it('exposes a full roster as an empty choice list with its Colosseum link', async () => {
    mocks.invitation.mockResolvedValue(invitation([]));
    expect(await previewBuilderInvite(`https://hq.example.test/hq/join/${CODE}`)).toEqual({
      ok:true,data:{team:'Example',projectUrl:URL,code:CODE,members:[]},
    });
  });

  it('opens the team for an already-joined account without offering another identity', async () => {
    mocks.joinedSeat.mockResolvedValue(MEMBER_ID);
    expect(await previewBuilderInvite(CODE)).toMatchObject({ok:true,data:{joinedUrl:`/hq/team/${PROJECT_ID}`}});
    expect(mocks.invitation).not.toHaveBeenCalled();
  });

  it('revalidates the source before redeeming the selected seat', async () => {
    expect(await acceptBuilderInvite({code:CODE,memberId:MEMBER_ID})).toEqual({ok:true,data:{url:`/hq/team/${PROJECT_ID}`}});
    expect(mocks.invitation).toHaveBeenCalledWith(CODE);
    expect(mocks.redeemInvite).toHaveBeenCalledWith(USER,CODE,MEMBER_ID);
    expect(mocks.invitation.mock.invocationCallOrder[0]).toBeLessThan(mocks.redeemInvite.mock.invocationCallOrder[0]);
  });

  it('rejects an invalid member or changed source without redeeming', async () => {
    expect(await acceptBuilderInvite({code:CODE,memberId:'not-a-member-id'})).toMatchObject({ok:false});
    expect(mocks.invitation).not.toHaveBeenCalled();
    mocks.invitation.mockResolvedValue({ok:false,reason:'wrong_edition',message:'This project belongs to a different hackathon.'});
    expect(await acceptBuilderInvite({code:CODE,memberId:MEMBER_ID})).toEqual({ok:false,error:'This project belongs to a different hackathon.'});
    expect(mocks.redeemInvite).not.toHaveBeenCalled();
  });
});
