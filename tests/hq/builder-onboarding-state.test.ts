import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks=vi.hoisted(()=>({
  state:[] as unknown[],position:0,work:[] as Promise<unknown>[],
  preview:vi.fn(),importTeam:vi.fn(),invite:vi.fn(),join:vi.fn(),review:vi.fn(),replace:vi.fn(),onUrl:vi.fn(),
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
  previewBuilderImport:mocks.preview,importBuilderTeam:mocks.importTeam,previewBuilderInvite:mocks.invite,acceptBuilderInvite:mocks.join,requestBuilderReview:mocks.review,
}));
vi.mock('symbols-react',()=>({IconArrowRight:()=>null}));
import { BuilderImportHelp } from '@/components/hq/builder-import-help';
import { BuilderInitialize, BuilderJoin } from '@/components/hq/builder-onboarding';

const HACKATHON=41;
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
function findAll(tree:ReactNode,type:string){return elements(tree).filter(item=>item.type===type);}
function fire(tree:ReactNode,type:string,event:string,arg:unknown){(find(tree,type).props[event] as (value:unknown)=>void)(arg);}
function alertText(tree:ReactNode){return elements(tree).find(item=>item.props.role==='alert')?.props.children;}
/** Renders a nested component in the same pass, so its state slots follow its parent's and stay stable across renders. */
function expand(tree:ReactNode,name:string):ReactNode{
  const nested=elements(tree).find(item=>typeof item.type==='function'&&item.type.name===name);
  if(!nested)return tree;
  const component=nested.type as unknown as (props:Record<string,unknown>)=>ReactNode;
  return [tree,component(nested.props)];
}
async function settle(){await Promise.all(mocks.work.splice(0));}

beforeEach(()=>{vi.resetAllMocks();mocks.state=[];mocks.work=[];});

describe('onboarding selection',()=>{
  it('previews first and never imports without the selected identity',async()=>{
    const component=()=>BuilderInitialize({hackathonId:HACKATHON});
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
    expect(mocks.replace).toHaveBeenCalledWith('/hq/dashboard');
  });

  it('opens the menu after joining a team',async()=>{
    const component=()=>BuilderJoin({});
    mocks.invite.mockResolvedValue({ok:true,data:{team:'Example',projectUrl:URL,code:CODE,members:[member]}});
    mocks.join.mockResolvedValue({ok:true,data:{url:'/hq/team/example'}});
    let tree=render(component);
    fire(tree,'input','onChange',{target:{value:CODE}});
    tree=render(component);fire(tree,'form','onSubmit',submit);await settle();
    expect(mocks.replace).not.toHaveBeenCalled();
    tree=render(component);fire(tree,'select','onChange',{target:{value:member.id}});
    tree=render(component);fire(tree,'form','onSubmit',submit);await settle();
    expect(mocks.join).toHaveBeenCalledWith({code:CODE,memberId:member.id});
    expect(mocks.replace).toHaveBeenCalledWith('/hq/dashboard');
  });

  it('refuses a link that is not a Colosseum project link before asking the server',async()=>{
    const component=()=>BuilderInitialize({hackathonId:HACKATHON});
    const link='https://example.com/arena/projects/example';
    let tree=render(component);
    fire(tree,'input','onChange',{target:{value:link}});
    tree=render(component);
    fire(tree,'form','onSubmit',submit);
    await settle();
    tree=render(component);
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(alertText(tree)).toBe('That doesn’t look like a Colosseum project link.');
    expect(find(tree,'input').props.value).toBe(link);
  });

  it('shows an already-imported refusal as the plain error block, with help only through the modal',async()=>{
    const component=()=>BuilderInitialize({hackathonId:HACKATHON});
    mocks.preview.mockResolvedValue({ok:false,error:'This team is already in HQ.',reason:'already_imported',retry:false});
    let tree=render(component);
    fire(tree,'input','onChange',{target:{value:URL}});
    tree=render(component);
    fire(tree,'form','onSubmit',submit);
    await settle();
    tree=render(component);
    expect(alertText(tree)).toBe('This team is already in HQ.');
    // The link step has no link at all: no Telegram group, no other route than the help modal beneath.
    expect(findAll(tree,'a')).toEqual([]);
    expect(elements(tree).some(item=>item.type==='select')).toBe(false);
    expect(find(tree,'BuilderImportHelp').props).toMatchObject({hackathonId:41,url:URL});
  });

  it('uses the shared link with the selected member and refreshes after a taken seat',async()=>{
    const component=()=>BuilderJoin({});
    const intro=(tree:ReactNode)=>findAll(tree,'p').some(item=>item.props.children==='Paste your team’s join link.');
    mocks.invite.mockResolvedValue({ok:true,data:{team:'Example',projectUrl:URL,code:CODE,members:[member]}});
    mocks.join.mockResolvedValue({ok:false,error:'This teammate has already joined.'});
    let tree=render(component);
    expect(intro(tree)).toBe(true);
    fire(tree,'input','onChange',{target:{value:CODE}});
    tree=render(component);fire(tree,'form','onSubmit',submit);await settle();
    tree=render(component);
    expect(intro(tree)).toBe(false);
    expect(find(tree,'select').props.value).toBe('');
    fire(tree,'select','onChange',{target:{value:member.id}});
    tree=render(component);
    mocks.invite.mockResolvedValue({ok:true,data:{team:'Example',projectUrl:URL,code:CODE,members:[]}});
    fire(tree,'form','onSubmit',submit);await settle();
    tree=render(component);
    expect(mocks.join).toHaveBeenCalledWith({code:CODE,memberId:member.id});
    // An empty roster still shows the selection and the way onto the roster; nothing tells the joiner the team is full.
    expect(find(tree,'RosterHelp').props).toMatchObject({projectUrl:URL});
    const select=find(tree,'select');
    expect(select.props.value).toBe('');
    expect(elements(select).filter(item=>item.type==='option')).toHaveLength(1);
    expect(find(tree,'ErrorText').props.error).toBe('This teammate has already joined.');
    expect(mocks.replace).not.toHaveBeenCalled();
  });
});

