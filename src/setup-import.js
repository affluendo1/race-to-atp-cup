import {DEFAULT_RULES,merge} from './config.js';
import {audit} from './validation.js';

export const SETUP_HEADERS={
 'Competition':['Application name','Competition name','Finals name','Introduction'],
 'Teams':['Team reference (leave as-is; blank for new)','Team name','Short name','Abbreviation','Home city','Country','Region','Home venue','Home surface','Founded year','Arena capacity','Team colours (separate with ;)','Team description','Rival teams (names separated with ;)','Active?','Logo image','Other names (separate with ;)'],
 'Players':['Player reference (leave as-is; blank for new)','Full name','Name shown on site','Nationality','Date of birth','Playing hand','Active?','Photo image','Other names (separate with ;)'],
 'Seasons':['Season reference (leave as-is; blank for new)','Season name','Year','Season starts','Season ends','Finals cycle name','Finals cycle starts','Finals cycle ends','Host A city','Host A country','Host A venue','Host A surface','Host B city','Host B country','Host B venue','Host B surface','Quarterfinal dates (separate with ;)','Semifinal date','Final date','Final seed teams (names separated with ;)'],
 'Season Teams':['Season','Team'],
 'Team Venues':['Season','Team','Alternate home venue','Alternate home surface'],
 'Rosters':['Season','Team','Player name','Roster order','Player role','Active?','Registered from','Registered through'],
 'Fixtures':['Match reference (leave as-is; blank for new)','Season','Round','Match date','Stage','Home team','Away team','Venue','Playing surface','Status','Finals host city','Finals match slot'],
 'Rules':['Season (leave blank for competition-wide setting)','Setting','Value']
};

