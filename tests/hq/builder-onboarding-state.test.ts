import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks=vi.hoisted(()=>({
  state:[] as unknown[],position:0,work:[] as Promise<unknown>[],
  preview:vi.fn(),importTeam:vi.fn(),invite:vi.fn(),join:vi.fn(),replace:vi.fn(),
}));
vi.mock('react',async original=>({
  ...(await original<typeof import('react')>()),
  useState:(initial:unknown)=>{
    const index=mocks.position++;
    if(!(index in mocks.state))mocks.state[index]=initial;
    return [mocks.state[index],(next:unknown)=>{mocks.state[index]=next;}];
  },
  useEffect:()=>{},
  useRef:(initial:unknown)=>({current:initial}),
  useCallback:(callback:unknown)=>callback,
  useTransition:()=>[false,(run:()=>Promise<unknown>)=>{mocks.work.push(run());}],
}));
vi.mock('next/navigation',()=>({useRouter:()=>({replace:mocks.replace})}));
vi.mock('@/lib/hq/actions/builders',()=>({
  previewBuilderImport:mocks.preview,importBuilderTeam:mocks.importTeam,previewBuilderInvite:mocks.invite,acceptBuilderInvite:mocks.join,
  chooseBuilderPath:vi.fn(),requestBuilderEvent:vi.fn(),requestBuilderReview:vi.fn(),
}));
vi.mock('symbols-react',()=>({IconArrowRight:()=>null,IconTelegramLogo:()=>null}));
import { BuilderInitialize, BuilderJoin } from '@/components/hq/builder-onboarding';

const EDITION={id:41,name:'Spring builders',startDate:'2098-04-01',endDate:'2098-05-01',externalId:6,externalSlug:'frontier',projectsOpen:true,projectsAvailableAt:null,signupUrl:'https://colosseum.com/signup',hostingEnabled:false};
const URL='https://colosseum.com/arena/projects/explore/example';
const CODE='917F94-8CE496-4D2C7A-4C70F1';
const member={id:'teammate-id',username:'teammate',name:'Teammate',avatarUrl:null};
const submit={preventDefault(){}};
type Element=ReactElement<Record<string,unknown>>;
function elements(node:ReactNode):Element[]{
  if(Array.isArray(node))return node.flatMap(elements);
  if(!isValidElement<Record<string,unknown>>(node))return [];
  return [node,...elements(node.props.children as ReactNode)];
}
function render(component:()=>ReactNode){mocks.position=0;return component();}
function find(tree:ReactNode,type:string){
  const result=elements(tree).find(item=>item.type===type||(typeof item.type==='function'&&item.type.name===type));
  if(!result)throw new Error(`Missing ${type}`);
  return result;
}
function fire(tree:ReactNode,type:string,event:string,arg:unknown){(find(tree,type).props[event] as (value:unknown)=>void)(arg);}
async function settle(){await Promise.all(mocks.work.splice(0));}

beforeEach(()=>{vi.resetAllMocks();mocks.state=[];mocks.work=[];});