describe('onboarding connection errors',()=>{
  it.each(['import','join'] as const)('keeps the %s link when its preview cannot connect',async flow=>{
    const component=flow==='import'?()=>BuilderInitialize({hackathonId:HACKATHON}):()=>BuilderJoin({});
    const preview=flow==='import'?mocks.preview:mocks.invite;
    const link=flow==='import'?URL:CODE;
    preview.mockRejectedValue(new Error('Network error'));
    let tree=render(component);
    fire(tree,'input','onChange',{target:{value:link}});
    tree=render(component);fire(tree,'form','onSubmit',submit);await settle();
    tree=render(component);
    expect(find(tree,'input').props.value).toBe(link);
    const errors=flow==='import'?alertText(tree):find(tree,'ErrorText').props.error;
    expect(errors).toContain('Try again.');
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it.each(['import','join'] as const)('retains the selected teammate when %s cannot connect',async flow=>{
    const component=flow==='import'?()=>BuilderInitialize({hackathonId:HACKATHON}):()=>BuilderJoin({});
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
    const errors=flow==='import'?alertText(tree):find(tree,'ErrorText').props.error;
    expect(errors).toContain('Try again.');
    expect(mocks.replace).not.toHaveBeenCalled();
  });
});

describe('the help modal',()=>{
  const component=()=>expand(BuilderImportHelp({hackathonId:HACKATHON,url:URL,onUrl:mocks.onUrl}),'ImportHelpDialog');
  const submitButton=(tree:ReactNode)=>findAll(tree,'button').find(item=>item.props.type==='submit');
  const label=(tree:ReactNode)=>(submitButton(tree)?.props.children as unknown[])[0];

  it('shares the page link, sends the request and confirms in place without leaving',async()=>{
    mocks.review.mockResolvedValue({ok:true,data:{url:'/hq/dashboard'}});
    let tree=render(component);
    expect(elements(tree).some(item=>item.type==='dialog')).toBe(false);
    expect(find(tree,'button').props.disabled).toBeUndefined();
    fire(tree,'button','onClick',undefined);
    tree=render(component);
    find(tree,'dialog');
    const [link,handle]=findAll(tree,'input');
    expect(link.props.value).toBe(URL);
    (link.props.onChange as (event:unknown)=>void)({target:{value:'https://colosseum.com/arena/projects/other'}});
    expect(mocks.onUrl).toHaveBeenCalledWith('https://colosseum.com/arena/projects/other');
    (handle.props.onChange as (event:unknown)=>void)({target:{value:'@me'}});
    tree=render(component);
    expect(label(tree)).toBe('Send request');
    fire(tree,'form','onSubmit',submit);await settle();
    tree=render(component);
    expect(mocks.review).toHaveBeenCalledWith({hackathonId:41,url:URL,telegramUsername:'@me'});
    find(tree,'dialog');
    expect(label(tree)).toBe('Sent');
    expect(elements(tree).find(item=>item.props.role==='status')?.props.children).toBe('Sent. We’ll be in touch on Telegram.');
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it('shows a refusal inline and marks the Telegram field when that is what was wrong',async()=>{
    mocks.review.mockResolvedValue({ok:false,error:'Enter your Telegram username, such as @yourname.',field:'telegramUsername'});
    let tree=render(component);
    fire(tree,'button','onClick',undefined);
    tree=render(component);
    fire(tree,'form','onSubmit',submit);await settle();
    tree=render(component);
    expect(alertText(tree)).toBe('Enter your Telegram username, such as @yourname.');
    expect(findAll(tree,'input')[1].props['aria-invalid']).toBe(true);
    expect(label(tree)).toBe('Send request');
    expect(elements(tree).some(item=>item.props.role==='status')).toBe(false);
  });
});
