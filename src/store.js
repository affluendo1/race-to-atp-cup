import {assertValid} from './validation.js';
import {normalizeRubber} from './scores.js';
const KEY='atp-cup-admin-draft-v1',BACKUP=KEY+'-previous';
export function normalize(data){const d=structuredClone(data);d.fixtures=(d.fixtures||[]).map(f=>({...f,rubbers:(f.rubbers||[]).map(normalizeRubber)}));assertValid(d);return d;}
export async function load(){const published=normalize(await (await fetch('./data/events.json',{cache:'no-cache'})).json());let data=published,isDraft=false,notice='';try{const raw=localStorage.getItem(KEY);if(raw){data=normalize(JSON.parse(raw));isDraft=true;}}catch(e){notice='Local draft could not be restored: '+e.message;}return {data,published,isDraft,notice};}
export function persist(data){assertValid(data);const text=JSON.stringify(data),previous=localStorage.getItem(KEY);try{if(previous)localStorage.setItem(BACKUP,previous);localStorage.setItem(KEY,text);}catch(e){throw Error('Browser storage is full. Export a backup before closing this page. '+e.message);}}
export function clearDraft(){localStorage.removeItem(KEY);}
export function previousDraft(){const raw=localStorage.getItem(BACKUP);return raw?normalize(JSON.parse(raw)):null;}
export function download(data,name='events.json'){assertValid(data);const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)+'\n'],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