describe('onboarding selection',()=>{
  it('previews first and never imports without the selected identity',async()=>{
    const component=()=>BuilderInitialize({hackathon:EDITION,available:true});
    mocks.preview.mockResolvedValue({ok:true,data:{name:'Example',projectUrl:URL,members:[member]}});
    mocks.importTeam.mockResolvedValue({ok:true,data:{url:'/hq/team/example'}});
    let tree=render(component);
    fire(tree,'input','onChange',{target:{value:URL}});
    tree=render(component);
    fire(tree,'form','onSubmit',submit);
    await settle();
    tree=render(component);
    expect(mocks.preview).toHaveBeenCalledWith({hackathonId:41,url:URL});
    expect(mocks.importTeam).not.toHaveBeenCalled();
    expect(find(tree,'select').props.value).toBe('');
    expect(find(tree,'button').props.disabled).toBe(true);
    fire(tree,'select','onChange',{target:{value:'teammate'}});
    tree=render(component);
    fire(tree,'form','onSubmit',submit);
    await settle();
    expect(mocks.importTeam).toHaveBeenCalledWith({hackathonId:41,url:URL,selectedUsername:'teammate'});
    expect(mocks.replace).toHaveBeenCalledWith('/hq/team/example');
  });

  it('uses the shared link with the selected member and refreshes after a taken seat',async()=>{
    const component=()=>BuilderJoin({});
    mocks.invite.mockResolvedValue({ok:true,data:{team:'Example',projectUrl:URL,code:CODE,members:[member]}});
    mocks.join.mockResolvedValue({ok:false,error:'This teammate has already joined.'});
    let tree=render(component);
    fire(tree,'input','onChange',{target:{value:CODE}});
    tree=render(component);fire(tree,'form','onSubmit',submit);await settle();
    tree=render(component);
    expect(find(tree,'select').props.value).toBe('');
    fire(tree,'select','onChange',{target:{value:member.id}});
    tree=render(component);
    mocks.invite.mockResolvedValue({ok:true,data:{team:'Example',projectUrl:URL,code:CODE,members:[]}});
    fire(tree,'form','onSubmit',submit);await settle();
    tree=render(component);
    expect(mocks.join).toHaveBeenCalledWith({code:CODE,memberId:member.id});
    expect(find(tree,'RosterHelp').props).toMatchObject({projectUrl:URL,emptyMessage:'All teammates have joined.'});
    expect(elements(tree).some(item=>item.type==='select')).toBe(false);
    expect(mocks.replace).not.toHaveBeenCalled();
  });
});


describe('onboarding connection errors',()=>{
  it.each(['import','join'] as const)('keeps the %s link when its preview cannot connect',async flow=>{
    const component=flow==='import'?()=>BuilderInitialize({hackathon:EDITION,available:true}):()=>BuilderJoin({});
    const preview=flow==='import'?mocks.preview:mocks.invite;
    const link=flow==='import'?URL:CODE;
    preview.mockRejectedValue(new Error('Network error'));
    let tree=render(component);
    fire(tree,'input','onChange',{target:{value:link}});
    tree=render(component);fire(tree,'form','onSubmit',submit);await settle();
    tree=render(component);
    expect(find(tree,'input').props.value).toBe(link);
    const errors=flow==='import'?elements(tree).find(item=>item.props.role==='alert')?.props.children:find(tree,'ErrorText').props.error;
    expect(errors).toContain('Try again.');
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it.each(['import','join'] as const)('retains the selected teammate when %s cannot connect',async flow=>{
    const component=flow==='import'?()=>BuilderInitialize({hackathon:EDITION,available:true}):()=>BuilderJoin({});
    const preview=flow==='import'?mocks.preview:mocks.invite;
    const action=flow==='import'?mocks.importTeam:mocks.join;
    const link=flow==='import'?URL:CODE;
    const selection=flow==='import'?member.username:member.id;
    preview.mockResolvedValue({ok:true,data:{name:'Example',team:'Example',projectUrl:URL,code:CODE,members:[member]}});
    action.mockRejectedValue(new Error('Network error'));
    let tree=render(component);
    fire(tree,'input','onChange',{target:{value:link}});
    tree=render(component);fire(tree,'form','onSubmit',submit);await settle();
    tree=render(component);fire(tree,'select','onChange',{target:{value:selection}});
    tree=render(component);fire(tree,'form','onSubmit',submit);await settle();
    tree=render(component);
    expect(find(tree,'select').props.value).toBe(selection);
    const errors=flow==='import'?elements(tree).find(item=>item.props.role==='alert')?.props.children:find(tree,'ErrorText').props.error;
    expect(errors).toContain('Try again.');
    expect(mocks.replace).not.toHaveBeenCalled();
  });
});
