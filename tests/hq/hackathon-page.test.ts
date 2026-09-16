import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks=vi.hoisted(()=>({actor:vi.fn(),teams:vi.fn(),owned:vi.fn(),dashboard:vi.fn(),hackathons:vi.fn(),weeks:vi.fn()}));
vi.mock('@/lib/hq/actor',()=>({requireMemberActor:mocks.actor}));
vi.mock('@/lib/hq/builder-store',()=>({builderStore:()=>({teams:mocks.teams,ownedProjects:mocks.owned,dashboard:mocks.dashboard,hackathons:mocks.hackathons})}));
vi.mock('@/lib/hq/reporting-surface',()=>({memberWeekSummaries:mocks.weeks}));
vi.mock('@/lib/hq/format',()=>({nowMs:()=>Date.parse('2026-09-16T12:00:00Z'),todayInTz:()=> '2026-09-16'}));
vi.mock('next/navigation',()=>({notFound:()=>{throw new Error('NOT_FOUND');}}));
vi.mock('@/components/hq/builder-shell',()=>({BuilderShell:({children,fullWidth,back}:{children:ReactNode;fullWidth:boolean;back:string})=>createElement('main',{'data-full-width':fullWidth},createElement('a',{href:back},'Back'),children)}));
vi.mock('@/components/hq/builder-menu',()=>({
  MenuGrid:({children}:{children:ReactNode})=>createElement('nav',{},children),
  MenuTile:({href,label,needsAttention}:{href:string;label:string;needsAttention:boolean})=>createElement('a',{href,'data-attention':needsAttention},label),
}));
vi.mock('@/components/hq/builder-onboarding',()=>({
  BuilderWelcome:({hackathons}:{hackathons:{id:number}[]})=>createElement('div',{'data-welcome':hackathons.map(item=>item.id).join(',')},'Import or join'),
  BuilderHostApplication:({hackathons}:{hackathons:{id:number}[]})=>createElement('form',{'data-host':hackathons.map(item=>item.id).join(',')}),
}));
import HackathonPage from '@/app/hq/(member)/hackathon/[id]/page';

const edition={id:41,name:'Spring builders',hostingEnabled:true,startDate:'2026-09-14',endDate:'2026-10-12'};
const dashboard={tier:'member',requests:[],events:[],enrollments:[{hackathon_id:41}]};
const render=async(id='41')=>renderToStaticMarkup(await HackathonPage({params:Promise.resolve({id})}));
beforeEach(()=>{
  vi.resetAllMocks();
  mocks.actor.mockResolvedValue({id:'signed-in'});
  mocks.teams.mockResolvedValue([]);
  mocks.owned.mockResolvedValue([]);
  mocks.weeks.mockResolvedValue([]);
  mocks.dashboard.mockResolvedValue(dashboard);
  mocks.hackathons.mockResolvedValue([edition,{id:42,name:'Other edition',hostingEnabled:true}]);
});