const ruleSpecs=[
 ['Teams in each season','teamCount','number'],['Players on a full team roster','rosterSize','number'],['Players selected for one match','squadSize','number'],
 ['Singles matches per fixture','singlesRubbers','number'],['Doubles matches per fixture','doublesRubbers','number'],
 ['Singles places in a full roster','rosterSlots.S','number'],['All-round places in a full roster','rosterSlots.C','number'],['Doubles specialist places in a full roster','rosterSlots.D','number'],
 ['Regular-season rounds','regularSeasonRounds','number'],['Teams qualifying for the Finals','finalsTeams','number'],
 ['Race points for a win','points.win','number'],['Race points for a draw','points.draw','number'],['Race points for a loss','points.loss','number'],
 ['Standings tie-break order','standingsTiebreaks','list'],['Each singles player can play once per fixture?','singlesUnique','boolean'],['Doubles pairs use the whole selected squad?','doublesUseWholeSquad','boolean'],['Allow a player to transfer during a season?','allowTransfers','boolean'],
 ['Playing surfaces shown on the site','surfaces','surface-names'],['Finals allowed surfaces','finals.surfaces','surface-list'],['Resolve an exact Finals tie by','finals.exactTie','text'],['Quarterfinal seed pairings','finals.quarterfinalSeeds','pairs'],['Final host order','finals.finalHostOrder','host-order'],
 ['Rating update sensitivity','rating.scale','number'],['Rating evidence halves after (days)','rating.halfLifeDays','number'],['Rating adjustment strength','rating.l2','number'],['Starting player rating','rating.centre','number'],['Rating display range','rating.displayScale','number'],['Matches before a rating is established','rating.minMatches','number'],['Games credited for a doubles match tiebreak','rating.matchTiebreakGames','number'],['Include retirement results in ratings?','rating.includeRetirements','boolean'],
 ['Singles role name','classifications.S','text'],['All-round role name','classifications.C','text'],['Doubles specialist role name','classifications.D','text']
];
const split=s=>String(s??'').split(';').map(x=>x.trim()).filter(Boolean);
const cell=(row,key)=>row?.[key]??'';
const text=(value)=>String(value??'').trim();
const slug=s=>String(s).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||'record';
function excelDate(value){if(typeof value==='number'&&Number.isFinite(value)){const d=new Date(Date.UTC(1899,11,30)+Math.round(value)*86400000);return d.toISOString().slice(0,10);}return text(value);}
function nullableNumber(value){if(value===''||value===null||value===undefined)return null;const n=Number(value);if(!Number.isFinite(n))throw Error(`“${value}” should be a number.`);return n;}
function boolean(value,defaultValue=true){const v=text(value).toLowerCase();if(!v)return defaultValue;if(['yes','y','true','1','active'].includes(v))return true;if(['no','n','false','0','inactive'].includes(v))return false;throw Error(`Use Yes or No for “${value}”.`);}
function setPath(target,path,value){const parts=path.split('.');let at=target;for(const p of parts.slice(0,-1))at=at[p]??={};at[parts.at(-1)]=value;}
function labelValue(value,mapping,label){const v=text(value);if(!v)return null;const found=Object.entries(mapping).find(([id,name])=>id.toLowerCase()===v.toLowerCase()||String(name).toLowerCase()===v.toLowerCase());if(!found)throw Error(`Choose a ${label} from the guide, or leave it blank.`);return found[0];}
function rowsFor(sheets,name){return Array.isArray(sheets?.[name])?sheets[name]:[];}
function uniqueId(reference,name,existing,used,kind){let id=text(reference);if(!id){const prior=existing.find(x=>text(x.name||x.fullName).toLowerCase()===text(name).toLowerCase());id=prior?.id||slug(name);}if(used.has(id))throw Error(`Two ${kind} entries use the same reference “${id}”. Give each one a different reference.`);used.add(id);return id;}
function indexByName(rows,nameOf,kind){const out=new Map();for(const row of rows){const name=text(nameOf(row)).toLowerCase();if(!name)continue;const list=out.get(name)||[];list.push(row);out.set(name,list);}return value=>{const v=text(value);if(!v)throw Error(`A ${kind} is missing.`);const exact=rows.find(x=>x.id===v);if(exact)return exact;const matches=out.get(v.toLowerCase())||[];if(matches.length===1)return matches[0];if(matches.length>1)throw Error(`“${v}” matches more than one ${kind}. Use its reference value from the ${kind==='team'?'Teams':'Players'} sheet.`);throw Error(`“${v}” was not found. Check the spelling against the ${kind==='team'?'Teams':'Players'} sheet.`);};}
function setRuleValue(out,spec,value,rules){const [label,path,type]=spec,v=text(value);if(!v)return;
 let parsed;
 if(type==='number')parsed=nullableNumber(value);
 else if(type==='boolean')parsed=boolean(value,false);
 else if(type==='list'&&path==='standingsTiebreaks'){const names={'race points':'points','points':'points','rubber difference':'rubberDiff','set difference':'setDiff','game difference':'gameDiff','match wins':'wins','sets won':'setsFor','games won':'gamesFor','rubbers won':'rubbersFor'};parsed=split(v).map(x=>names[x.toLowerCase()]||x);}
 else if(type==='list')parsed=split(v);
 else if(type==='pairs')parsed=split(v).map(pair=>{const n=pair.split(/\s*(?:-|–|,|\/|v|vs\.?|:)\s*/i).map(Number);if(n.length!==2||n.some(x=>!Number.isInteger(x)||x<1))throw Error(`Use seed pairings like “1-8; 4-5” for “${label}”.`);return n;});
 else if(type==='surface-list')parsed=split(v).map(x=>{const key=labelValue(x,rules.surfaces,'playing surface');if(!key)throw Error(`Choose a playing surface for “${label}”.`);return key;});
 else if(type==='surface-names'){const old=rules.surfaces||{},used=new Set();parsed={};for(const name of split(v)){const match=Object.entries(old).find(([,shown])=>String(shown).toLowerCase()===name.toLowerCase()),key=match?.[0]||slug(name);if(used.has(key))throw Error(`Two playing surfaces use the same name in “${label}”.`);used.add(key);parsed[key]=name;}}
 else if(type==='host-order')parsed=v.toLowerCase().includes('host a')?(v.toLowerCase().indexOf('host a')<v.toLowerCase().indexOf('host b')?['A','B']:['B','A']):split(v).map(x=>x.trim().toUpperCase());
 else if(type==='map') {parsed={};for(const part of split(v)){const [k,...rest]=part.split('=');const key=k.trim(),val=rest.join('=').trim();if(!key||!val)throw Error(`Use “name = what appears on the site” for “${label}”.`);parsed[key]=val;}}
 else if(path==='finals.exactTie')parsed=/manual/i.test(v)?'manual':v;
 else parsed=v;
 setPath(out,path,parsed);
}
function friendlyReport(report,data){const name=(type,id)=>data[type]?.find(x=>x.id===id)?.name||data[type]?.find(x=>x.id===id)?.fullName||id;return report.map(e=>{let path=e.path;if(path.startsWith('team '))path=`Team “${name('teams',path.slice(5))}”`;else if(path.startsWith('player '))path=`Player “${name('players',path.slice(7))}”`;else if(path.startsWith('season '))path=`Season “${data.seasons?.find(s=>s.id===path.slice(7))?.name||path.slice(7)}”`;else if(path.startsWith('fixture '))path=`Match “${path.slice(8)}”`;return `${path}: ${e.message}`;});}
function hasResults(f){return f.status==='completed'||(f.rubbers||[]).length>0||Object.values(f.squads||{}).some(x=>x?.length)||Boolean(f.manualWinner);}