describe('the hackathon landing page',()=>{
  it('authenticates before loading personal data and preserves its destination',async()=>{
    mocks.actor.mockRejectedValue(new Error('SIGN_IN'));
    await expect(render()).rejects.toThrow('SIGN_IN');
    expect(mocks.actor).toHaveBeenCalledWith('/hq/hackathon/41');
    expect(mocks.teams).not.toHaveBeenCalled();
    expect(mocks.owned).not.toHaveBeenCalled();
    expect(mocks.dashboard).not.toHaveBeenCalled();
    expect(mocks.weeks).not.toHaveBeenCalled();
  });

  it('shows only this account’s projects in the requested edition',async()=>{
    mocks.teams.mockResolvedValue([
      {id:'my-team',name:'My team',hackathonId:41,verification:'verified'},
      {id:'other-team',name:'Other team',hackathonId:42,verification:'verified'},
      {id:'pending-team',name:'Pending claim',hackathonId:41,verification:'pending'},
    ]);
    mocks.owned.mockResolvedValue([{id:'manual',name:'Manual project',hackathonId:41},{id:'elsewhere',name:'Elsewhere',hackathonId:42}]);
    const html=await render();
    expect(html).toContain('data-full-width="true"');
    expect(html).toContain('href="/hq/dashboard"');
    expect(html).toContain('href="/hq/team/my-team"');
    expect(html).toContain('href="/hq/team/manual"');
    expect(html).not.toMatch(/Other team|Elsewhere|Pending claim|data-welcome/);
    for(const query of [mocks.teams,mocks.owned,mocks.dashboard])expect(query).toHaveBeenCalledWith('signed-in');
    expect(mocks.weeks).toHaveBeenCalledWith([expect.objectContaining({id:'my-team',hackathonId:41}),expect.objectContaining({id:'manual',hackathonId:41})],undefined,Date.parse('2026-09-16T12:00:00Z'));
  });

  it('marks only the team with a current action to complete',async()=>{
    mocks.teams.mockResolvedValue([
      {id:'due',name:'Due team',hackathonId:41,verification:'verified'},
      {id:'done',name:'Complete team',hackathonId:41,verification:'verified'},
    ]);
    const current={startsAt:'2026-09-13T22:00:00Z',endsAt:'2026-09-20T22:00:00Z',completed:false};
    mocks.weeks.mockResolvedValue([
      {projectId:'due',hackathonId:41,enrolled:true,paused:false,current},
      {projectId:'done',hackathonId:41,enrolled:true,paused:false,current:{...current,completed:true}},
    ]);
    const html=await render();
    expect(html).toContain('href="/hq/team/due" data-attention="true"');
    expect(html).toContain('href="/hq/team/done" data-attention="false"');
  });

  it('offers import or join for just the selected active edition',async()=>{
    const html=await render();
    expect(html).toContain('data-welcome="41"');
    expect(html).not.toContain('Other edition');
  });

  it.each([
    ['2026-10-01','2026-11-01','This hackathon hasn’t started yet.'],
    ['2026-07-01','2026-08-01','This hackathon has ended.'],
  ])('suppresses new participation outside %s to %s',async(startDate,endDate,message)=>{
    mocks.hackathons.mockResolvedValue([{...edition,startDate,endDate,hostingEnabled:false}]);
    const html=await render();
    expect(html).not.toContain('data-welcome');
    expect(html).toContain(message);
  });

  it('keeps inactive participation details without offering import or join',async()=>{
    mocks.hackathons.mockResolvedValue([{...edition,startDate:'2026-07-01',endDate:'2026-08-01',hostingEnabled:false}]);
    mocks.dashboard.mockResolvedValue({...dashboard,requests:[{id:'old',hackathon_id:41,status:'resolved',project_url:'https://colosseum.com/past'}]});
    const html=await render();
    expect(html).toContain('Help requests');
    expect(html).not.toMatch(/data-welcome|This hackathon has ended/);
  });

  it('keeps pending and resolved help and event statuses scoped to this edition',async()=>{
    mocks.dashboard.mockResolvedValue({...dashboard,
      requests:[
        {id:'1',hackathon_id:41,status:'pending',project_url:'https://colosseum.com/current'},
        {id:'2',hackathon_id:41,status:'resolved',project_url:'https://colosseum.com/resolved'},
        {id:'3',hackathon_id:42,status:'pending',project_url:'https://colosseum.com/other'},
      ],
      events:[{id:'1',hackathon_id:41,title:'Local meetup',status:'approved'},{id:'2',hackathon_id:42,title:'Other meetup',status:'pending'}],
    });
    const html=await render();
    expect(html).toContain('Help requests');
    expect(html).toContain('https://colosseum.com/current');
    expect(html).toContain('https://colosseum.com/resolved');
    expect(html).toContain('Local meetup');
    expect(html).toContain('Approved');
    expect(html).not.toMatch(/colosseum.com\/other|Other meetup/);
    expect(html).not.toContain('<details open');
  });

  it.each([
    ['regular',true,[{hackathon_id:41}],false],
    ['member',false,[{hackathon_id:41}],false],
    ['member',true,[{hackathon_id:42}],false],
    ['member',true,[{hackathon_id:41}],true],
  ])('checks tier %s, hosting %s and enrollment before offering the host form',async(tier,hostingEnabled,enrollments,visible)=>{
    mocks.dashboard.mockResolvedValue({...dashboard,tier,enrollments});
    mocks.hackathons.mockResolvedValue([{...edition,hostingEnabled}]);
    expect((await render()).includes('data-host="41"')).toBe(visible);
  });

  it('keeps owned archived teams accessible without offering a new import',async()=>{
    mocks.hackathons.mockResolvedValue([]);
    mocks.teams.mockResolvedValue([{id:'past',name:'Past team',hackathonId:41,hackathonName:'Past edition',verification:'verified'}]);
    const html=await render();
    expect(html).toContain('<h1>Past edition</h1>');
    expect(html).toContain('href="/hq/team/past"');
    expect(html).not.toMatch(/data-welcome|data-host/);
  });

  it('keeps an archived edition’s help-request history accessible',async()=>{
    mocks.hackathons.mockResolvedValue([]);
    mocks.dashboard.mockResolvedValue({...dashboard,requests:[{id:'resolved',hackathon_id:41,name:'Past edition',status:'resolved',project_url:'https://colosseum.com/past'}]});
    const html=await render();
    expect(html).toContain('<h1>Past edition</h1>');
    expect(html).toContain('https://colosseum.com/past');
    expect(html).not.toMatch(/data-welcome|data-host/);
  });

  it('keeps an archived edition with only an owned hosting event accessible',async()=>{
    mocks.hackathons.mockResolvedValue([]);
    mocks.dashboard.mockResolvedValue({...dashboard,tier:'regular',events:[{id:'past-event',hackathon_id:41,name:'Past edition',title:'Our meetup',status:'approved'}]});
    const html=await render();
    expect(html).toContain('<h1>Past edition</h1>');
    expect(html).toContain('Our meetup');
    expect(html).toContain('Approved');
    expect(html).not.toMatch(/data-welcome|data-host/);
  });

  it('returns not found for an unavailable edition without owned projects',async()=>{
    await expect(render('99')).rejects.toThrow('NOT_FOUND');
  });

  it.each(['0','-1','abc','41.5','9007199254740992'])('rejects malformed id %s before querying',async id=>{
    await expect(render(id)).rejects.toThrow('NOT_FOUND');
    expect(mocks.teams).not.toHaveBeenCalled();
  });
});