export function prepareSetupImport(current,sheets){
 const errors=[],warnings=[];
 let teams=[],players=[],seasons=[],rosters=[],fixtures=[],config;
 try {
  const usedTeams=new Set();
  teams=rowsFor(sheets,'Teams').filter(r=>text(cell(r,'Team name'))).map(r=>{
   const name=text(cell(r,'Team name')),id=uniqueId(cell(r,'Team reference (leave as-is; blank for new)'),name,current.teams||[],usedTeams,'team');
   const old=current.teams?.find(x=>x.id===id)||{};
   return {...structuredClone(old),id,name,shortName:text(cell(r,'Short name'))||name,abbreviation:text(cell(r,'Abbreviation')),city:text(cell(r,'Home city')),country:text(cell(r,'Country')),continent:text(cell(r,'Region')),venue:text(cell(r,'Home venue')),homeSurface:text(cell(r,'Home surface'))||null,founded:nullableNumber(cell(r,'Founded year')),capacity:nullableNumber(cell(r,'Arena capacity')),colours:split(cell(r,'Team colours (separate with ;)')),description:text(cell(r,'Team description')),rivals:[],active:boolean(cell(r,'Active?')),logoPath:text(cell(r,'Logo image')),aliases:split(cell(r,'Other names (separate with ;)'))};
  });
  const teamFor=indexByName(teams,x=>x.name,'team');
  for(const row of teams){const source=rowsFor(sheets,'Teams').find(r=>(text(cell(r,'Team reference (leave as-is; blank for new)'))||'')===row.id||text(cell(r,'Team name')).toLowerCase()===row.name.toLowerCase());row.rivals=split(cell(source,'Rival teams (names separated with ;)')).map(v=>teamFor(v).id);}

  const usedPlayers=new Set();
  players=rowsFor(sheets,'Players').filter(r=>text(cell(r,'Full name'))).map(r=>{
   const fullName=text(cell(r,'Full name')),id=uniqueId(cell(r,'Player reference (leave as-is; blank for new)'),fullName,current.players||[],usedPlayers,'player'),old=current.players?.find(x=>x.id===id)||{};
   return {...structuredClone(old),id,fullName,displayName:text(cell(r,'Name shown on site'))||fullName,nationality:text(cell(r,'Nationality')),dob:cell(r,'Date of birth')?excelDate(cell(r,'Date of birth')):'',handedness:text(cell(r,'Playing hand')),active:boolean(cell(r,'Active?')),photoPath:text(cell(r,'Photo image')),aliases:split(cell(r,'Other names (separate with ;)'))};
  });
  const playerFor=indexByName(players,x=>x.fullName,'player');
  const seasonRows=rowsFor(sheets,'Seasons').filter(r=>text(cell(r,'Season name')));
  const usedSeasons=new Set();
  seasons=seasonRows.map(r=>{
   const name=text(cell(r,'Season name')),year=nullableNumber(cell(r,'Year')),id=uniqueId(cell(r,'Season reference (leave as-is; blank for new)')||String(year||name),name,current.seasons||[],usedSeasons,'season'),old=current.seasons?.find(x=>x.id===id)||{},startYear=nullableNumber(cell(r,'Finals cycle starts'))??year,endYear=nullableNumber(cell(r,'Finals cycle ends'))??(startYear+1);
   const host=(key)=>({city:text(cell(r,`Host ${key} city`)),country:text(cell(r,`Host ${key} country`)),venue:text(cell(r,`Host ${key} venue`)),surface:text(cell(r,`Host ${key} surface`))||null});
   const dates={...(old.finals?.dates||{})};
   const qf=split(cell(r,'Quarterfinal dates (separate with ;)')).map(excelDate);if(qf.length)dates.quarterfinal=qf;else delete dates.quarterfinal;
   for(const [column,key] of [['Semifinal date','semifinal'],['Final date','final']])if(cell(r,column))dates[key]=excelDate(cell(r,column));else delete dates[key];
   const finals={cycle:{id:text(cell(r,'Finals cycle name'))||`${startYear}-${endYear}`,startYear,endYear,hostA:host('A'),hostB:host('B')},dates};
   const seeds=split(cell(r,'Final seed teams (names separated with ;)')).map(v=>teamFor(v).id);if(seeds.length)finals.seeds=seeds;
   return {...structuredClone(old),id,name,year,startDate:excelDate(cell(r,'Season starts')),endDate:excelDate(cell(r,'Season ends')),teamIds:[],rules:{},teamOverrides:{},finals};
  });
  const seasonFor=value=>{const v=text(value);if(!v)throw Error('A season is missing.');const found=seasons.filter(s=>s.id===v||s.name.toLowerCase()===v.toLowerCase()||String(s.year)===v);if(found.length===1)return found[0];if(found.length>1)throw Error(`“${v}” matches more than one season. Use its season reference.`);throw Error(`Season “${v}” was not found in the Seasons sheet.`);};

  config={...structuredClone(current.config||{}),appName:text(cell(rowsFor(sheets,'Competition')[0],'Application name')),raceName:text(cell(rowsFor(sheets,'Competition')[0],'Competition name')),finalsName:text(cell(rowsFor(sheets,'Competition')[0],'Finals name')),description:text(cell(rowsFor(sheets,'Competition')[0],'Introduction')),rules:{}};
  if(!config.appName)config.appName='ATP Cup';if(!config.raceName)config.raceName=config.appName;if(!config.finalsName)config.finalsName='Finals';
  const rules=rowsFor(sheets,'Rules'),known=new Map(ruleSpecs.map(s=>[s[0],s]));
  for(const row of rules){const setting=text(cell(row,'Setting')),spec=known.get(setting),value=cell(row,'Value');if(!setting||!text(value))continue;if(!spec){errors.push(`Rules: “${setting}” isn’t a setting in this workbook. Use a name from the Rules guide.`);continue;}
   try{const seasonName=text(cell(row,'Season (leave blank for competition-wide setting)'));const target=seasonName?seasonFor(seasonName).rules:config.rules;const effective=merge(merge(DEFAULT_RULES,config.rules),target);if(spec[1].startsWith('classifications.')){const role=spec[1].split('.')[1];target.classifications={...(target.classifications||{}),[role]:text(value)};}else setRuleValue(target,spec,value,effective);}catch(e){errors.push(`Rules: ${e.message}`);}
  }

  for(const row of rowsFor(sheets,'Season Teams')){if(!text(cell(row,'Team')))continue;const s=seasonFor(cell(row,'Season')),t=teamFor(cell(row,'Team'));if(!s.teamIds.includes(t.id))s.teamIds.push(t.id);}
  for(const row of rowsFor(sheets,'Team Venues')){if(!text(cell(row,'Team')))continue;const s=seasonFor(cell(row,'Season')),t=teamFor(cell(row,'Team')),override={};const venue=text(cell(row,'Alternate home venue')),surface=text(cell(row,'Alternate home surface'));if(venue)override.venue=venue;if(surface)override.homeSurface=surface;if(Object.keys(override).length)s.teamOverrides[t.id]=override;}
  rosters=rowsFor(sheets,'Rosters').filter(r=>text(cell(r,'Team'))||text(cell(r,'Player name'))).map(r=>{
   const s=seasonFor(cell(r,'Season')),t=teamFor(cell(r,'Team')),p=playerFor(cell(r,'Player name')),role=text(cell(r,'Player role')),classMap=merge(merge(DEFAULT_RULES.classifications,config.rules.classifications||{}),s.rules.classifications||{}),classification=Object.entries(classMap).find(([k,v])=>String(v).toLowerCase()===role.toLowerCase()||k.toLowerCase()===role.toLowerCase())?.[0];if(!classification)throw Error(`Choose a player role from the guide for ${p.fullName}.`);
   return {seasonId:s.id,teamId:t.id,playerId:p.id,rosterPosition:nullableNumber(cell(r,'Roster order')),classification,active:boolean(cell(r,'Active?')),startDate:cell(r,'Registered from')?excelDate(cell(r,'Registered from')):null,endDate:cell(r,'Registered through')?excelDate(cell(r,'Registered through')):null};
  });
  const surfaceMap=merge(DEFAULT_RULES.surfaces,config.rules.surfaces||{}),statusMap={'scheduled':'scheduled','postponed':'postponed','cancelled':'cancelled','canceled':'cancelled','in progress':'in-progress','in-progress':'in-progress','completed':'completed'};
  const stageMap={'regular season':'regular','regular':'regular','quarterfinal':'quarterfinal','quarter-final':'quarterfinal','semifinal':'semifinal','semi-final':'semifinal','final':'final'};
  fixtures=rowsFor(sheets,'Fixtures').filter(r=>text(cell(r,'Season'))||text(cell(r,'Home team'))||text(cell(r,'Away team'))).map(r=>{
   const s=seasonFor(cell(r,'Season')),home=teamFor(cell(r,'Home team')),away=teamFor(cell(r,'Away team')),stageValue=text(cell(r,'Stage')).toLowerCase(),stage=stageMap[stageValue];if(!stage)throw Error(`Choose a match stage from the guide for ${home.name} v ${away.name}.`);
   const round=nullableNumber(cell(r,'Round'))||1,bracketSlot=nullableNumber(cell(r,'Finals match slot'))||undefined,date=excelDate(cell(r,'Match date'));
   const id=text(cell(r,'Match reference (leave as-is; blank for new)'))||slug(`${s.id}-${stage}-${round}-${home.id}-${away.id}${bracketSlot?`-${bracketSlot}`:''}`);
   const statusValue=text(cell(r,'Status')).toLowerCase(),status=statusValue?statusMap[statusValue]:'scheduled',existing=current.fixtures?.find(f=>f.id===id);if(!status)throw Error(`Choose Scheduled, Postponed, or Cancelled for ${home.name} v ${away.name}.`);if(!['scheduled','postponed','cancelled'].includes(status)&&!hasResults(existing||{}))throw Error(`The workbook can’t add match results. Set ${home.name} v ${away.name} to Scheduled, Postponed, or Cancelled.`);
   const surface=labelValue(cell(r,'Playing surface'),merge(surfaceMap,s.rules.surfaces||{}),'playing surface');
   return {id,seasonId:s.id,round,date,stage,homeTeamId:home.id,awayTeamId:away.id,venue:text(cell(r,'Venue')),surface,status,hostCity:text(cell(r,'Finals host city')),bracketSlot,squads:{home:[],away:[]},rubbers:[]};
  });
 } catch(e){errors.push(e.message||'One or more workbook rows need attention.');}

 const currentFixtures=current.fixtures||[],played=currentFixtures.filter(hasResults),fixtureById=new Map(fixtures.map(f=>[f.id,f]));
 for(const old of played){const incoming=fixtureById.get(old.id);if(!incoming){errors.push(`Played match “${old.id}” is missing from the Fixtures sheet. Keep its match reference and row so its result stays linked.`);continue;}
  const locked=['seasonId','stage','round','date','homeTeamId','awayTeamId','bracketSlot'];const changed=locked.find(k=>(old[k]??null)!==(incoming[k]??null));if(changed){errors.push(`Played match “${old.id}” has a changed season, date, stage, teams, or Finals slot. Put those details back as they appear in the current workbook so its result stays with the same match.`);continue;}
  Object.assign(incoming,structuredClone(old));
  for(const key of ['venue','surface','hostCity']){const source=rowsFor(sheets,'Fixtures').find(r=>text(cell(r,'Match reference (leave as-is; blank for new)'))===old.id);if(source){const seasonRules=merge(merge(DEFAULT_RULES,config.rules),seasons.find(s=>s.id===old.seasonId)?.rules||{});incoming[key]=key==='surface'?labelValue(cell(source,'Playing surface'),seasonRules.surfaces,'playing surface')||old.surface:text(cell(source,key==='hostCity'?'Finals host city':key==='venue'?'Venue':key));}}
 }
  for(const team of teams)if(team.homeSurface)team.homeSurface=labelValue(team.homeSurface,merge(DEFAULT_RULES.surfaces,config.rules.surfaces||{}),'playing surface');
  for(const season of seasons){const seasonalSurfaces=merge(merge(DEFAULT_RULES.surfaces,config.rules.surfaces||{}),season.rules.surfaces||{});for(const key of ['hostA','hostB'])if(season.finals?.cycle?.[key]?.surface)season.finals.cycle[key].surface=labelValue(season.finals.cycle[key].surface,seasonalSurfaces,'playing surface');for(const override of Object.values(season.teamOverrides||{}))if(override.homeSurface)override.homeSurface=labelValue(override.homeSurface,seasonalSurfaces,'playing surface');}
  const result={schemaVersion:1,config,teams,players,seasons,rosters,fixtures};
 if(errors.length)return {data:null,errors:[...new Set(errors)],warnings,counts:null,preservedMatches:played.length};
 const checked=audit(result);const allErrors=friendlyReport(checked.errors,result);warnings.push(...friendlyReport(checked.warnings,result));
 return {data:allErrors.length?null:result,errors:allErrors,warnings:[...new Set(warnings)],counts:{teams:teams.length,players:players.length,seasons:seasons.length,rosters:rosters.length,fixtures:fixtures.length},preservedMatches:played.length};
}

export const SETUP_RULE_LABELS=ruleSpecs.map(([label])=>label);
