const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const TEAM_COLOURS={
  aqua:'aqua',azure:'azure',beige:'beige',black:'black',blue:'blue',brown:'brown',
  burgundy:'burgundy',charcoal:'charcoal',coral:'coral',cream:'cream',crimson:'crimson',
  cyan:'cyan',gold:'gold',golden:'gold',gray:'gray',grey:'gray',green:'green',indigo:'indigo',
  lime:'lime',magenta:'magenta',maroon:'maroon',navy:'navy',orange:'orange',pink:'pink',
  purple:'purple',red:'red',scarlet:'scarlet',silver:'silver',tan:'tan',teal:'teal',
  turquoise:'turquoise',violet:'violet',white:'white',yellow:'yellow'
};
const TEAM_COLOUR_WORDS=new RegExp('\\b('+Object.keys(TEAM_COLOURS).join('|')+')\\b','gi');
function teamName(name){return esc(name).replace(TEAM_COLOUR_WORDS,word=>'<span class="team-colour team-colour-'+TEAM_COLOURS[word.toLowerCase()]+'">'+word+'</span>')}
function normaliseTeamLabels(value){if(Array.isArray(value)){value.forEach(normaliseTeamLabels);return value}if(!value||typeof value!=='object')return value;for(const [key,item] of Object.entries(value)){if(['team','home','away','home_team','away_team','winner'].includes(key)&&typeof item==='string')value[key]=item.replace(/\s+\d+\.\d{2}\s*$/,'');else normaliseTeamLabels(item)}return value}
let D=null,singles=[],dinds=[],pairs=[],teams=[];
let viewCatalog=DATA.catalog||[],historyCatalog=null,historyCatalogPromise=null,activeHistorySeasonId=null;
const archiveGlobalRowsCache=new Map();
let showProv=localStorage.getItem('brta-show-provisional')==='1';
let ratingScope=localStorage.getItem('brta-rating-scope')||'section';
let theme=localStorage.getItem('brta-theme')||'auto',interfaceMode=localStorage.getItem('brta-interface')||'future',accent=localStorage.getItem('brta-accent')||'yellow',profilePosition=localStorage.getItem('brta-profile-position')||'right';
let ratingView='singles',resultRound=null,selectedMatch=null,selectedPrediction=null,activePredictionMatch=null,activeProfilePlayer=null,loadingToken=0,roundSimulations={};
let activePage='results',auxiliaryCache=null,auxiliaryCacheKey='',auxiliaryRevealTimer=0,auxiliaryRevealKey='',auxiliaryReadyKey='',auxiliaryFadeKey='';
const BAND_NAMES=['Apex','Elite','Strong','Middle Class','Developing','Weak','Basement'];
const ratingInfo={
  singles:['Singles ratings','Opponent-adjusted singles power. Minimum 4 completed singles rubbers for a ranked position.'],
  pairs:['Doubles pair ratings','Each recurring partnership is one rating entity. Minimum 2 matches to rank.'],
  doublesPlayers:['Individual doubles ratings','Partner-adjusted, experimental doubles contribution. Ranking needs 4 appearances, 2 partners and an identifiable network position.'],
  overall:['Overall ratings','50/50 average of singles and established individual doubles Power.']
};

function resolvedDark(){return theme==='dark'||(theme==='auto'&&matchMedia('(prefers-color-scheme: dark)').matches)}
function competitionLabel(code){return code==='AA'?'Saturday AM':code==='UA'?'Sunday AM':'Competition'}
function sectionCompetitionLabel(section){return section?.competition_label||competitionLabel(section?.competition_code)}
function historySeasonSections(season){return(season?.sections||[]).map(section=>({...section,competition_code:section.competition_code||season.competition_code,competition_label:section.competition_label||season.competition_label||competitionLabel(section.competition_code||season.competition_code),season_id:section.season_id||season.season_id,season_label:section.season_label||season.season_label}))}
function applyTheme(){const root=document.documentElement;root.dataset.theme=theme;root.dataset.accent=accent;root.dataset.interface=interfaceMode;const dark=resolvedDark();root.style.backgroundColor='';root.style.colorScheme=dark?'dark':'light';const color=getComputedStyle(root).getPropertyValue('--chrome-color').trim(),chrome=window.CSS?.supports('color',color)?color:(interfaceMode==='future'?(dark?'#101109':'#f3f2e9'):'#173f63');$('#themeColor').content=chrome}
applyTheme();matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change',()=>{if(theme==='auto')applyTheme()});
function fmtTime(iso){if(!iso)return'Not available';return new Date(iso).toLocaleString('en-AU',{day:'numeric',month:'short',hour:'numeric',minute:'2-digit'})}
function personButton(name){return '<button class="person" data-player="'+esc(name)+'">'+esc(name)+'</button>'}
function globalPersonButton(row){return '<button class="person" data-global-player="'+esc(row.player)+'" data-section-code="'+esc(row.sectionCode)+'">'+esc(row.player)+'</button>'}
function resultPerson(name,label=name){const known=singles.some(x=>x.player===name)||dinds.some(x=>x.player===name);return known?'<button class="person" data-player="'+esc(name)+'">'+esc(label)+'</button>':esc(label)}
function close(id){const overlay=$(id);if(!overlay)return;overlay.classList.add('hidden');if(id==='#profileOverlay')$('#profileMatchExplorer')?.classList.add('hidden');if(!document.querySelector('.overlay:not(.hidden)'))document.body.classList.remove('modal-open')}
function switchPage(page){activePage=page;if(page!=='ratings')cancelAuxiliaryReveal();$$('.main-tab').forEach(b=>b.classList.toggle('active',b.dataset.page===page));$$('.page').forEach(p=>p.classList.toggle('active',p.id==='page-'+page))}

function auxiliaryEnabled(){return !!window.AuxiliaryPortal?.isUnlocked?.()}
function auxiliarySectionEligible(){return !!(D&&window.AuxiliaryModule?.isHighestSundaySection(D.meta,viewCatalog))}
function auxiliaryState(){return{extras:auxiliaryEnabled(),page:activePage,scope:ratingScope,view:ratingView,team:$('#teamFilter')?.value||'',query:$('#search')?.value||'',section:D?.meta,sections:viewCatalog}}
function auxiliarySignature(state=auxiliaryState()){return [D?.meta?.season_id,D?.meta?.section_code,state.extras,state.page,state.scope,state.view,state.team,String(state.query).trim()].join('|')}
function cancelAuxiliaryReveal(){if(auxiliaryRevealTimer)clearTimeout(auxiliaryRevealTimer);auxiliaryRevealTimer=0;auxiliaryRevealKey='';auxiliaryReadyKey='';auxiliaryFadeKey=''}
function auxiliaryContext(){
  const state=auxiliaryState();if(!window.AuxiliaryModule?.discoveryState(state))return null;
  const key=[D?.meta?.season_id,D?.meta?.section_code].join('|');
  if(!auxiliaryCache||auxiliaryCacheKey!==key){auxiliaryCache=window.AuxiliaryModule.buildContext(D);auxiliaryCacheKey=key}
  return auxiliaryCache;
}
function auxiliaryVisibleContext(){
  const state=auxiliaryState(),module=window.AuxiliaryModule;
  if(!module?.discoveryState(state)){cancelAuxiliaryReveal();return null}
  const key=auxiliarySignature(state);
  if(module.delayedAlias(state.query)){
    if(auxiliaryReadyKey===key)return auxiliaryContext();
    if(auxiliaryRevealKey!==key){
      cancelAuxiliaryReveal();auxiliaryRevealKey=key;
      auxiliaryRevealTimer=setTimeout(()=>{if(auxiliarySignature()===key&&module.discoveryState(auxiliaryState())){auxiliaryRevealTimer=0;auxiliaryReadyKey=key;auxiliaryFadeKey=key;renderRatings();setTimeout(()=>{if(auxiliaryFadeKey===key)auxiliaryFadeKey=''},350)}},700);
    }
    return null;
  }
  cancelAuxiliaryReveal();return auxiliaryContext();
}
function auxiliaryPlayer(name){return name===window.AuxiliaryModule?.CANONICAL&&!!auxiliaryCache&&auxiliaryCacheKey===[D?.meta?.season_id,D?.meta?.section_code].join('|')&&auxiliaryEnabled()&&!!window.AuxiliaryModule?.discoveryState(auxiliaryState())}

function csvCell(value){const text=String(value??'');return'"'+text.replace(/"/g,'""')+'"'}
function exportSectionCSV(){
  if(!D?.meta)return;
  const header=['record_type','competition','section','fixture_id','date','round','status','home_team','away_team','home_points','away_points','home_rubbers','away_rubbers','home_games','away_games','rubber_type','rubber_position','home_players','away_players','winner','score'];
  const rows=[header];
  for(const round of D.results||[])for(const fixture of round.fixtures||[]){
    const base=['Fixture',D.meta.competition_label,D.meta.section_label,fixture.fixtureId,fixture.date??round.date,fixture.round??round.round,fixture.status,fixture.home,fixture.away,fixture.homePoints,fixture.awayPoints,fixture.homeRubbers,fixture.awayRubbers,fixture.homeGames,fixture.awayGames,'','','','','',''];
    rows.push(base);
    for(const rubber of (fixture.rubbers||[]).slice().sort((a,b)=>(a.type==='Doubles'?0:1)-(b.type==='Doubles'?0:1)||String(a.position).localeCompare(String(b.position),undefined,{numeric:true})))rows.push(['Rubber',D.meta.competition_label,D.meta.section_label,fixture.fixtureId,fixture.date??round.date,fixture.round??round.round,fixture.status,fixture.home,fixture.away,fixture.homePoints,fixture.awayPoints,fixture.homeRubbers,fixture.awayRubbers,fixture.homeGames,fixture.awayGames,rubber.type,rubber.position,rubber.home,rubber.away,rubber.winner,rubber.score]);
  }
  const csv=rows.map(row=>row.map(csvCell).join(',')).join('\r\n');
  const filename=(D.meta.competition_label+'-'+D.meta.section_label+'-results').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')+'.csv';
  const url=URL.createObjectURL(new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'})),link=document.createElement('a');
  link.href=url;link.download=filename;document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

function downloadFile(contents, filename, type){
  const url=URL.createObjectURL(new Blob([contents],{type})),link=document.createElement('a');
  link.href=url;link.download=filename;document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function exportModelAudit(){
  if(!D?.meta)return;
  const rubbers=(D.results||[]).flatMap(round=>(round.fixtures||[]).flatMap(fixture=>(fixture.rubbers||[]).slice().sort((a,b)=>(a.type==='Doubles'?0:1)-(b.type==='Doubles'?0:1)||String(a.position).localeCompare(String(b.position),undefined,{numeric:true})).map(rubber=>({
    fixture_id:fixture.fixtureId,date:fixture.date??round.date,round:fixture.round??round.round,status:fixture.status,
    home_team:fixture.home,away_team:fixture.away,...rubber
  }))));
  const audit={
    export_type:'BRTA Power Ratings calculation audit',
    generated_at:new Date().toISOString(),
    disclaimer:'Unofficial analysis. Official-as-entered TROLS scorecards are the source data.',
    section:D.meta,
    model:{
      version:'V3 scoreline likelihood',
      game_probability:'logistic((theta_i - theta_j) / 0.75)',
      score_likelihood:'games_for * log(p) + games_against * log(1 - p)',
      match_date_weight:'2^(-age_days / 365)',
      regularisation:'L2 penalty: (5 / 2) * sum(theta_i^2)',
      displayed_power:'1500 + 600 * theta',
      publication_thresholds:{singles:'4 completed singles rubbers',doubles_pairs:'2 matches',individual_doubles:'4 appearances, 2 distinct partners and identifiable network position (Rubbers sections show partner-dependent evidence)'}
    },
    source_rubbers:rubbers,
    singles_match_observations:(D.singlesMatches||[]).map(([round,date,player,opponent,games_for,games_against,winner,score,fixture_id])=>({round,date,fixture_id,player,opponent,games_for,games_against,winner,score})),
    fitted_outputs:{singles:D.singles,doubles_pairs:D.doubles,individual_doubles:D.doublesIndividuals,overall:overallData()},
    notes:[D.note,'Ratings are fitted across each result network; this export includes the entered observations, stated objective and published fitted values.'].filter(Boolean)
  };
  const filename=(D.meta.competition_label+'-'+D.meta.section_label+'-rating-model-audit').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')+'.json';
  downloadFile(JSON.stringify(audit,null,2),filename,'application/json;charset=utf-8');
}

function choiceValue(id){return $('#'+id).dataset.value||''}
function closeChoices(except){$$('.section-choice.open').forEach(x=>{if(x.id!==except){x.classList.remove('open');x.querySelector('.choice-trigger').setAttribute('aria-expanded','false')}})}
function renderChoice(id, options, selected){
  const trigger=$('#'+id),menu=$('#'+id.replace('Select','Options')),choice=trigger.closest('.section-choice');
  const chosen=options.find(x=>x[0]===selected)||options[0];
  trigger.dataset.value=chosen?.[0]||'';trigger.querySelector('span').textContent=chosen?.[1]||'No options';
  menu.innerHTML=options.map(([value,label])=>'<button type="button" role="option" class="choice-option '+(value===trigger.dataset.value?'selected':'')+'" aria-selected="'+(value===trigger.dataset.value)+'" data-choice-id="'+id+'" data-choice-value="'+esc(value)+'"><i aria-hidden="true">✓</i><span>'+esc(label)+'</span></button>').join('');
  trigger.onclick=()=>{const open=!choice.classList.contains('open');closeChoices(choice.id);choice.classList.toggle('open',open);trigger.setAttribute('aria-expanded',String(open))};
}
function setupSelectors(){
  const comps=[...new Map(viewCatalog.map(x=>[x.competition_code,sectionCompetitionLabel(x)])).entries()];
  const saved=activeHistorySeasonId?historySectionCode():localStorage.getItem('brta-section'),available=viewCatalog.some(x=>x.section_code===saved);
  const code=available?saved:(activeHistorySeasonId?viewCatalog[0]?.section_code:DATA.defaultSectionCode);
  const meta=viewCatalog.find(x=>x.section_code===code)||viewCatalog[0];
  if(!meta)return;
  renderChoice('competitionSelect',comps.map(([c,l])=>[c,String(l).replace(' - ',' · ')]),meta.competition_code);
  fillSections(meta.competition_code,code);
  $('#sectionCount').textContent=viewCatalog.length+' section'+(viewCatalog.length===1?'':'s')+' available';
}
function fillSections(comp,selected){
  const list=viewCatalog.filter(x=>x.competition_code===comp);
  const code=list.some(x=>x.section_code===selected)?selected:list[0]?.section_code;
  renderChoice('sectionSelect',list.map(x=>[x.section_code,x.section_label]),code);
  return code;
}
async function loadSection(code){
  cancelAuxiliaryReveal();const token=++loadingToken,meta=viewCatalog.find(x=>x.section_code===code);
  $('#sectionSubtitle').textContent=(meta?.competition_label||'').replace(' - ',' · ')+' · '+(meta?.section_label||'Loading…');
  document.body.classList.add('section-loading');
  try{
    const dataPath=meta?.data_path||('data/site/sections/'+code+'.json');
    const payload=await fetch(dataPath+'?v='+encodeURIComponent(DATA.globalSync.checkedAt||''),{cache:'no-store'}).then(r=>{if(!r.ok)throw Error('Section data could not be loaded');return r.json()});
    if(token!==loadingToken)return;
    D=normaliseTeamLabels(payload);singles=D.singles||[];dinds=D.doublesIndividuals||[];pairs=D.doubles||[];teams=D.teams||[];
    if(activeHistorySeasonId){const selection={seasonId:activeHistorySeasonId,sectionCode:code};localStorage.setItem('brta-history-selection',JSON.stringify(selection))}else localStorage.setItem('brta-section',code);
    resultRound=D.results?.[0]?.round??null;selectedMatch=null;selectedPrediction=null;activePredictionMatch=null;roundSimulations={};
    renderChoice('competitionSelect',[...new Map(viewCatalog.map(x=>[x.competition_code,sectionCompetitionLabel(x).replace(' - ',' · ')])).entries()],D.meta.competition_code);fillSections(D.meta.competition_code,code);
    $('#sectionSubtitle').textContent=D.meta.competition_label.replace(' - ',' · ')+' · '+D.meta.section_label;
    renderAll();
  }catch(error){$('#statusStrip').innerHTML='<div class="notice"><b>Could not load this section.</b><span>'+esc(error.message)+'</span></div>'}
  finally{if(token===loadingToken)document.body.classList.remove('section-loading')}
}

function statusStrip(){const s=D.sync||{};if(D.meta?.is_archive){$('#statusStrip').innerHTML='<div><b>Season</b><span>'+esc(D.meta.season_label||'Historical')+'</span></div><div><b>Source</b><span>Official TROLS archive</span></div><div><b>Latest record</b><span>'+esc(D.knockout?.grandFinal?'Grand final':D.knockout?.semifinals?.length?'Semifinals':(D.results?.[0]?.label||'Historical results'))+'</span></div><div><b>Data check</b><span class="status-ok">Validated</span></div>';return}const latestLabel=D.results?.[0]?.label||('Round '+(s.latestRound??D.roundOverview?.round??'—')),updateLabel=s.updatedAt?fmtTime(s.updatedAt):(s.newResultsLastCheck?'Updated in latest check':'No changes in latest check');$('#statusStrip').innerHTML='<div><b>Last checked</b><span>'+esc(fmtTime(s.checkedAt))+'</span></div><div><b>Results updated</b><span>'+esc(updateLabel)+'</span></div><div><b>Latest published round</b><span>'+esc(latestLabel)+'</span></div><div><b>Sync status</b><span class="status-ok">'+(s.validation==='passed'?'Up to date':'Check needed')+'</span></div>'}
function showSyncToast(){const s=DATA.globalSync||{},check=s.checkedAt;if(!check||localStorage.getItem('brta-sync-toast-seen')===check)return;localStorage.setItem('brta-sync-toast-seen',check);const fresh=!!s.newResultsLastCheck,title=fresh?'Results refreshed':'Results checked',message=fresh?'Official results changed, so the ratings and match pages have been refreshed across Saturday and Sunday AM.':'The latest check found no new official results. Everything already published remains up to date.';const toast=document.createElement('div');toast.className='sync-toast '+(fresh?'updated':'checked');toast.innerHTML='<div class="sync-toast-icon">'+(fresh?'✓':'i')+'</div><div><b>'+title+'</b><p>'+message+'</p></div><button class="sync-toast-close" aria-label="Close update">×</button>';const end=()=>{toast.classList.add('leaving');setTimeout(()=>toast.remove(),220)};toast.querySelector('button').onclick=end;$('#syncToastHost').appendChild(toast);setTimeout(end,10000)}
function teamOptions(){
  const selected=$('#teamFilter').value,names=[...new Set(singles.map(x=>x.team).filter(Boolean))].sort();
  if(auxiliaryEnabled()&&auxiliarySectionEligible())names.splice(0,names.length,...window.AuxiliaryModule.teamChoices(names,true));
  $('#teamFilter').innerHTML='<option value="">All teams</option>'+names.map(t=>'<option>'+esc(t)+'</option>').join('');
  if(names.includes(selected))$('#teamFilter').value=selected;
}
function overallData(){const sm=new Map(singles.map(x=>[x.player,x])),dm=new Map(dinds.map(x=>[x.player,x]));return[...new Set([...sm.keys(),...dm.keys()])].map(player=>{const s=sm.get(player),d=dm.get(player),both=s&&d;return{player,team:s?.team||d?.team||'',rating:both?Math.round((s.rating+d.rating)/2):(s?.rating||d?.rating||1500),se:both?Math.round(Math.hypot(s.se,d.se)/2):(s?.se||d?.se||0),s,d,qualified:!!(s&&s.matches>=4&&d&&d.qualified)}}).sort((a,b)=>b.rating-a.rating)}
function currentRows(){if(ratingView==='singles')return{rows:singles,min:4,type:'player'};if(ratingView==='pairs')return{rows:pairs,min:2,type:'pair'};if(ratingView==='doublesPlayers')return{rows:dinds,min:4,type:'doublesPlayers'};return{rows:overallData(),min:0,type:'overall'}}
function ratingQualified(x,min,type){if(type==='overall')return x.qualified;if(type==='doublesPlayers')return!!x.qualified;return x.matches>=min}
function bandModel(rows,min,type){const vals=rows.filter(x=>ratingQualified(x,min,type)).map(x=>x.rating).sort((a,b)=>a-b);if(!vals.length)return{classFor:()=>'',bounds:[]};const med=a=>a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2,M=med(vals),dev=vals.map(x=>Math.abs(x-M)).sort((a,b)=>a-b),S=1.4826*med(dev)||1,c=[1.5,.75,.2,-.35,-1,-1.65].map(z=>M+z*S),bounds=['≥ '+Math.round(c[0]),Math.round(c[1])+'–'+Math.round(c[0]-1),Math.round(c[2])+'–'+Math.round(c[1]-1),Math.round(c[3])+'–'+Math.round(c[2]-1),Math.round(c[4])+'–'+Math.round(c[3]-1),Math.round(c[5])+'–'+Math.round(c[4]-1),'< '+Math.round(c[5])];return{bounds,classFor:r=>r>=c[0]?'b0':r>=c[1]?'b1':r>=c[2]?'b2':r>=c[3]?'b3':r>=c[4]?'b4':r>=c[5]?'b5':'b6'}}
function renderBandInfo(model){$('#bandInfo').innerHTML=model.bounds.length?'<div class="band-info-head"><b>Performance bands</b></div><div class="band-keys">'+BAND_NAMES.map((n,i)=>'<div class="band-key b'+i+'"><i></i><span><b>'+n+'</b><small>'+model.bounds[i]+'</small></span></div>').join('')+'</div>':''}
function bandDivider(cls,model,colspan=8){const i=Number(cls.slice(1));return'<tr class="band-divider '+cls+'"><td colspan="'+colspan+'"><div><i></i><b>'+BAND_NAMES[i]+'</b><span>'+model.bounds[i]+'</span></div></td></tr>'}

function archiveGlobalRowsFromSection(payload,section){
  const singlesByPlayer=new Map((payload.singles||[]).map(row=>[row.player,row])),doublesByPlayer=new Map((payload.doublesIndividuals||[]).map(row=>[row.player,row]));
  return[...new Set([...singlesByPlayer.keys(),...doublesByPlayer.keys()])].map(player=>{
    const s=singlesByPlayer.get(player),d=doublesByPlayer.get(player),both=s&&d;
    return{
      player,team:s?.team||d?.team||'',sectionCode:section.section_code,sectionLabel:payload.meta?.section_label||section.section_label,
      competitionCode:payload.meta?.competition_code||section.competition_code,competitionLabel:payload.meta?.competition_label||section.competition_label||competitionLabel(section.competition_code),
      singlesRating:s?.rating,singlesSe:s?.se,singlesMatches:s?.matches,singlesWins:s?.wins,singlesLosses:s?.losses,singlesGf:s?.gf,singlesGa:s?.ga,
      doublesRating:d?.rating,doublesSe:d?.se,doublesMatches:d?.matches,doublesWins:d?.wins,doublesLosses:d?.losses,doublesGf:d?.gf,doublesGa:d?.ga,doublesQualified:!!d?.qualified,doublesStatus:d?.ranking_status,
      overallRating:both?Math.round((s.rating+d.rating)/2):(s?.rating??d?.rating??null),overallSe:both?Math.round(Math.hypot(s.se||0,d.se||0)/2):(s?.se??d?.se??null),overallQualified:!!(s&&s.matches>=4&&d?.qualified)
    };
  });
}
function archiveGlobalRows(){
  const seasonId=activeHistorySeasonId;if(!seasonId)return null;
  let entry=archiveGlobalRowsCache.get(seasonId);if(entry)return entry;
  entry={rows:null,error:null};
  entry.promise=Promise.all(viewCatalog.map(section=>fetch(section.data_path+'?v='+encodeURIComponent(DATA.globalSync.checkedAt||''),{cache:'no-store'}).then(response=>{if(!response.ok)throw Error('One or more archived sections could not be loaded.');return response.json()}).then(payload=>archiveGlobalRowsFromSection(normaliseTeamLabels(payload),section)))).then(groups=>{entry.rows=groups.flat();return entry.rows}).catch(error=>{entry.error=error;return[]});
  entry.promise.then(()=>{if(activeHistorySeasonId===seasonId&&ratingScope==='all')renderRatings()});
  archiveGlobalRowsCache.set(seasonId,entry);
  return entry;
}
function primeArchiveGlobalRows(){if(activeHistorySeasonId)archiveGlobalRows()}
function globalRatingRows(rows=DATA.globalPlayers||[]){
  if(ratingView==='singles')return rows.filter(x=>x.singlesRating!=null).map(x=>({...x,rating:x.singlesRating,se:x.singlesSe,matches:x.singlesMatches,wins:x.singlesWins,losses:x.singlesLosses,gf:x.singlesGf,ga:x.singlesGa,qualified:x.singlesMatches>=4,type:'player'}));
  if(ratingView==='doublesPlayers')return rows.filter(x=>x.doublesRating!=null).map(x=>({...x,rating:x.doublesRating,se:x.doublesSe,matches:x.doublesMatches,wins:x.doublesWins,losses:x.doublesLosses,gf:x.doublesGf,ga:x.doublesGa,qualified:x.doublesQualified,type:'doublesPlayers'}));
  if(ratingView==='overall')return rows.filter(x=>x.overallRating!=null).map(x=>({...x,rating:x.overallRating,se:x.overallSe,qualified:x.overallQualified,type:'overall'}));
  return[];
}
function renderGlobalRatings(){
  const [title,desc]=ratingInfo[ratingView],q=$('#search').value.trim().toLowerCase();
  const archive=activeHistorySeasonId?archiveGlobalRows():null,sectionCount=viewCatalog.length,seasonLabel=activeHistorySeasonId?(viewCatalog[0]?.season_label||D?.meta?.season_label||'selected season'):'current season';
  $('#ratingsTitle').textContent='All sections · '+title;
  $('#ratingsDesc').textContent=desc+' Search spans all '+sectionCount+' sections in '+seasonLabel+'.';
  $('#ratingsHint').textContent='Section ratings are fitted independently and are not cross-section rankings.';
  $('#teamFilter').disabled=true;$('#teamFilter').value='';
  renderBandInfo({bounds:[]});
  if(ratingView==='pairs'){
    $('#ratingHead').innerHTML='<tr><th>All-section player search</th></tr>';
    $('#ratingBody').innerHTML='<tr><td>All-section search is for individual players. Choose Singles, Doubles players or Overall.</td></tr>';
    return;
  }
  if(!q){
    $('#ratingHead').innerHTML='<tr><th>Player</th><th>Team</th><th>Section</th><th>Power</th><th>Record</th><th>Evidence</th><th>Status</th><th>Uncertainty</th></tr>';
    $('#ratingBody').innerHTML='<tr><td colspan="8">Type a player name to search every section in '+esc(seasonLabel)+'.</td></tr>';
    return;
  }
  if(archive?.error){$('#ratingHead').innerHTML='<tr><th>All-section player search</th></tr>';$('#ratingBody').innerHTML='<tr><td>Could not load the selected season’s player index. Please try again.</td></tr>';return}
  if(archive&&!archive.rows){$('#ratingHead').innerHTML='<tr><th>All-section player search</th></tr>';$('#ratingBody').innerHTML='<tr><td>Loading every section from '+esc(seasonLabel)+'…</td></tr>';return}
  const rows=globalRatingRows(archive?.rows).filter(x=>x.player.toLowerCase().includes(q)).sort((a,b)=>{
    const ae=a.player.toLowerCase()===q?0:a.player.toLowerCase().startsWith(q)?1:2;
    const be=b.player.toLowerCase()===q?0:b.player.toLowerCase().startsWith(q)?1:2;
    return ae-be||a.player.localeCompare(b.player)||a.competitionLabel.localeCompare(b.competitionLabel)||a.sectionLabel.localeCompare(b.sectionLabel);
  });
  const sectionCell=x=>'<b>'+esc(x.sectionLabel)+'</b><small class="section-result-comp">'+esc(x.competitionLabel.replace(' - ',' · '))+'</small>';
  let out='';
  for(const x of rows){
    if(ratingView==='overall'){
      const s=x.singlesRating??'—',d=x.doublesRating??'—';
      out+='<tr class="'+(x.qualified?'':'provisional')+'"><td>'+globalPersonButton(x)+'</td><td>'+teamName(x.team)+'</td><td>'+sectionCell(x)+'</td><td><b>'+x.rating+'</b></td><td>'+s+'</td><td>'+d+'</td><td>'+(x.qualified?'Ranked':'Provisional')+'</td><td>±'+(x.se??'—')+'</td></tr>';
    }else{
      const pct=x.gf+x.ga?(100*x.gf/(x.gf+x.ga)).toFixed(1)+'%':'—',evidence=ratingView==='doublesPlayers'?x.matches+' matches · '+esc(x.doublesStatus||'Provisional'):x.matches+' matches · '+pct;
      out+='<tr class="'+(x.qualified?'':'provisional')+'"><td>'+globalPersonButton(x)+'</td><td>'+teamName(x.team)+'</td><td>'+sectionCell(x)+'</td><td><b>'+x.rating+'</b></td><td>'+x.wins+'–'+x.losses+'</td><td>'+x.gf+'–'+x.ga+'</td><td>'+evidence+'</td><td>±'+(x.se??'—')+'</td></tr>';
    }
  }
  $('#ratingBody').innerHTML=out||'<tr><td colspan="8">No player found across the '+sectionCount+' sections in '+esc(seasonLabel)+'.</td></tr>';
  $('#ratingHead').innerHTML=ratingView==='overall'
    ?'<tr><th>Player</th><th>Team</th><th>Section</th><th>Overall</th><th>Singles</th><th>Doubles</th><th>Status</th><th>Uncertainty</th></tr>'
    :'<tr><th>Player</th><th>Team</th><th>Section</th><th>Power</th><th>W–L</th><th>Games</th><th>Evidence</th><th>Uncertainty</th></tr>';
}
function renderRatings(){
  if(ratingScope==='all'){cancelAuxiliaryReveal();renderGlobalRatings();return}
  $('#teamFilter').disabled=false;
  const [title,desc]=ratingInfo[ratingView];$('#ratingsTitle').textContent=title;$('#ratingsDesc').textContent=desc;
  $('#ratingFilters').classList.remove('hidden');$('#ratingsHint').textContent='';
  const {rows,min,type}=currentRows(),q=$('#search').value.toLowerCase(),tf=$('#teamFilter').value,band=bandModel(rows,min,type),derived=auxiliaryVisibleContext();
  renderBandInfo(band);
  let rank=0,out='',lastBand='';
  if(derived){
    const fading=auxiliaryFadeKey===auxiliarySignature()?' auxiliary-reveal':'';
    const godly=window.AuxiliaryModule.godlyThreshold(derived.row);
    $('#bandInfo').innerHTML='<div class="band-info-head"><b>Performance bands</b></div><div class="band-keys"><div class="band-key b0"><i></i><span><b>Godly</b><small>≥ '+godly+'</small></span></div>'+BAND_NAMES.map((n,i)=>'<div class="band-key b'+i+'"><i></i><span><b>'+n+'</b><small>'+band.bounds[i]+'</small></span></div>').join('')+'</div>';
    out+='<tr class="band-divider b0"><td colspan="8"><div><i></i><b>Godly</b><span>≥ '+godly+'</span></div></td></tr>';
    out+='<tr class="b0'+fading+'"><td>0</td><td>'+personButton(derived.row.player)+'</td><td>'+teamName(derived.row.team)+'</td><td><b>'+derived.row.rating+'</b></td><td>'+derived.row.wins+'–0</td><td>'+derived.row.gf+'–'+derived.row.ga+'</td><td>'+(derived.row.gf+derived.row.ga?(100*derived.row.gf/(derived.row.gf+derived.row.ga)).toFixed(1)+'%':'—')+'</td><td>±'+derived.row.se+'</td></tr>';
  }
  for(const x of rows){const qual=ratingQualified(x,min,type);if(qual)rank++;if(!qual&&!showProv)continue;if(q&&!x.player.toLowerCase().includes(q))continue;if(tf&&x.team!==tf)continue;const cls=qual?band.classFor(x.rating):'provisional';if(qual&&cls!==lastBand){out+=bandDivider(cls,band,type==='pair'?9:8);lastBand=cls}
    const pct=x.gf+x.ga?(100*x.gf/(x.gf+x.ga)).toFixed(1)+'%':'—';
    if(type==='pair'){const pair=x.player.split(' / ').map(personButton).join('<span class="pair-sep"> / </span>'),effect=(x.pairEffect>=0?'+':'')+(x.pairEffect??0);out+='<tr class="'+cls+'"><td>'+(qual?rank:'—')+'</td><td>'+pair+'</td><td>'+teamName(x.team)+'</td><td><b>'+x.rating+'</b></td><td>'+(x.individualAverage??'—')+'</td><td class="'+((x.pairEffect??0)>=0?'performance-above':'performance-below')+'">'+effect+'</td><td>'+x.wins+'–'+x.losses+'</td><td>'+x.matches+'</td><td>±'+x.se+'</td></tr>'}
    else if(type==='overall')out+='<tr class="'+cls+'"><td>'+(qual?rank:'—')+'</td><td>'+personButton(x.player)+'</td><td>'+teamName(x.team)+'</td><td><b>'+x.rating+'</b></td><td>'+(x.s?.rating??'—')+'</td><td>'+(x.d?.rating??'—')+'</td><td>'+(qual?'Ranked':'Provisional')+'</td><td>±'+x.se+'</td></tr>';
    else{const evidence=type==='doublesPlayers'?x.matches+' · '+x.partner_count+' partners · '+esc(x.ranking_status):pct;out+='<tr class="'+cls+'"><td>'+(qual?rank:'—')+'</td><td>'+personButton(x.player)+'</td><td>'+teamName(x.team)+'</td><td><b>'+x.rating+'</b></td><td>'+x.wins+'–'+x.losses+'</td><td>'+x.gf+'–'+x.ga+'</td><td>'+evidence+'</td><td>±'+x.se+'</td></tr>'}
  }
  $('#ratingBody').innerHTML=out||'<tr><td colspan="'+(type==='pair'?9:8)+'">No matching entries.</td></tr>';
  $('#ratingHead').innerHTML=type==='overall'?'<tr><th>#</th><th>Player</th><th>Team</th><th>Overall</th><th>Singles</th><th>Doubles</th><th>Status</th><th>Uncertainty</th></tr>':type==='pair'?'<tr><th>#</th><th>Pair</th><th>Team</th><th>Pair Power</th><th>Individual avg</th><th>Pair effect</th><th>W–L</th><th>Matches</th><th>Uncertainty</th></tr>':'<tr><th>#</th><th>Player</th><th>Team</th><th>Power</th><th>W–L</th><th>Games</th><th>'+(type==='doublesPlayers'?'Evidence':'Game % / Matches')+'</th><th>Uncertainty</th></tr>';
}
function teamInsight(team){return D.teamInsights?.[team]||{completedTies:0,lineupCount:0,lineupStability:null,lineups:[],pairs:[]}}
function recordText(row){return row?(row.wins+'–'+row.losses+(row.draws?'–'+row.draws+' D':'')):'No recorded ties'}
function teamLineupPreview(lineup){if(!lineup)return'<span class="small-note">No completed scorecard lineup recorded yet.</span>';return'<div class="team-lineup-preview"><b>'+lineup.players.map(esc).join(' · ')+'</b><span>'+lineup.matches+' tie'+(lineup.matches===1?'':'s')+' · '+recordText(lineup)+'</span></div>'}
function renderTeams(){
  const cards=teams.map(x=>{const info=teamInsight(x.team),top=info.lineups?.[0],pair=info.pairs?.[0],stability=info.lineupStability==null?'—':info.lineupStability+'%',lineupNote=top?teamLineupPreview(top):'<span class="small-note">Lineup data appears after a completed scorecard.</span>',pairNote=pair?'<span><b>'+esc(pair.pair)+'</b> · '+pair.matches+' ties · '+recordText(pair)+'</span>':'<span class="small-note">No recurring doubles pair recorded.</span>';return'<article class="team-card"><div class="team-card-head"><div><h2>'+clubTeamButton(x.team)+'</h2><p>'+x.modelled+' modelled players · '+info.completedTies+' completed ties</p></div><div class="team-power"><span>Power</span><b>'+x.avg.toFixed(0)+'</b></div></div><div class="team-metrics"><div><span>Best four</span><b>'+x.best4.toFixed(0)+'</b></div><div><span>Ladder points</span><b>'+x.ladder+'</b></div><div><span>Lineup stability</span><b>'+stability+'</b></div><div><span>Different lineups</span><b>'+(info.lineupCount||0)+'</b></div></div><section class="team-dependence"><div class="team-dependence-head"><div><span class="kicker">LINEUP DEPENDENCE</span><h3>Most used lineup</h3></div><button type="button" class="button secondary" data-lineup-history="'+esc(x.team)+'">View all lineups</button></div>'+lineupNote+'<div class="team-pair-note"><span>Most used doubles pair</span>'+pairNote+'</div></section><div class="team-card-actions"><button type="button" class="button primary" data-team-predict="'+esc(x.team)+'">Prediction Centre</button><button type="button" class="button secondary" data-club-team="'+esc(x.team)+'">Club Zone</button></div></article>';}).join('');
  $('#teamCards').innerHTML='<div class="teams-page-actions"><div><span class="kicker">TEAM EXPLORER</span><h2>How each side is built</h2></div><button type="button" class="button primary" data-open-prediction-home="1">Open Prediction Centre</button></div><div class="team-card-grid">'+cards+'</div>';
}
function knockoutMatchHTML(match){const score=match.score||((match.homePoints!=null&&match.awayPoints!=null)?match.homePoints+'–'+match.awayPoints:(match.status==='Completed'?'Result':'—')),date=match.date?match.date:'Date not published by TROLS',detail=[match.status&&match.status!=='Completed'&&match.status!=='Projected'?match.status:'',date,match.homeGames!=null&&match.awayGames!=null?match.homeGames+'–'+match.awayGames+' games':'',match.homePoints!=null&&match.awayPoints!=null?match.homePoints+'–'+match.awayPoints+' points':''].filter(Boolean).join(' · ');return'<div class="knockout-match"><span class="knockout-home '+(match.winner===match.home?'knockout-winner':'')+'">'+teamName(match.home)+(match.winner===match.home?' <small>Winner</small>':'')+'</span><b class="knockout-score">'+esc(score)+'</b><span class="knockout-away '+(match.winner===match.away?'knockout-winner':'')+'">'+teamName(match.away)+(match.winner===match.away?' <small>Winner</small>':'')+'</span><small class="knockout-detail">'+esc(detail||'Projected matchup')+'</small></div>'}
function renderKnockout(){const box=$('#knockoutSummary'),k=D.knockout||{};if(!k.source||k.source==='none'){box.innerHTML='';return}const semiRecorded=k.semifinalSource==='TROLS',finalRecorded=k.grandFinalSource==='TROLS',caption=semiRecorded||finalRecorded?'Official results where TROLS has published them':'Projected from the completed 14-round ladder',semiMatches=k.semifinalHistory?.length?k.semifinalHistory:(k.semifinals||[]),finalMatches=k.grandFinalHistory?.length?k.grandFinalHistory:(k.grandFinal?[k.grandFinal]:[]),qualifiers=(k.qualifiers||[]).map(x=>'#'+(x.seed||'—')+' '+x.team).join(' · '),champion=k.champion?'<div class="knockout-crown">Season winner · <b>'+esc(k.champion)+'</b>'+(k.runnerUp?' · Runner-up · '+esc(k.runnerUp):'')+'</div>':'';if(!semiMatches.length&&!finalMatches.length){box.innerHTML='';return}box.innerHTML='<div class="knockout-head"><h2>Knockout draw</h2><small>'+esc(caption)+'</small></div>'+(qualifiers?'<p class="knockout-note">Semifinal qualifiers · '+esc(qualifiers)+'</p>':'')+'<div class="knockout-rounds">'+(semiMatches.length?'<section class="knockout-round"><h3>Semifinals · '+(semiRecorded?'TROLS result':'projected')+'</h3>'+semiMatches.map(knockoutMatchHTML).join('')+'</section>':'')+(finalMatches.length?'<section class="knockout-round knockout-final"><h3>Grand final · '+(finalRecorded?'TROLS result':k.grandFinalSource==='pending'?'awaiting result':'projected')+(finalMatches.length>1?' · published entries':'')+'</h3>'+finalMatches.map(knockoutMatchHTML).join('')+'</section>':'')+'</div>'+champion}
function renderStandings(){const rows=D.standings||[],knockout=D.knockout||{},qualifiers=new Set((knockout.qualifiers||[]).map(x=>x.team)),hasSemis=qualifiers.size>=4||knockout.source==='projected';$('#standingsBody').innerHTML=rows.map((x,i)=>{const position=x.officialPosition||i+1,winCount=x.officialWins??x.wins,percent=x.officialPercentage;const cells=D.meta?.is_archive?'<td>'+esc(winCount??'—')+'</td><td><b>'+esc(x.points)+'</b></td><td>'+((percent==null||Number.isNaN(Number(percent)))?'—':Number(percent).toFixed(2)+'%')+'</td>':'<td>'+x.played+'</td><td>'+x.wins+'</td><td>'+x.draws+'</td><td>'+x.losses+'</td><td>'+x.rubbersFor+'–'+x.rubbersAgainst+'</td><td>'+x.gamesFor+'–'+x.gamesAgainst+'</td><td><b>'+x.points+'</b></td>';const row='<tr class="'+(qualifiers.has(x.team)?'standing-qualifier':'')+'"><td><b>'+position+'</b></td><td><b>'+teamName(x.team)+'</b></td>'+cells+'</tr>';const cut=i===3&&(rows.length>4||hasSemis)?'<tr class="playoff-cut"><td colspan="'+(D.meta?.is_archive?5:9)+'">Semifinal places · top four</td></tr>':'';return row+cut}).join('');$('#standingsHead').innerHTML=D.meta?.is_archive?'<tr><th>Pos</th><th>Team</th><th>TROLS wins</th><th>Final points</th><th>TROLS %</th></tr>':'<tr><th>Pos</th><th>Team</th><th>P</th><th>W</th><th>D</th><th>L</th><th>Rubbers</th><th>Games</th><th>Pts</th></tr>';renderKnockout();const missing=D.sync?.missingFixtures||0;$('#standingsNote').textContent=D.meta?.is_archive?'Final ladder from TROLS':missing?missing+' result'+(missing===1?'':'s')+' missing':'';$('#standingsCaveat').innerHTML=D.meta?.is_archive?(rows.some(x=>x.standingsSource==='TROLS')?'Final position, wins, points and game percentage are recorded from the TROLS past ladder. Match records are reconstructed from published results.':'TROLS did not publish a final ladder for this section; the displayed standings are reconstructed from its results.'):(missing?'<b>Incomplete:</b> TROLS still has '+missing+' result'+(missing===1?'':'s')+' missing a scorecard. ':'All published results are included. ')+'<span>Tied ladder points are ordered by BRTA games percentage; washouts and full-team forfeits use the published 2026 By-Law treatment.</span>'}

function findMatch(id){for(const round of D.results||[]){const match=round.fixtures.find(x=>x.fixtureId===id);if(match)return match}return null}
function matchWinner(match){
  if(match.status==='Forfeited To')return match.away;
  if(match.status==='Forfeited By')return match.home;
  if(match.status!=='Completed')return'';
  const hs=match.homeSets??match.homeRubbers,as=match.awaySets??match.awayRubbers;
  if(hs!==as)return hs>as?match.home:match.away;
  if(match.homeGames!==match.awayGames)return match.homeGames>match.awayGames?match.home:match.away;
  return'';
}
function matchCard(match){
  const complete=match.status==='Completed',scored=match.homePoints!=null&&match.awayPoints!=null,winner=matchWinner(match),homeWon=winner===match.home,awayWon=winner===match.away;
  const homeMeta=complete?(homeWon?'Won · ':'')+match.homePoints+' pts · '+match.homeGames+' games':scored?(homeWon?'Awarded · ':'')+match.homePoints+' pts':'Home';
  const awayMeta=complete?(awayWon?'Won · ':'')+match.awayPoints+' pts · '+match.awayGames+' games':scored?(awayWon?'Awarded · ':'')+match.awayPoints+' pts':'Away';
  const central=complete?match.homeRubbers+'–'+match.awayRubbers:match.status==='Wash Out'?'Washout':match.status==='Forfeited To'||match.status==='Forfeited By'?'Forfeit':match.status;
  return'<button class="result-match" data-match-id="'+esc(match.fixtureId)+'"><span class="result-team '+(homeWon?'won':'')+'"><b>'+teamName(match.home)+'</b><small>'+homeMeta+'</small></span><span class="result-score"><b>'+esc(central)+'</b><small>'+ (complete?'Rubbers':scored?'Team points':'')+'</small></span><span class="result-team '+(awayWon?'won':'')+'"><b>'+teamName(match.away)+'</b><small>'+awayMeta+'</small></span></button>'
}
function roundHeading(round){return round.label||('Round '+round.round)}
function roundDate(value){return value||'Date not published by TROLS'}
function byeCard(f){return'<div class="fixture-bye"><small>BYE</small><b>'+teamName(f.home==='Bye'?f.away:f.home)+'</b><span>No match this round</span></div>'}
function renderResults(){const rounds=D.results||[];if(!rounds.length){$('#resultsList').innerHTML='<div class="notice">No published results yet.</div>';return}$('#resultsList').innerHTML=rounds.map(round=>{const draw=(D.upcomingFixtures||[]).find(r=>r.round===round.round),byes=(draw?.fixtures||[]).filter(f=>f.status==='Bye');return'<section class="result-round"><header class="result-round-head"><h2>'+esc(roundHeading(round))+'</h2><span>'+esc(roundDate(round.date))+'</span></header><div class="result-round-matches">'+round.fixtures.map(matchCard).join('')+byes.map(byeCard).join('')+'</div></section>'}).join('')}
function rubberCode(r){const n=String(r.position||'').match(/\d+/)?.[0]||'';return(r.type==='Doubles'?'D':'S')+n}
function compactDoublesName(name){return String(name).split('/').map(player=>player.trim().split(/\s+/)[0]).join(' / ')}
function resultDetailHTML(match,contextPlayer=null){
  if(!match)return'<div class="notice">This fixture does not have a scorecard yet.</div>';
  const complete=match.status==='Completed',scored=match.homePoints!=null&&match.awayPoints!=null,winner=matchWinner(match),result=complete?match.homeRubbers+'–'+match.awayRubbers:'—',outcome=winner?esc(winner)+(complete?' won the team tie':' received the team points'):(match.status==='Wash Out'?'The fixture was recorded as a washout':'Team tie level'),pairNames=(name,flags=[])=>String(name).split('/').map((player,index)=>{const full=player.trim();return resultPerson(full,full.split(/\s+/)[0])+(flags[index]?'<i class="emergency-marker" title="Emergency player recorded by TROLS">X</i>':'')}).join(' <span class="pair-sep">/</span> ');
  let metrics=complete?'<div class="result-metrics"><div><span>Rubbers</span><b>'+match.homeRubbers+'–'+match.awayRubbers+'</b></div><div><span>Games</span><b>'+match.homeGames+'–'+match.awayGames+'</b></div><div><span>Points</span><b>'+match.homePoints+'–'+match.awayPoints+'</b></div></div>':scored?'<div class="result-metrics"><div><span>Team points</span><b>'+match.homePoints+'–'+match.awayPoints+'</b></div><div><span>Games</span><b>Not recorded</b></div></div>':'';
  let head='<div class="result-detail-head"><span>'+esc(match.label||('Round '+match.round))+' · '+esc(roundDate(match.date))+'</span><h2>'+teamName(match.home)+' <b>'+result+'</b> '+teamName(match.away)+'</h2><p>'+outcome+(complete?'':' · '+esc(match.status))+'</p>'+metrics+'</div>';
  let rows=(match.rubbers||[]).slice().sort((a,b)=>(a.type==='Doubles'?0:1)-(b.type==='Doubles'?0:1)||String(a.position).localeCompare(String(b.position),undefined,{numeric:true})).map(r=>{const marker=emergency=>emergency?'<i class="emergency-marker" title="Emergency player recorded by TROLS">X</i>':'',home=(r.type==='Doubles'?pairNames(r.home,r.homeEmergencies||[]):resultPerson(r.home)+marker(r.homeEmergency)),away=(r.type==='Doubles'?pairNames(r.away,r.awayEmergencies||[]):resultPerson(r.away)+marker(r.awayEmergency));return'<div class="rubber-row"><small class="rubber-code" title="'+esc(r.type)+' · '+esc(r.position)+'">'+rubberCode(r)+'</small><b class="rubber-home '+(r.winner===r.home?'winner':'')+'" title="'+esc(r.home)+'">'+home+'</b><strong>'+esc(r.score)+'</strong><b class="rubber-away '+(r.winner===r.away?'winner':'')+'" title="'+esc(r.away)+'">'+away+'</b></div>'}).join('');
  return head+(rows?'<div class="rubber-list">'+rows+'</div>':'<div class="notice">TROLS has not published an individual scorecard for this match.</div>')+historicalMatchContext(match,contextPlayer)
}
function openMatch(id,sourcePlayer=null){const match=findMatch(id);if(match){selectedMatch=id;switchPage('results');$('#resultContent').innerHTML=resultDetailHTML(match,sourcePlayer);$('#resultOverlay').classList.remove('hidden');document.body.classList.add('modal-open');return}if(auxiliaryPlayer(activeProfilePlayer))openAuxiliaryMatch(auxiliaryCache.matches.find(row=>row.fixtureId===id))}
function renderFixtures(){
  const rounds=D.upcomingFixtures||[];
  $('#fixturesList').innerHTML=rounds.length?rounds.map(r=>'<section class="fixture-round"><div class="fixture-round-head"><h2>'+esc(roundHeading(r))+'</h2><div class="fixture-round-actions"><span>'+esc(roundDate(r.date))+'</span>'+(r.fixtures.some(f=>f.status==='Scheduled'&&!findFixtureResult(f,r.round))?'<button type="button" class="button secondary" data-simulate-round="'+esc(r.round)+'">Simulate round</button>':'')+'</div></div><div class="fixture-list">'+r.fixtures.map(f=>{
    if(f.status==='Bye')return byeCard(f);
    const complete=f.status==='Completed',scored=f.homePoints!=null&&f.awayPoints!=null;
    const middle=complete?f.homeRubbers+'–'+f.awayRubbers:(f.status==='Scheduled'?'v':f.status==='Wash Out'?'Washout':f.status==='Forfeited To'||f.status==='Forfeited By'?'Forfeit':f.status);
    const sub=complete?(f.homePoints+'–'+f.awayPoints+' pts · '+f.homeGames+'–'+f.awayGames+' games'):scored?(f.homePoints+'–'+f.awayPoints+' pts'):(f.status==='Scheduled'?'Scheduled':f.status);
    const result=findFixtureResult(f,r.round),predict=f.status==='Scheduled'&&!result;
    return'<button class="fixture-match '+(complete?'complete':'')+'" '+(predict?'data-predict-id':'data-fixture-result-id')+'="'+esc(f.fixtureId)+'"><span>'+teamName(f.home)+'</span><b>'+esc(middle)+'</b><span>'+teamName(f.away)+'</span><small>'+esc(sub)+' · '+(predict?'Prediction centre':'View result')+'</small></button>'
  }).join('')+'</div>'+(roundSimulations[r.round]||'')+'</section>').join(''):'<div class="notice">No official fixtures are currently published.</div>'
}

function teamRoster(team){const rows=[...(D.teamOrderEvidence?.[team]?.players||[])],known=new Set(rows.map(x=>x.player));for(const player of [...singles,...dinds])if(player.team===team&&!known.has(player.player)){rows.push({player:player.player,rating:player.rating,averagePosition:'—',emergencyOnly:false});known.add(player.player)}return rows}
function orderLineup(team,selected){const evidence=D.teamOrderEvidence?.[team]||{},edges=evidence.precedence||[],remaining=[...selected],roster=evidence.players||[];const before=(a,b)=>edges.filter(e=>e.above===a&&e.below===b).reduce((n,e)=>n+e.count,0),entry=name=>roster.find(x=>x.player===name),avg=name=>entry(name)?.averagePosition??99,emergency=name=>entry(name)?.emergencyOnly?1:0,out=[];while(remaining.length){remaining.sort((a,b)=>{const incomingA=remaining.filter(x=>x!==a).reduce((n,x)=>n+before(x,a),0),incomingB=remaining.filter(x=>x!==b).reduce((n,x)=>n+before(x,b),0);return emergency(a)-emergency(b)||incomingA-incomingB||before(b,a)-before(a,b)||avg(a)-avg(b)||a.localeCompare(b)});out.push(remaining.shift())}return out}
function isPlayoff(match){return['semi_final','grand_final'].includes(String(match.stage||'').toLowerCase())}
function defaultSide(team,needed){const roster=teamRoster(team).slice(0,needed).map(x=>x.player),order=orderLineup(team,roster);return{draft:roster,singles:order,manualOrder:false,doubles:needed===4?[[order[0],order[1]],[order[2],order[3]]]:[]}}
function predictionState(match){const needed=D.format==='rubbers'?2:4;if(!selectedPrediction||selectedPrediction.id!==match.fixtureId)selectedPrediction={id:match.fixtureId,home:defaultSide(match.home,needed),away:defaultSide(match.away,needed),simulation:null};return selectedPrediction}
function normaliseSide(team,side,needed){
  const eligible=side.draft,ordered=orderLineup(team,eligible);
  if(!side.manualOrder)side.singles=ordered.slice(0,needed);
  side.singles=[...new Set(side.singles.filter(x=>eligible.includes(x)))].slice(0,needed);
  for(const name of ordered)if(side.singles.length<needed&&!side.singles.includes(name))side.singles.push(name);
  if(needed===4){
    const used=new Set();
    side.doubles=(side.doubles||[[],[]]).slice(0,2).map(pair=>pair.filter(name=>eligible.includes(name)&&!used.has(name)).slice(0,2).map(name=>(used.add(name),name)));
    while(side.doubles.length<2)side.doubles.push([]);
    for(const pair of side.doubles)for(const name of ordered)if(pair.length<2&&!used.has(name)){pair.push(name);used.add(name)}
  }
  return side;
}
function ratingFor(name,discipline){if(!name)return null;const row=(discipline==='doubles'?dinds:singles).find(x=>x.player===name)||singles.find(x=>x.player===name);return row?.rating??1500}
function predictionRubber(label,home,away,homeRating,awayRating,{rubbersSingles=false}={}){
  const game=BRTAPrediction.gameProbability(homeRating,awayRating),greenBall=!!D.greenBall;
  const p=rubbersSingles?BRTAPrediction.rubbersSinglesWin(game):BRTAPrediction.shortSetWin(game,{greenBall});
  return{label,home,away,p,gameProbability:game,scoreDistribution:rubbersSingles?null:BRTAPrediction.shortSetDistribution(game,{greenBall})};
}
function predictionMath(homeSide,awaySide){
  const needed=D.format==='rubbers'?2:4;
  const home=homeSide.singles,away=awaySide.singles;
  if(!BRTAPrediction.lineupReady(home,away,needed))return null;
  const rubbers=[],rubbersFormat=D.format==='rubbers';
  if(rubbersFormat){
    rubbers.push(predictionRubber('Doubles',home.join(' / '),away.join(' / '),(ratingFor(home[0],'doubles')+ratingFor(home[1],'doubles'))/2,(ratingFor(away[0],'doubles')+ratingFor(away[1],'doubles'))/2));
  }else{
    for(let i=0;i<2;i++){
      const h=homeSide.doubles[i],a=awaySide.doubles[i];
      if(h.length!==2||a.length!==2)return null;
      rubbers.push(predictionRubber('Doubles '+(i+1),h.join(' / '),a.join(' / '),h.reduce((sum,name)=>sum+ratingFor(name,'doubles'),0)/2,a.reduce((sum,name)=>sum+ratingFor(name,'doubles'),0)/2));
    }
  }
  for(let i=0;i<needed;i++)rubbers.push(predictionRubber('Singles '+(i+1),home[i],away[i],ratingFor(home[i]),ratingFor(away[i]),{rubbersSingles:rubbersFormat}));
  const outcome=BRTAPrediction.teamOutcome(rubbers,{gamesDecideTies:!rubbersFormat});
  return{rubbers,...outcome};
}
function predictionHTML(match){
  const state=predictionState(match),needed=D.format==='rubbers'?2:4,playoff=isPlayoff(match);
  const home=normaliseSide(match.home,state.home,needed),away=normaliseSide(match.away,state.away,needed);
  const ready=[home,away].every(side=>side.draft.length>=needed&&BRTAPrediction.lineupReady(side.singles,side.singles,needed)),prediction=ready?predictionMath(home,away):null;
  const picker=(team,side,key)=>{
    const options=side.draft.map(name=>'<option value="'+esc(name)+'">'+esc(name)+'</option>').join('');
    const singles=Array.from({length:needed},(_,i)=>'<label><span>Singles '+(i+1)+'</span><select data-singles-side="'+key+'" data-singles-position="'+i+'">'+side.draft.map(name=>'<option value="'+esc(name)+'" '+(side.singles[i]===name?'selected':'')+'>'+esc(name)+'</option>').join('')+'</select></label>').join('');
    const doubles=D.format==='rubbers'?'':('<h4>Doubles pairs</h4><div class="pairing-grid">'+side.doubles.map((pair,i)=>'<div class="pairing-row"><span>Doubles '+(i+1)+'</span>'+[0,1].map(j=>'<select aria-label="Doubles '+(i+1)+' player '+(j+1)+'" data-doubles-side="'+key+'" data-doubles-pair="'+i+'" data-doubles-slot="'+j+'">'+side.draft.map(name=>'<option value="'+esc(name)+'" '+(pair[j]===name?'selected':'')+'>'+esc(name)+'</option>').join('')+'</select>').join('')+'</div>').join('')+'</div>');
    return'<div class="lineup-picker"><h3>'+teamName(team)+'</h3><p>Draft '+(playoff?'4–6':'exactly '+needed)+' players. Choose the four singles positions and both doubles pairs independently.</p><div class="lineup-options">'+teamRoster(team).map(row=>'<label><input type="checkbox" data-predict-side="'+key+'" data-predict-player="'+esc(row.player)+'" '+(side.draft.includes(row.player)?'checked':'')+'><span>'+esc(row.player)+(row.emergencyOnly?' <i class="emergency-marker" title="Emergency-only player">X</i>':'')+'</span><small>'+row.rating+' · average No. '+row.averagePosition+'</small></label>').join('')+'</div><button type="button" class="lineup-history-link" data-lineup-history="'+esc(team)+'">View normal lineups, results & doubles pairs</button><div class="lineup-order-head"><h4>Singles order</h4><button class="button secondary" type="button" data-auto-order="'+key+'">Use suggested order</button></div><div class="lineup-position-grid">'+singles+'</div>'+doubles+'</div>';
  };
  const summary=!prediction?'<div class="notice prediction-not-ready"><b>Draft at least '+needed+' distinct players per team.</b></div>':('<div class="prediction-summary"><div><span>'+teamName(match.home)+' win</span><b>'+Math.round(100*prediction.homeWin)+'%</b></div><div><span>'+teamName(match.away)+' win</span><b>'+Math.round(100*prediction.awayWin)+'%</b></div><div><span>Exact draw</span><b>'+Math.round(100*prediction.draw)+'%</b></div><div><span>Expected rubbers</span><b>'+prediction.expectedRubbers.toFixed(1)+'–'+(prediction.rubbers.length-prediction.expectedRubbers).toFixed(1)+'</b></div></div>');
  const rows=prediction?prediction.rubbers.map(row=>'<div class="prediction-rubber"><span>'+esc(row.label)+'</span><b class="'+(row.p>.5?'win':'')+'">'+esc(row.home)+'</b><strong>'+Math.round(100*row.p)+'%</strong><b class="'+(row.p<.5?'win':'')+'">'+esc(row.away)+'</b></div>').join(''):'';
  const formatNote=D.format==='rubbers'?'Rubbers singles uses the two-set plus match-tiebreak projection.':D.greenBall?'Green Ball is first to six games with no tiebreak; a 5–5 set ends 6–5.':'Standard Sets uses a tiebreak at 6–6.';
  const simulation=state.simulation?simulationHTML(state.simulation,match.home,match.away):'';
  return'<div class="overlay-title"><div class="kicker">FIXTURE PREDICTION</div><h2>'+teamName(match.home)+' vs '+teamName(match.away)+'</h2><p>Round '+esc(match.round||'')+' · Choose players and doubles pairings.</p></div>'+summary+'<div class="lineup-pickers">'+picker(match.home,home,'home')+picker(match.away,away,'away')+'</div><section class="prediction-section"><h3>Rubber projections</h3><p>'+formatNote+' Sets ties at 3–3 use simulated game margins.</p><div class="prediction-rubbers">'+rows+'</div></section><div class="simulation-actions"><button type="button" class="button primary" data-run-simulation '+(prediction?'':'disabled')+'>Run Simulation</button><span>Each run draws a fresh scoreline from the current player probabilities.</span></div>'+simulation;
}
function fixtureById(id){return(D.upcomingFixtures||[]).flatMap(round=>round.fixtures.map(f=>({...f,round:round.round,date:round.date}))).find(f=>f.fixtureId===id)}
function currentPredictionMatch(){return activePredictionMatch||fixtureById(selectedPrediction?.id)}
function findFixtureResult(f,round){return findMatch(f.fixtureId)||(D.results||[]).filter(r=>r.round===round).flatMap(r=>r.fixtures).find(result=>result.home===f.home&&result.away===f.away)||null}
function openTeamLineupHistory(team){
  const info=teamInsight(team),lineups=info.lineups||[],pairs=info.pairs||[];
  const lineupRows=lineups.length?lineups.map(lineup=>'<details class="lineup-history-card"><summary><b>'+lineup.players.map(esc).join(' · ')+'</b><span>'+lineup.matches+' ties · '+recordText(lineup)+'</span></summary><div class="lineup-result-list">'+lineup.rows.map(row=>'<button type="button" data-lineup-fixture="'+esc(row.fixtureId)+'"><span>R'+esc(row.round)+' · '+esc(roundDate(row.date))+'</span><b class="'+(row.result==='W'?'win':row.result==='L'?'loss':'')+'">'+esc(row.result)+' '+esc(row.score)+'</b><span>vs '+teamName(row.opponent)+'</span><small>Doubles · '+esc((row.pairs||[]).join(' · ')||'Not recorded')+'</small></button>').join('')+'</div></details>').join(''):'<div class="notice">No completed lineups have been published for this team.</div>';
  const pairRows=pairs.length?'<div class="lineup-pair-grid">'+pairs.slice(0,12).map(pair=>'<div><b>'+esc(pair.pair)+'</b><span>'+pair.matches+' ties · '+recordText(pair)+'</span></div>').join('')+'</div>':'';
  $('#lineupHistoryContent').innerHTML='<div class="overlay-title"><div class="kicker">LINEUP DEPENDENCE</div><h2>'+teamName(team)+'</h2><p>Actual scorecard lineups. Expand one to see every tie, its result and the doubles pairings used.</p></div><section class="lineup-history-section"><h3>Normal lineups</h3>'+lineupRows+'</section>'+(pairRows?'<section class="lineup-history-section"><h3>Recurring doubles pairs</h3>'+pairRows+'</section>':'');
  $('#lineupHistoryOverlay').classList.remove('hidden');document.body.classList.add('modal-open');
}
function refreshPrediction(){const match=currentPredictionMatch();if(match)$('#predictionContent').innerHTML=predictionHTML(match)}
function openPrediction(id){const match=fixtureById(id);if(!match||match.status!=='Scheduled'||findFixtureResult(match,match.round))return;activePredictionMatch=match;selectedPrediction=null;refreshPredictionFor(match);$('#predictionOverlay').classList.remove('hidden');document.body.classList.add('modal-open')}
function openPredictionHome(selectedTeam=''){
  const names=teams.map(x=>x.team).sort((a,b)=>a.localeCompare(b)),home=selectedTeam||names[0]||'',away=names.find(name=>name!==home)||'';
  $('#predictionContent').innerHTML='<div class="overlay-title"><div class="kicker">PREDICTION CENTRE</div><h2>Build a matchup</h2><p>Choose any two teams in this section, then set their real-world lineup and doubles pairs.</p></div><div class="prediction-home-fields"><label>Home team<select id="predictionHomeTeam">'+names.map(name=>'<option value="'+esc(name)+'" '+(name===home?'selected':'')+'>'+teamName(name)+'</option>').join('')+'</select></label><label>Away team<select id="predictionAwayTeam">'+names.map(name=>'<option value="'+esc(name)+'" '+(name===away?'selected':'')+'>'+teamName(name)+'</option>').join('')+'</select></label></div><button type="button" class="button primary" data-start-custom-prediction="1">Choose lineups</button>';
  $('#predictionOverlay').classList.remove('hidden');document.body.classList.add('modal-open');
}
function startCustomPrediction(){
  const home=$('#predictionHomeTeam')?.value,away=$('#predictionAwayTeam')?.value;
  if(!home||!away||home===away)return;
  activePredictionMatch={fixtureId:'custom:'+home+'|'+away,home,away,status:'Scheduled',round:'Custom matchup',date:'',stage:'custom'};
  selectedPrediction=null;refreshPrediction();
}
function refreshPredictionFor(match){$('#predictionContent').innerHTML=predictionHTML(match)}
function updatePrediction(side,player,checked){const match=currentPredictionMatch();if(!match)return;const current=selectedPrediction[side].draft,needed=D.format==='rubbers'?2:4,max=isPlayoff(match)&&needed===4?6:needed;if(checked&&current.length>=max){refreshPrediction();return}if(checked&&!current.includes(player))current.push(player);if(!checked)selectedPrediction[side].draft=current.filter(x=>x!==player);selectedPrediction.simulation=null;refreshPrediction()}
function updateSingles(side,position,player){const s=selectedPrediction[side];if(!s.draft.includes(player))return;const previous=s.singles.indexOf(player),displaced=s.singles[position];s.singles[position]=player;if(previous>=0&&previous!==position)s.singles[previous]=displaced;s.manualOrder=true;selectedPrediction.simulation=null;refreshPrediction()}
function updateDoubles(side,pair,slot,player){const s=selectedPrediction[side];if(!s.draft.includes(player))return;const other=s.doubles.findIndex(row=>row.includes(player)),otherSlot=other>=0?s.doubles[other].indexOf(player):-1,displaced=s.doubles[pair][slot];s.doubles[pair][slot]=player;if(other>=0&&(other!==pair||otherSlot!==slot))s.doubles[other][otherSlot]=displaced;selectedPrediction.simulation=null;refreshPrediction()}
function simulationHTML(sim,home,away){return'<div class="simulation-result"><h3>Simulated result · '+teamName(home)+' '+sim.homeRubbers+'–'+sim.awayRubbers+' '+teamName(away)+'</h3><p>'+sim.results.map(r=>'<span><b>'+esc(r.label)+'</b> · '+esc(r.home)+' <strong>'+esc(r.score)+'</strong> '+esc(r.away)+'</span>').join('')+'</p><div class="simulation-total">Games '+sim.homeGames+'–'+sim.awayGames+' · Sets '+sim.homeSets+'–'+sim.awaySets+' · <b>Points '+sim.homePoints+'–'+sim.awayPoints+'</b></div><small>'+(sim.winner===1?teamName(home)+' wins':sim.winner===-1?teamName(away)+' wins':'Exact draw')+' · One sampled outcome, not the official result</small></div>'}
function runPredictionSimulation(){const match=currentPredictionMatch();if(!match)return;const prediction=predictionMath(selectedPrediction.home,selectedPrediction.away);if(!prediction)return;selectedPrediction.simulation=BRTAPrediction.simulateTie(prediction.rubbers,{format:D.format,greenBall:D.greenBall});refreshPrediction()}
function simulateRound(round){const entry=(D.upcomingFixtures||[]).find(r=>String(r.round)===String(round));if(!entry)return;const upcoming=entry.fixtures.filter(f=>f.status==='Scheduled'&&!findFixtureResult(f,entry.round));if(!upcoming.length)return;roundSimulations[entry.round]='<div class="round-simulations"><div class="round-simulations-head"><div><h3>Simulated Round '+esc(round)+'</h3><p>Fresh sampled outcomes for the remaining scheduled fixtures.</p></div><button class="close-btn round-simulation-close" type="button" aria-label="Close simulated round" data-close-round-simulation="'+esc(entry.round)+'">×</button></div><div class="round-simulation-grid">'+upcoming.map(f=>{const needed=D.format==='rubbers'?2:4,home=defaultSide(f.home,needed),away=defaultSide(f.away,needed),prediction=predictionMath(home,away);return prediction?simulationHTML(BRTAPrediction.simulateTie(prediction.rubbers,{format:D.format,greenBall:D.greenBall}),f.home,f.away):'<div class="notice">Not enough players to simulate '+esc(f.home)+' vs '+esc(f.away)+'.</div>'}).join('')+'</div></div>';renderFixtures()}
function closeRoundSimulation(round){delete roundSimulations[round];renderFixtures()}

function scoreForPlayer(score,home){return home?String(score):String(score).replace(/(\d+)\s*-\s*(\d+)/g,(_,a,b)=>b+'-'+a)}
function playerMatches(name){return(D.singlesMatches||[]).filter(m=>m[2]===name||m[3]===name).map(m=>{const home=m[2]===name,opp=home?m[3]:m[2],gf=home?m[4]:m[5],ga=home?m[5]:m[4],won=m[6]===name,o=singles.find(x=>x.player===opp),perf=o?Math.round(o.rating+450*Math.log((gf+.5)/(ga+.5))):null;return{round:m[0],date:m[1],opp,gf,ga,won,score:scoreForPlayer(m[7],home),fixtureId:m[8],oppRating:o?.rating,performance:perf}}).sort((a,b)=>a.round-b.round)}
function partnerStats(name){return pairs.filter(x=>x.player.split(' / ').includes(name)).map(x=>({...x,partner:x.player.split(' / ').find(p=>p!==name)})).sort((a,b)=>b.matches-a.matches||b.rating-a.rating)}
function confidence(s){if(!s)return['No singles data','conf-low'];if(s.matches<4)return['Limited','conf-low'];if(s.matches>=8&&s.se<130)return['High','conf-high'];if(s.matches>=6&&s.se<155)return['Established','conf-high'];return['Moderate','conf-mid']}
function stat(a,b,c){return'<div class="stat-card"><span>'+a+'</span><b>'+(b??'—')+'</b><small>'+c+'</small></div>'}function mini(a,b){return'<div><span>'+a+'</span><b>'+b+'</b></div>'}function radar(label,x){return'<div><span>'+label+'</span>'+(x?'<b><em class="radar-result '+(x.won?'win':'loss')+'">'+(x.won?'W':'L')+'</em> <span class="radar-opponent">'+esc(x.opp)+'</span></b><strong class="radar-score">'+esc(x.score)+'</strong><small>Opponent '+(x.oppRating??'—')+'</small>':'<b>None yet</b>')+'</div>'}
function historyChart(name,throughRound=null){const all=D.ratingHistory?.players?.[name]||[],history=throughRound==null?all:all.filter(x=>Number(x[0])<=Number(throughRound));if(history.length<2)return'<p class="small-note">A history line appears after this player has results in two rounds.</p>';const values=history.map(x=>x[1]),lo=Math.min(...values)-30,hi=Math.max(...values)+30,coordinates=history.map((x,index)=>({px:100*(index+.5)/history.length,py:92-(x[1]-lo)*84/(hi-lo||1)})),points=coordinates.map(x=>x.px.toFixed(1)+','+x.py.toFixed(1)).join(' '),markers=coordinates.map(x=>'<circle cx="'+x.px.toFixed(1)+'" cy="'+x.py.toFixed(1)+'" r="1.8"/>').join('');return'<div class="history-chart"><svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Power history"><polyline points="'+points+'"/>'+markers+'</svg><div class="history-chart-labels" style="grid-template-columns:repeat('+history.length+',minmax(0,1fr))">'+history.map(x=>'<span>R'+x[0]+'<b>'+x[1]+'</b></span>').join('')+'</div></div>'}
function historicalSnapshot(name,round){const values=D.ratingHistory?.players?.[name]||[];return [...values].reverse().find(x=>Number(x[0])<=Number(round))||null}
function historicalRoundDate(round){return D.ratingHistory?.rounds?.find(x=>Number(x.round)===Number(round))?.date||''}
function historicalRows(round){const rows=[];for(const [player,values] of Object.entries(D.ratingHistory?.players||{})){const eligible=values.filter(x=>Number(x[0])<=Number(round));if(!eligible.length)continue;const snap=eligible[eligible.length-1],previous=eligible.length>1?eligible[eligible.length-2]:null,current=singles.find(x=>x.player===player);rows.push({player,team:snap[4]||current?.team||'',rating:snap[1],se:snap[2],matches:snap[3],change:previous?snap[1]-previous[1]:null})}rows.sort((a,b)=>b.rating-a.rating||a.player.localeCompare(b.player));let rank=0;for(const row of rows)row.rank=row.matches>=4?++rank:null;return rows}
function historicalMatchContext(match,sourcePlayer){if(!sourcePlayer||match.status!=='Completed'||!D.ratingHistory?.players)return'';const appears=(match.rubbers||[]).some(r=>r.type==='Singles'&&(r.home===sourcePlayer||r.away===sourcePlayer));if(!appears||!historicalSnapshot(sourcePlayer,match.round))return'';return'<details class="historical-context"><summary>Model context</summary><button class="button secondary" type="button" data-history-player="'+esc(sourcePlayer)+'" data-history-round="'+match.round+'">'+esc(sourcePlayer)+' · Round '+match.round+'</button></details>'}
function openHistoricalTable(round){const rows=historicalRows(round),date=historicalRoundDate(round);$('#roundContent').innerHTML='<div class="overlay-title"><div class="kicker">ROUND '+round+' RATINGS</div><h2>After Round '+round+'</h2><p>'+esc(date)+' · '+esc(D.meta.section_label)+'</p></div><div class="table-wrap"><table><thead><tr><th>#</th><th>Player</th><th>Team</th><th>Power</th><th>Movement</th><th>Matches</th><th>Uncertainty</th></tr></thead><tbody>'+rows.map(row=>'<tr class="'+(row.rank?'':'provisional')+'"><td>'+(row.rank??'—')+'</td><td><button class="person" data-history-player="'+esc(row.player)+'" data-history-round="'+round+'">'+esc(row.player)+'</button></td><td>'+teamName(row.team)+'</td><td><b>'+row.rating+'</b></td><td>'+(row.change==null?'—':(row.change>=0?'+':'')+row.change)+'</td><td>'+row.matches+'</td><td>±'+row.se+'</td></tr>').join('')+'</tbody></table></div>';$('#roundOverlay').classList.remove('hidden');document.body.classList.add('modal-open')}
function profileRank(name){const ranked=singles.filter(row=>row.matches>=4).sort((a,b)=>b.rating-a.rating||a.player.localeCompare(b.player));const index=ranked.findIndex(row=>row.player===name);return index<0?null:index+1}
function profileRun(matches){if(!matches.length)return null;const latest=matches[matches.length-1],same=[...matches].reverse().findIndex(match=>match.won!==latest.won);return{won:latest.won,length:same<0?matches.length:same}}
function profileLongestRun(matches,won){let best=0,current=0;for(const match of matches){current=match.won===won?current+1:0;best=Math.max(best,current)}return best}
function profileMetric(label,value,detail='',tone=''){return'<div class="lab-metric '+tone+'"><span>'+esc(label)+'</span><b>'+esc(value??'—')+'</b>'+(detail?'<small>'+detail+'</small>':'')+'</div>'}
function profileHighlight(label,match,detail=''){if(!match)return'';return'<button class="lab-highlight" type="button" data-match-id="'+esc(match.fixtureId)+'"><span>'+esc(label)+'</span><b><em class="radar-result '+(match.won?'win':'loss')+'">'+(match.won?'W':'L')+'</em> '+esc(match.score)+' · '+esc(match.opp)+'</b><small>'+esc(detail)+'</small></button>'}
function profileSplit(matches,condition){const rows=matches.filter(condition),wins=rows.filter(match=>match.won).length;return rows.length?wins+'–'+(rows.length-wins):'—'}
function profileSchedule(schedule,rows=D.strengthOfSchedule||[]){return schedule?'<button class="schedule-card lab-schedule-card" type="button" data-sos-open title="Open the full strength-of-schedule table"><span>Strength of schedule</span><b>'+scheduleBand(schedule.averageOpponent,rows)+'</b><small>#'+schedule.rank+' hardest of '+schedule.total+' · '+schedule.matches+' matches · View table</small></button>':profileMetric('Schedule','—','No completed opponents')}
function playerInsight(name){return D.playerInsights?.[name]||null}
function rivalryMatchesHTML(rival){
  return'<div class="rivalry-match-list">'+(rival.rows||[]).map(row=>'<button type="button" class="rivalry-match" data-rival-fixture="'+esc(row.fixtureId)+'"><span class="rivalry-when"><b>R'+esc(row.round)+'</b><small>'+esc(row.date||'Recorded match')+'</small></span><strong class="rivalry-score '+(row.result==='W'?'win':'loss')+'">'+esc(row.result)+' '+esc(row.score||'Score unavailable')+'</strong><span class="rivalry-facts"><b>No. '+esc(row.position??'—')+'</b><small>Expected '+(row.expectedWinProbability==null?'—':Math.round(100*row.expectedWinProbability)+'%')+' · '+signed(row.performanceDelta,0)+'</small></span><span class="rivalry-powers">'+esc(row.ratingAtTime??'—')+' <i>v</i> '+esc(row.opponentRatingAtTime??'—')+'</span></button>').join('')+'</div>';
}
function rivalryListHTML(insight){
  const rivalries=insight?.rivalries||[];
  return rivalries.length?'<div class="rivalry-list">'+rivalries.map(rival=>'<details class="rivalry-card"><summary><span class="rivalry-opponent"><small>Opponent</small><b>'+esc(rival.opponent)+'</b></span><span class="rivalry-record"><small>Head-to-head</small><b>'+esc(rival.record)+'</b></span><span class="rivalry-count">'+esc(rival.matches)+' meeting'+(rival.matches===1?'':'s')+'</span></summary><div class="rivalry-card-meta"><span>'+esc(rival.gamesFor)+'–'+esc(rival.gamesAgainst)+' games</span><span>'+signed(rival.winsAboveExpected,2)+' vs expected</span></div>'+rivalryMatchesHTML(rival)+'</details>').join('')+'</div>':'<p class="small-note">No recorded singles rivalries yet.</p>';
}
function openRivalries(name,insight,throughRound=0){
  $('#rivalryContent').innerHTML='<div class="overlay-title"><div class="kicker">RIVALRIES</div><h2>'+esc(name)+'</h2>'+(throughRound?'<p>Singles meetings through Round '+throughRound+'.</p>':'')+'</div>'+rivalryListHTML(insight);
  $('#rivalryOverlay').classList.remove('hidden');document.body.classList.add('modal-open');
}
function roleSection(insight,name,throughRound=0){
  if(!insight)return'';
  const positions=insight.positions||[],availability=insight.availabilityPercent==null?'—':insight.availabilityPercent+'%',rivalries=(insight.rivalries||[]).length;
  return'<section class="profile-section lab-section team-role-section"><div class="lab-section-head"><div><h3>Team role & availability</h3></div></div><div class="team-role-metrics">'+profileMetric('Rounds played',insight.roundsPlayed,(insight.teamCompletedTies||0)+' completed team ties')+profileMetric('Availability',availability,insight.availabilityPercent==null?'No team-tie denominator':'of completed team ties')+profileMetric('Average listed position',insight.averageListedPosition==null?'—':'No. '+insight.averageListedPosition,insight.emergencyAppearances?insight.emergencyAppearances+' emergency appearance'+(insight.emergencyAppearances===1?'':'s'):'No emergency appearances')+'</div><div class="team-role-actions">'+profileMetric('Positions used',positions.length||'—',positions.length?positions.map(row=>'No. '+row.position).join(' · '):'No listed singles position')+(rivalries?'<button type="button" class="role-rivalry-button" data-open-rivalries="'+esc(name)+'" data-rivalry-round="'+(throughRound||'')+'"><span>Full rivalry history</span><b>'+rivalries+' opponent'+(rivalries===1?'':'s')+'</b><small>Head-to-head results and match detail</small></button>':'')+'</div>'+(positions.length?'<div class="role-table-spacer"></div><div class="table-wrap role-table"><table><thead><tr><th>Position</th><th>Record</th><th>Games</th><th>Game share</th><th>Expected wins</th></tr></thead><tbody>'+positions.map(row=>'<tr><td><b>No. '+row.position+'</b> · '+row.matches+' match'+(row.matches===1?'':'es')+'</td><td>'+row.record+'</td><td>'+row.gamesFor+'–'+row.gamesAgainst+'</td><td>'+row.gameShare+'%</td><td>'+row.expectedWins+'</td></tr>').join('')+'</tbody></table></div>':'')+'</section>';
}
function performanceSection(insight){
  if(!insight)return'';
  const c=insight.consistency||{},s=insight.scoreProfile||{},score=c.score==null?'—':c.score+'/100',volatility=c.volatility==null?'—':'±'+c.volatility;
  return'<section class="profile-section lab-section performance-profile-section"><div class="lab-section-head"><div><h3>Consistency & score profile</h3><p>Match-to-match performance against pre-match Power.</p></div></div><div class="lab-insight-grid">'+profileMetric('Consistency score',score,c.matches>=2?'Higher is steadier':'Needs two scored matches')+profileMetric('Performance volatility',volatility,c.matches>=2?'standard deviation of performance deltas':'Needs two scored matches')+profileMetric('Average performance delta',c.averagePerformanceDelta==null?'—':signed(c.averagePerformanceDelta,1),c.matches?'vs pre-match Power':'')+profileMetric('Straight-set matches',s.straightSetMatches??'—',(s.scoredMatches||0)+' recorded singles scores')+'</div><div class="score-profile-row">'+profileMetric('Sets',((s.setsWon??0)+'–'+(s.setsLost??0)),'won–lost')+profileMetric('Tiebreaks',((s.tiebreaksWon??0)+'–'+(s.tiebreaksLost??0)),'won–lost')+profileMetric('Deciding matches',((s.decidingWins??0)+'–'+(s.decidingLosses??0)),'won–lost')+'</div><p class="small-note">Doubles appear before singles throughout the site.</p></section>';
}
function matchExplorerSection(matches,rating,historical=false){
  return'<section class="profile-section lab-section profile-inline-explorer"><div class="lab-section-head"><div><h3>Match explorer</h3></div><span>'+matches.length+' matches</span></div><div class="match-list lab-match-list">'+(matches.length?matches.map(match=>'<button class="match-row" data-match-id="'+esc(match.fixtureId)+'"><span class="match-round">R'+match.round+'</span><b class="match-score '+(match.won?'win':'loss')+'">'+(match.won?'W':'L')+' '+esc(match.score)+'</b><span class="match-opponent">'+esc(match.opp)+'<small>Power '+(match.oppRating??'—')+(historical?' at the time':'')+'</small></span><span class="match-meta '+(match.performance!=null&&rating?(match.performance>=rating?'performance-above':'performance-below'):'')+'">'+(match.performance!=null?'Performance '+match.performance:'No comparison')+'</span></button>').join(''):'<p>No completed singles rubbers recorded.</p>')+'</div></section>';
}
function renderProfileMatchExplorer(matches,rating,historical=false){
  const host=$('#profileMatchExplorer'),content=$('#profileMatchExplorerContent');if(!host||!content)return;
  content.innerHTML='<div class="floating-explorer-head"><div class="kicker">MATCH EXPLORER</div><h3>'+matches.length+' recorded singles match'+(matches.length===1?'':'es')+'</h3></div>'+matchExplorerSection(matches,rating,historical).replace('profile-inline-explorer','profile-floating-explorer');
  host.classList.remove('hidden');
}
function doublesSection(d,partners,o){
  if(!d)return'<p>No doubles evidence recorded.</p>';
  const cards=partners.length?partners.map(partner=>{const effect=partner.pairEffect??0,synergy=partner.pairSynergy??0;return'<article class="partner-card"><b>'+personButton(partner.partner)+'</b><span>'+partner.wins+'–'+partner.losses+' · '+partner.matches+' ties</span><small>Pair Power '+partner.rating+' · effect '+(effect>=0?'+':'')+effect+' · synergy '+(synergy>=0?'+':'')+synergy+'</small></article>'}).join(''):'<p>No repeated partnerships yet.</p>';
  return'<div class="lab-doubles-summary">'+profileMetric('Individual Power',d.rating,d.ranking_status||'')+profileMetric('Appearances',d.matches,d.partner_count+' partners')+(o?profileMetric('Overall Power',o.rating,'50/50 singles + doubles'):'')+'</div><p class="small-note">Pair effect compares pair Power with the two players’ individual-doubles average. Synergy is the separately fitted, strongly regularised pair residual.</p><div class="partner-list">'+cards+'</div>';
}
function auxiliaryMatchupResult(context,opponent){
  const rating=context.row.rating,other=context.matches.find(match=>match.opp===opponent)?.oppRating;
  if(other==null)return'<p class="small-note">A rating is not available for this comparison.</p>';
  const probability=1/(1+Math.exp(-(rating-other)/450)),matches=context.matches.filter(match=>match.opp===opponent),gf=matches.reduce((sum,match)=>sum+match.gf,0),ga=matches.reduce((sum,match)=>sum+match.ga,0);
  return'<div class="lab-matchup-result"><div class="lab-matchup-projection"><span>Projected win chance</span><b>'+Math.round(100*probability)+'%</b><small>'+esc(context.row.player)+' · '+rating+' Power</small></div><div class="lab-matchup-stats"><div><span>Power gap</span><b>'+(rating>other?'+':'')+(rating-other)+'</b></div><div><span>Past meetings</span><b>'+(matches.length?matches.length+'–0':'—')+'</b></div><div><span>Games</span><b>'+(matches.length?gf+'–'+ga:'—')+'</b></div></div><p class="explain">Projection uses the same Power relationship as the Player Lab; past meetings are this player’s completed Royal Matches.</p></div>';
}
function auxiliaryMatchupSection(context){
  const opponents=[...new Map(context.matches.map(match=>[match.opp,match.oppRating])).entries()].map(([player,rating])=>({player,rating})).sort((a,b)=>a.player.localeCompare(b.player));
  if(!opponents.length)return'<div class="lab-matchup"><p>No completed opponents are available in this section.</p></div>';
  const selected=opponents[0].player;
  return'<div class="lab-matchup"><label class="lab-matchup-label">Compare with<select data-aux-profile-opponent>'+opponents.map(row=>'<option value="'+esc(row.player)+'"'+(row.player===selected?' selected':'')+'>'+esc(row.player)+' · '+row.rating+'</option>').join('')+'</select></label><div data-aux-profile-matchup-result>'+auxiliaryMatchupResult(context,selected)+'</div></div>';
}
function auxiliaryHistoryChart(history){
  if(history.length<2)return'<p class="small-note">A history line appears after results in two rounds.</p>';
  const values=history.map(row=>row[1]),lo=Math.min(...values)-30,hi=Math.max(...values)+30,coordinates=history.map((row,index)=>({px:100*(index+.5)/history.length,py:92-(row[1]-lo)*84/(hi-lo||1)})),points=coordinates.map(point=>point.px.toFixed(1)+','+point.py.toFixed(1)).join(' '),markers=coordinates.map(point=>'<circle cx="'+point.px.toFixed(1)+'" cy="'+point.py.toFixed(1)+'" r="1.8"/>').join('');
  return'<div class="history-chart"><svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="Power history"><polyline points="'+points+'"/>'+markers+'</svg><div class="history-chart-labels" style="grid-template-columns:repeat('+history.length+',minmax(0,1fr))">'+history.map(row=>'<span>R'+row[0]+'<b>'+row[1]+'</b></span>').join('')+'</div></div>';
}
function openAuxiliaryProfile(context){
  activeProfilePlayer=context.row.player;
  const s=context.row,matches=context.matches,insight=context.insight,last=matches.slice(-3),recentGf=last.reduce((sum,match)=>sum+match.gf,0),recentGa=last.reduce((sum,match)=>sum+match.ga,0),gameShare=s.gf+s.ga?100*s.gf/(s.gf+s.ga):null,firstPower=context.history[0]?.[1],powerChange=firstPower==null?null:s.rating-firstPower,run=profileRun(matches),longestWin=profileLongestRun(matches,true),averageMargin=matches.length?matches.reduce((sum,match)=>sum+match.gf-match.ga,0)/matches.length:null,bestPerformance=[...matches].sort((a,b)=>b.performance-a.performance)[0],bestWin=[...matches].sort((a,b)=>b.oppRating-a.oppRating)[0],toughestMatch=[...matches].sort((a,b)=>(a.gf-a.ga)-(b.gf-b.ga)||b.oppRating-a.oppRating)[0],expected=matches.reduce((sum,match)=>sum+match.expectedWinProbability,0),recentText=last.length?last.length+'–0':'—',higherRecord=profileSplit(matches,match=>match.oppRating>s.rating),closest=matches.filter(match=>Math.abs(match.gf-match.ga)<=2).length;
  let html='<div class="profile-head lab-head"><div><div class="kicker">PLAYER LAB · RANKED</div><h2>'+esc(s.player)+'</h2><p>'+teamName(s.team)+'</p></div><span class="confidence conf-high"><b>High evidence</b><small>'+s.matches+' singles matches · ±'+s.se+'</small></span></div>';
  html+='<section class="lab-hero"><div class="lab-power"><span>Singles Power</span><strong>'+s.rating+'</strong><small>#0 in '+esc(context.sectionLabel)+'</small></div><div class="lab-hero-grid">'+profileMetric('Record',s.wins+'–0',s.matches+' completed singles')+profileMetric('Game share',gameShare==null?'—':Math.round(gameShare)+'%',s.gf+'–'+s.ga+' games')+profileMetric('Power trend',powerChange==null?'—':(powerChange>=0?'+':'')+powerChange,firstPower!=null?'since first result':'')+profileMetric('Current run',run?'W'+run.length:'—',longestWin?'best win streak '+longestWin:'')+'</div></section>';
  html+='<section class="profile-section lab-section"><div class="lab-section-head"><div><h3>Match insight</h3></div></div><div class="lab-insight-grid">'+profileMetric('Actual wins',matches.length,'Expected '+expected.toFixed(2)+' wins')+profileMetric('Wins vs expected',signed(matches.length-expected,2)+' wins','Game evidence against fixed opponents')+profileSchedule(context.schedule,context.sos)+profileMetric('vs higher-rated',higherRecord,'using current Power as the line')+'</div>'+auxiliaryMatchupSection(context)+'</section>'+roleSection(insight,s.player)+matchExplorerSection(matches,s.rating);
  html+='<div class="lab-layout"><div class="lab-main"><section class="profile-section lab-section"><div class="lab-section-head"><div><h3>Momentum</h3></div><span>'+recentText+' last '+last.length+'</span></div>'+auxiliaryHistoryChart(context.history)+'<div class="lab-momentum-grid">'+profileMetric('Last three games',last.length?recentGf+'–'+recentGa:'—',last.length?Math.round(100*recentGf/(recentGf+recentGa))+'% game share':'')+profileMetric('Average margin',averageMargin==null?'—':(averageMargin>=0?'+':'')+averageMargin.toFixed(1),matches.length?'games per match':'')+profileMetric('Close matches',matches.length?closest+'/'+matches.length:'—',matches.length?'within two games':'')+'</div></section>'+performanceSection(insight)+'</div><aside class="lab-side"><section class="profile-section lab-section"><div class="lab-section-head"><div><h3>Headline results</h3></div></div><div class="lab-highlights">'+profileHighlight('Best-rated win',bestWin,bestWin?'Opponent Power '+bestWin.oppRating:'')+profileHighlight('Top performance',bestPerformance,bestPerformance?'Performance '+bestPerformance.performance:'')+profileHighlight('Toughest match',toughestMatch,toughestMatch?'Opponent Power '+toughestMatch.oppRating:'')+'</div></section><section class="profile-section lab-section lab-doubles"><div class="lab-section-head"><div><h3>Doubles</h3></div></div><p>No doubles evidence recorded.</p></section></aside></div>';
  html+='<section class="profile-section lab-section"><div class="lab-section-head"><div><h3>Season notes</h3></div></div><div class="lab-context-actions"><button class="button secondary" type="button" data-aux-backstory>See Backstory</button></div></section>';
  $('#profileContent').innerHTML=html;renderProfileMatchExplorer(matches,s.rating);$('#profileOverlay').classList.remove('hidden');document.body.classList.add('modal-open');
}
function openAuxiliaryMatch(match){
  if(!match)return;
  $('#resultContent').innerHTML='<div class="result-detail-head"><span>Royal Match · '+esc(match.date||'Date not published')+'</span><h2>'+esc(window.AuxiliaryModule.CANONICAL)+' <b>'+esc(match.score)+'</b> '+esc(match.opp)+'</h2><p>Completed best-of-three result</p></div><div class="rubber-list"><div class="rubber-row"><small class="rubber-code" title="Singles 1">S1</small><b class="rubber-home winner">'+esc(window.AuxiliaryModule.CANONICAL)+'</b><strong>'+esc(match.score)+'</strong><b class="rubber-away">'+esc(match.opp)+'</b></div></div>';
  $('#resultOverlay').classList.remove('hidden');document.body.classList.add('modal-open');
}
function openAuxiliaryBackstory(context){
  const s=context.row;
  $('#roundContent').innerHTML='<div class="overlay-title"><div class="kicker">BACKSTORY</div><h2>'+esc(s.player)+'</h2><p>'+esc(context.sectionLabel)+' · '+esc(D.meta.season_label||'Current season')+'</p></div><p>Across '+s.matches+' completed singles matches, '+esc(s.player)+' has stayed unbeaten while conceding '+s.ga+' games. The schedule has drawn '+context.rivalries.length+' opponents from this section; the rest of the ratings have continued their day entirely normally.</p><div class="lab-context-actions"><button class="auxiliary-archive-button" type="button" data-aux-open-archive>Open Royal Archive</button></div>';
  $('#roundOverlay').classList.remove('hidden');document.body.classList.add('modal-open');
}
function openProfile(name){
  if(auxiliaryPlayer(name)){openAuxiliaryProfile(auxiliaryCache);return}
  activeProfilePlayer=name;
  const s=singles.find(row=>row.player===name),d=dinds.find(row=>row.player===name),o=overallData().find(row=>row.player===name),expectation=(D.resultsExpectation?.players||[]).find(row=>row.player===name),matches=playerMatches(name),partners=partnerStats(name),schedule=(D.strengthOfSchedule||[]).find(row=>row.player===name),rank=profileRank(name),cf=confidence(s),history=D.ratingHistory?.players?.[name]||[],insight=playerInsight(name),firstPower=history[0]?.[1],powerChange=s&&firstPower!=null?s.rating-firstPower:null,last=matches.slice(-3),recentWins=last.filter(match=>match.won).length,recentGf=last.reduce((total,match)=>total+match.gf,0),recentGa=last.reduce((total,match)=>total+match.ga,0),gameShare=s&&s.gf+s.ga?100*s.gf/(s.gf+s.ga):null,averageMargin=matches.length?matches.reduce((total,match)=>total+match.gf-match.ga,0)/matches.length:null,run=profileRun(matches),higherRecord=s?profileSplit(matches,match=>(match.oppRating??-Infinity)>s.rating):'—',bestPerformance=[...matches].filter(match=>match.performance!=null).sort((a,b)=>b.performance-a.performance)[0],bestWin=[...matches].filter(match=>match.won&&match.oppRating!=null).sort((a,b)=>b.oppRating-a.oppRating)[0],toughestLoss=[...matches].filter(match=>!match.won&&match.oppRating!=null).sort((a,b)=>b.oppRating-a.oppRating)[0],longestWin=profileLongestRun(matches,true),closest=matches.filter(match=>Math.abs(match.gf-match.ga)<=2).length;
  const titleTeam=s?.team||d?.team||'',record=s?s.wins+'–'+s.losses:'—',qualifier=s?.matches>=4?'Ranked':'Provisional',recentText=last.length?recentWins+'–'+(last.length-recentWins):'—';
  let html='<div class="profile-head lab-head"><div><div class="kicker">PLAYER LAB · '+esc(qualifier)+'</div><h2>'+esc(name)+'</h2><p>'+teamName(titleTeam)+'</p></div><span class="confidence '+cf[1]+'"><b>'+cf[0]+' evidence</b><small>'+esc(s?s.matches+' singles matches · ±'+s.se:'No singles record')+'</small></span></div>';
  html+='<section class="lab-hero"><div class="lab-power"><span>Singles Power</span><strong>'+esc(s?.rating??'—')+'</strong><small>'+(rank?'#'+rank+' in '+esc(D.meta.section_label):'Needs 4 singles matches to rank')+'</small></div><div class="lab-hero-grid">'+profileMetric('Record',record,s?s.matches+' completed singles':'No results')+profileMetric('Game share',gameShare==null?'—':Math.round(gameShare)+'%',s?s.gf+'–'+s.ga+' games':'')+profileMetric('Power trend',powerChange==null?'—':(powerChange>=0?'+':'')+powerChange,firstPower!=null?'since first result':'')+profileMetric('Current run',run?(run.won?'W':'L')+run.length:'—',longestWin?'best win streak '+longestWin:'')+'</div></section>';
  html+='<section class="profile-section lab-section"><div class="lab-section-head"><div><h3>Match insight</h3></div></div><div class="lab-insight-grid">'+profileMetric('Actual wins',expectation?.actualWins??'—',expectation?'Expected '+expectation.expectedWins.toFixed(2)+' wins':'No expectation data')+profileMetric('Wins vs expected',expectation?signed(expectation.winsAboveExpected,2)+' wins':'—',expectation?'Game share '+signed(expectation.gameShareAboveExpected,1)+'% vs expected':'')+profileSchedule(schedule)+profileMetric('vs higher-rated',higherRecord,s?'using current Power as the line':'')+'</div>'+profileMatchupSection(name,matches)+'</section>'+roleSection(insight,name)+matchExplorerSection(matches,s?.rating);
  html+='<div class="lab-layout"><div class="lab-main"><section class="profile-section lab-section"><div class="lab-section-head"><div><h3>Momentum</h3></div><span>'+recentText+' last '+last.length+'</span></div>'+historyChart(name)+'<div class="lab-momentum-grid">'+profileMetric('Last three games',last.length?recentGf+'–'+recentGa:'—',last.length?Math.round(100*recentGf/(recentGf+recentGa))+'% game share':'')+profileMetric('Average margin',averageMargin==null?'—':(averageMargin>=0?'+':'')+averageMargin.toFixed(1),matches.length?'games per match':'')+profileMetric('Close matches',matches.length?closest+'/'+matches.length:'—',matches.length?'within two games':'')+'</div></section>'+performanceSection(insight)+'</div><aside class="lab-side"><section class="profile-section lab-section"><div class="lab-section-head"><div><h3>Headline results</h3></div></div><div class="lab-highlights">'+profileHighlight('Best-rated win',bestWin,bestWin?'Opponent Power '+bestWin.oppRating:'')+profileHighlight('Top performance',bestPerformance,bestPerformance?'Performance '+bestPerformance.performance:'')+profileHighlight('Toughest loss',toughestLoss,toughestLoss?'Opponent Power '+toughestLoss.oppRating:'')+(bestWin||bestPerformance||toughestLoss?'':'<p class="small-note">No comparable singles performances yet.</p>')+'</div></section><section class="profile-section lab-section lab-doubles"><div class="lab-section-head"><div><h3>Doubles</h3><p>Partner-adjusted evidence, including the fitted pair residual.</p></div></div>'+doublesSection(d,partners,o)+'</section></aside></div>';$('#profileContent').innerHTML=html;renderProfileMatchExplorer(matches,s?.rating);
  $('#profileOverlay').classList.remove('hidden');document.body.classList.add('modal-open');
}
function historicalPlayerMatches(name,throughRound){return playerMatches(name).filter(match=>Number(match.round)<=Number(throughRound)).map(match=>{const snapshot=historicalSnapshot(match.opp,match.round),oppRating=snapshot?.[1]??match.oppRating,performance=oppRating==null?null:Math.round(oppRating+450*Math.log((match.gf+.5)/(match.ga+.5)));return{...match,oppRating,performance}})}
function historicalScoreProfile(rows){
  const out={straightSetMatches:0,scoredMatches:0,setsWon:0,setsLost:0,tiebreaksWon:0,tiebreaksLost:0,decidingWins:0,decidingLosses:0};
  for(const row of rows){const components=scoreComponents(row.score),sets=components.sets;if(!sets.length)continue;out.scoredMatches++;let won=0,lost=0;for(const [a,b] of sets){if(a>b)won++;else if(b>a)lost++;if((a===7&&b===6)||(a===6&&b===7)){if(a>b)out.tiebreaksWon++;else out.tiebreaksLost++;}}if(components.matchTiebreak){if(row.result==='W')out.tiebreaksWon++;else if(row.result==='L')out.tiebreaksLost++;if(won===lost){if(row.result==='W')won++;else if(row.result==='L')lost++;}}out.setsWon+=won;out.setsLost+=lost;if((won===2&&lost===0)||(lost===2&&won===0))out.straightSetMatches++;if(won&&lost){if(won>lost)out.decidingWins++;else if(lost>won)out.decidingLosses++;}}
  return out;
}
function scoreComponents(score){
  const rows=[...String(score||'').matchAll(/(\[)?(\d+)\s*[-–]\s*(\d+)(\])?/g)],sets=[],matchTiebreak=[];
  for(const row of rows){const value=[Number(row[2]),Number(row[3])];if(row[1]||row[4])matchTiebreak.push(value);else sets.push(value)}
  return{sets,matchTiebreak:matchTiebreak[0]||null};
}
function historicalInsight(name,throughRound){
  const base=playerInsight(name);if(!base)return null;
  const rows=(base.rivalries||[]).flatMap(rival=>(rival.rows||[]).map(row=>({...row,opponent:rival.opponent}))).filter(row=>Number(row.round)<=Number(throughRound));
  if(!rows.length)return null;
  const positions=new Map(),rivals=new Map(),deltas=rows.map(row=>Number(row.performanceDelta)).filter(Number.isFinite);
  for(const row of rows){
    const games=scoreComponents(row.score).sets;
    const pos=Number(row.position);if(Number.isFinite(pos)){const item=positions.get(pos)||{position:pos,matches:0,wins:0,gamesFor:0,gamesAgainst:0,expected:0};item.matches++;if(row.result==='W')item.wins++;item.expected+=Number(row.expectedWinProbability)||0;for(const score of games){item.gamesFor+=score[0];item.gamesAgainst+=score[1];}positions.set(pos,item)}
    const rival=rivals.get(row.opponent)||{opponent:row.opponent,rows:[],wins:0,losses:0,gamesFor:0,gamesAgainst:0,expected:0};rival.rows.push(row);if(row.result==='W')rival.wins++;else rival.losses++;rival.expected+=Number(row.expectedWinProbability)||0;for(const score of games){rival.gamesFor+=score[0];rival.gamesAgainst+=score[1];}rivals.set(row.opponent,rival);
  }
  const mean=deltas.length?deltas.reduce((sum,value)=>sum+value,0)/deltas.length:null,volatility=deltas.length>1?Math.sqrt(deltas.reduce((sum,value)=>sum+(value-mean)**2,0)/deltas.length):null;
  return{team:base.team,roundsPlayed:new Set(rows.map(row=>row.fixtureId||row.round+'|'+row.opponent)).size,teamCompletedTies:throughRound,availabilityPercent:throughRound?Math.round(100*new Set(rows.map(row=>row.round)).size/throughRound):null,averageListedPosition:positions.size?(rows.reduce((sum,row)=>sum+(Number(row.position)||0),0)/rows.filter(row=>Number.isFinite(Number(row.position))).length).toFixed(1):null,emergencyAppearances:0,positions:[...positions.values()].sort((a,b)=>a.position-b.position).map(item=>({...item,record:item.wins+'–'+(item.matches-item.wins),gameShare:item.gamesFor+item.gamesAgainst?Math.round(100*item.gamesFor/(item.gamesFor+item.gamesAgainst)):0,expectedWins:item.expected.toFixed(1)})),rivalries:[...rivals.values()].map(item=>({...item,record:item.wins+'–'+item.losses,matches:item.rows.length,winsAboveExpected:item.wins-item.expected})).sort((a,b)=>b.matches-a.matches||a.opponent.localeCompare(b.opponent)),consistency:{matches:deltas.length,averagePerformanceDelta:mean==null?null:Number(mean.toFixed(1)),volatility:volatility==null?null:Number(volatility.toFixed(1)),score:volatility==null?null:Math.max(0,Math.round(100-volatility*4))},scoreProfile:historicalScoreProfile(rows)};
}
function openHistoricalProfile(name,round){
  const snap=historicalSnapshot(name,round);if(!snap)return;
  activeProfilePlayer=name;
  const actualRound=Number(snap[0]),current=singles.find(row=>row.player===name),matches=historicalPlayerMatches(name,actualRound),insight=historicalInsight(name,actualRound),wins=matches.filter(match=>match.won).length,gf=matches.reduce((total,match)=>total+match.gf,0),ga=matches.reduce((total,match)=>total+match.ga,0),rows=historicalRows(actualRound),row=rows.find(item=>item.player===name),values=(D.ratingHistory?.players?.[name]||[]).filter(value=>Number(value[0])<=actualRound),previous=values.length>1?values[values.length-2]:null,change=previous?snap[1]-previous[1]:null,firstPower=values[0]?.[1],seasonChange=firstPower==null?null:snap[1]-firstPower,last=matches.slice(-3),recentWins=last.filter(match=>match.won).length,recentGf=last.reduce((total,match)=>total+match.gf,0),recentGa=last.reduce((total,match)=>total+match.ga,0),averageMargin=matches.length?matches.reduce((total,match)=>total+match.gf-match.ga,0)/matches.length:null,bestPerformance=[...matches].filter(match=>match.performance!=null).sort((a,b)=>b.performance-a.performance)[0],bestWin=[...matches].filter(match=>match.won&&match.oppRating!=null).sort((a,b)=>b.oppRating-a.oppRating)[0],toughestLoss=[...matches].filter(match=>!match.won&&match.oppRating!=null).sort((a,b)=>b.oppRating-a.oppRating)[0],date=historicalRoundDate(actualRound),team=snap[4]||current?.team||'',record=wins+'–'+(matches.length-wins),recentText=last.length?recentWins+'–'+(last.length-recentWins):'—';
  let html='<div class="profile-head lab-head"><div><div class="kicker">PLAYER LAB · AFTER ROUND '+actualRound+'</div><h2>'+esc(name)+'</h2><p>'+teamName(team)+(date?' · '+esc(date):'')+'</p></div><span class="confidence conf-mid"><b>Historical snapshot</b><small>'+matches.length+' singles matches known</small></span></div>';
  html+='<section class="lab-hero"><div class="lab-power"><span>Power after Round '+actualRound+'</span><strong>'+snap[1]+'</strong><small>'+(row?.rank?'#'+row.rank+' in the qualified table':'Provisional at this point')+'</small></div><div class="lab-hero-grid">'+profileMetric('Record',record,matches.length+' completed singles')+profileMetric('Game share',gf+ga?Math.round(100*gf/(gf+ga))+'%':'—',gf+'–'+ga+' games')+profileMetric('Round movement',change==null?'—':(change>=0?'+':'')+change,change==null?'first snapshot':'from previous round')+profileMetric('Season trend',seasonChange==null?'—':(seasonChange>=0?'+':'')+seasonChange,firstPower!=null?'since first result':'')+'</div></section>';
  html+='<section class="profile-section lab-section"><div class="lab-section-head"><div><h3>Historical matchup</h3></div></div>'+profileMatchupSection(name,matches,actualRound)+'</section>'+roleSection(insight,name,actualRound)+matchExplorerSection(matches,snap[1],true);
  html+='<div class="lab-layout"><div class="lab-main"><section class="profile-section lab-section"><div class="lab-section-head"><div><h3>Momentum to this round</h3></div><span>'+recentText+' last '+last.length+'</span></div>'+historyChart(name,actualRound)+'<div class="lab-momentum-grid">'+profileMetric('Last three games',last.length?recentGf+'–'+recentGa:'—',last.length?Math.round(100*recentGf/(recentGf+recentGa))+'% game share':'')+profileMetric('Average margin',averageMargin==null?'—':(averageMargin>=0?'+':'')+averageMargin.toFixed(1),matches.length?'games per match':'')+profileMetric('Uncertainty','±'+snap[2],snap[3]+' matches modelled')+'</div></section>'+performanceSection(insight)+'</div><aside class="lab-side"><section class="profile-section lab-section"><div class="lab-section-head"><div><h3>Headline results</h3></div></div><div class="lab-highlights">'+profileHighlight('Best-rated win',bestWin,bestWin?'Opponent Power '+bestWin.oppRating+' at the time':'')+profileHighlight('Top performance',bestPerformance,bestPerformance?'Performance '+bestPerformance.performance:'')+profileHighlight('Toughest loss',toughestLoss,toughestLoss?'Opponent Power '+toughestLoss.oppRating+' at the time':'')+(bestWin||bestPerformance||toughestLoss?'':'<p class="small-note">No comparable singles performances yet.</p>')+'</div></section><section class="profile-section lab-section"><div class="lab-section-head"><div><h3>Round context</h3></div></div><div class="lab-context-actions"><button class="button secondary" type="button" data-history-table="'+actualRound+'">Round '+actualRound+' ratings</button><button class="button secondary" type="button" data-player="'+esc(name)+'">Current Player Lab</button></div></section></aside></div>';
  $('#profileContent').innerHTML=html;renderProfileMatchExplorer(matches,snap[1],true);$('#profileOverlay').classList.remove('hidden');document.body.classList.add('modal-open');
}
function scheduleBand(value, rows){const values=rows.map(row=>row.averageOpponent).sort((a,b)=>a-b),median=values[Math.floor(values.length/2)],spread=Math.max(1,(values[Math.floor(values.length*.75)]-values[Math.floor(values.length*.25)])/1.35),z=(value-median)/spread;return z>=1?'Brutal':z>=.45?'Demanding':z>=-.15?'Tough':z>=-.65?'Typical':z>=-1.1?'Friendly':'Light'}
function scheduleDivider(label){return'<tr class="schedule-band-divider band-'+label.toLowerCase()+'"><td colspan="5"><span>'+esc(label)+'</span></td></tr>'}function openSchedule(){const rows=auxiliaryPlayer(activeProfilePlayer)?auxiliaryCache.sos:(D.strengthOfSchedule||[]);let last='',body='';for(const row of rows){const band=scheduleBand(row.averageOpponent,rows);if(band!==last){body+=scheduleDivider(band);last=band}body+='<tr><td>#'+row.rank+'</td><td>'+personButton(row.player)+'</td><td>'+teamName(row.team)+'</td><td><b>'+row.averageOpponent+'</b></td><td>'+row.matches+'</td></tr>'}$('#sosContent').innerHTML='<div class="overlay-title"><div class="kicker">STRENGTH OF SCHEDULE</div><h2>Opponent difficulty</h2><p>Higher average opponent Power means a harder schedule.</p></div><div class="table-wrap"><table class="schedule-table"><thead><tr><th>Rank</th><th>Player</th><th>Team</th><th>Average opponent</th><th>Matches</th></tr></thead><tbody>'+body+'</tbody></table></div>';$('#sosOverlay').classList.remove('hidden');document.body.classList.add('modal-open')}

function signed(value,digits=1){const n=Number(value);return(Number.isFinite(n)&&n>0?'+':'')+(Number.isFinite(n)?n.toFixed(digits):'—')}
function profileMatchupResult(name,opponent,round=null){
  const rating=round?historicalSnapshot(name,round)?.[1]:singles.find(row=>row.player===name)?.rating;
  const otherRating=round?historicalSnapshot(opponent,round)?.[1]:singles.find(row=>row.player===opponent)?.rating;
  if(rating==null||otherRating==null)return'<p class="small-note">A rating is not available for both players at this point.</p>';
  let probability=1/(1+Math.exp(-(rating-otherRating)/450));
  if(!round){
    const players=D.matchupMatrix?.players||[],ai=players.findIndex(row=>row.player===name),bi=players.findIndex(row=>row.player===opponent);
    if(ai>=0&&bi>=0)probability=D.matchupMatrix.probabilities?.[ai]?.[bi]??probability;
  }
  const matches=(round?historicalPlayerMatches(name,round):playerMatches(name)).filter(match=>match.opp===opponent),wins=matches.filter(match=>match.won).length,gf=matches.reduce((total,match)=>total+match.gf,0),ga=matches.reduce((total,match)=>total+match.ga,0),gap=rating-otherRating;
  return'<div class="lab-matchup-result"><div class="lab-matchup-projection"><span>'+esc(round?'Power-based outlook':'Projected win chance')+'</span><b>'+Math.round(100*probability)+'%</b><small>'+esc(name)+' · '+rating+' Power</small></div><div class="lab-matchup-stats"><div><span>Power gap</span><b>'+(gap>0?'+':'')+gap+'</b></div><div><span>Past meetings</span><b>'+(matches.length?wins+'–'+(matches.length-wins):'—')+'</b></div><div><span>Games</span><b>'+(matches.length?gf+'–'+ga:'—')+'</b></div></div><p class="explain">'+(round?'Ratings and past meetings are limited to results through Round '+round+'.':'Projection uses the section matchup model; past meetings use recorded singles results.')+'</p></div>';
}
function profileMatchupSection(name,matches,round=null){
  const source=round?historicalRows(round).map(row=>({player:row.player,rating:row.rating})):Array.isArray(D.matchupMatrix?.players)&&D.matchupMatrix.players.length?D.matchupMatrix.players:singles.map(row=>({player:row.player,rating:row.rating})),players=source.filter(row=>row.player!==name);
  if(!players.length)return'<div class="lab-matchup"><p>No other rated players are available in this section.</p></div>';
  const available=new Set(players.map(row=>row.player)),frequent=matches.slice().reverse().find(match=>available.has(match.opp))?.opp,selected=frequent||players[0].player;
  return'<div class="lab-matchup"><label class="lab-matchup-label">Compare with<select data-profile-opponent data-profile-player="'+esc(name)+'" data-profile-round="'+(round||'')+'">'+players.map(row=>'<option value="'+esc(row.player)+'"'+(row.player===selected?' selected':'')+'>'+esc(row.player)+' · '+row.rating+'</option>').join('')+'</select></label><div data-profile-matchup-result>'+profileMatchupResult(name,selected,round)+'</div></div>';
}
async function openGlobalPlayer(sectionCode,player){
  await loadSection(sectionCode);
  switchPage('ratings');
  openProfile(player);
}

function roundHighlight(title,item,kind){if(!item)return'<div class="round-highlight '+kind+'"><span>'+title+'</span><b>None this round</b></div>';return'<div class="round-highlight '+kind+'"><span>'+title+'</span><b>'+esc(item.winner)+' '+esc(item.score)+' '+esc(item.loser)+'</b><small>'+(title==='Biggest upset'?'Rating gap '+Math.round(item.gap)+' points':title==='Top performance'?'Performance ≈ '+item.performance:title==='Most dominant'?'Game margin '+item.margin:'Closest scoreline')+'</small></div>'}
function clubBaseName(value){
  let name=String(value??'').replace(/\s+/g,' ').trim(),previous='';
  const colours=Object.keys(TEAM_COLOURS).join('|'),partner="ap|gp|gm|gphc|mlc|scot|scotch|xavier|bodley|beech|beec|st\\s+kevin'?s?";
  while(name&&name!==previous){previous=name;name=name.replace(/\s+(?:no\.?\s*)?#?\d+\s*$/i,'').replace(new RegExp('\\s+(?:'+colours+')(?:s\\d+)?\\s*$','i'),'').replace(new RegExp('\\s+(?:'+partner+')#?\\s*$','i'),'').replace(new RegExp('\\s+(?:'+partner+')\\s*#?\\d+\\s*$','i'),'').trim()}
  return ({kptc:'Kings Park','kings park tc':'Kings Park','kings park tennis club':'Kings Park'})[name.toLowerCase()]||name;
}
function clubTeamButton(name){return '<button class="club-link" type="button" data-club-team="'+esc(name)+'">'+teamName(name)+'</button>'}
function sumClub(rows,key){return rows.reduce((total,row)=>total+(Number(row[key])||0),0)}
function uniqueClubCount(rows,predicate){return new Set(rows.filter(predicate).map(row=>row.season_id+'|'+row.section_code)).size}
function clubLabelStats(rows){const played=sumClub(rows,'played'),wins=sumClub(rows,'wins'),draws=sumClub(rows,'draws'),losses=sumClub(rows,'losses'),gamesFor=sumClub(rows,'games_for'),gamesAgainst=sumClub(rows,'games_against');return{played,wins,draws,losses,gamesFor,gamesAgainst,record:wins+'–'+draws+'–'+losses,winRate:played?Math.round(100*(wins+draws*.5)/played)+'%':'—',gameShare:gamesFor+gamesAgainst?Math.round(100*gamesFor/(gamesFor+gamesAgainst))+'%':'—'}}
let clubIndex=null,clubIndexPromise=null,clubDetailsCache=new Map(),activeClubZone=null;
async function loadClubIndex(){
  if(clubIndex)return clubIndex;
  if(!clubIndexPromise)clubIndexPromise=fetch('data/archive/clubs.json',{cache:'no-store'}).then(response=>response.ok?response.json():Promise.reject(new Error('Club history is still being prepared.'))).then(data=>{clubIndex=data;return data}).catch(error=>{clubIndexPromise=null;throw error});
  return clubIndexPromise;
}
async function loadClubCompetition(code){
  const manifest=await loadClubIndex(),competition=manifest.competitions?.[code];if(!competition)throw Error('That competition has no Club Zone archive.');
  if(clubDetailsCache.has(code))return clubDetailsCache.get(code);
  const detail=await fetch(competition.path,{cache:'no-store'}).then(response=>response.ok?response.json():Promise.reject(new Error('That club archive could not be loaded.')));
  const joined={...competition,...detail};clubDetailsCache.set(code,joined);return joined;
}
function clubZoneEntries(){if(!activeClubZone)return[];const {section='',season='',variant=''}=activeClubZone;return activeClubZone.club.entries.filter(row=>(!section||row.section_label===section)&&(!season||row.season_label===season)&&(!variant||row.team===variant))}
function clubZoneFixtures(){if(!activeClubZone)return[];const {section='',season='',variant='',result='',opponent=''}=activeClubZone;return(activeClubZone.club.fixtures||[]).filter(row=>(!section||row.section_label===section)&&(!season||row.season_label===season)&&(!variant||row.team===variant)&&(!result||row.result===result)&&(!opponent||row.opponent_club===opponent))}
function clubMetric(label,value,detail=''){return '<div class="lab-metric club-metric"><span>'+esc(label)+'</span><b>'+esc(value??'—')+'</b>'+(detail?'<small>'+esc(detail)+'</small>':'')+'</div>'}
function clubTrend(rows){
  const groups=new Map();for(const row of rows){const item=groups.get(row.season_order)||{label:row.season_label,order:row.season_order,total:0,count:0};item.total+=Number(row.position)||0;item.count++;groups.set(row.season_order,item)}
  const values=[...groups.values()].sort((a,b)=>a.order-b.order).map(item=>({...item,value:item.count?item.total/item.count:0}));if(values.length<2)return'<p class="small-note">A trend appears once the club has two recorded seasons.</p>';
  const width=620,height=128,pad=18,min=Math.min(...values.map(item=>item.value)),max=Math.max(...values.map(item=>item.value)),range=Math.max(1,max-min),points=values.map((item,index)=>{const x=pad+index*(width-pad*2)/(values.length-1),y=pad+(item.value-min)*(height-pad*2)/range;return x.toFixed(1)+','+y.toFixed(1)}).join(' ');
  return'<svg class="club-trend" viewBox="0 0 '+width+' '+height+'" role="img" aria-label="Average finishing position by season, lower is better"><line x1="'+pad+'" y1="'+pad+'" x2="'+(width-pad)+'" y2="'+pad+'" class="club-trend-grid"/><line x1="'+pad+'" y1="'+(height-pad)+'" x2="'+(width-pad)+'" y2="'+(height-pad)+'" class="club-trend-grid"/><polyline points="'+points+'" class="club-trend-line"/>'+values.map((item,index)=>{const [x,y]=points.split(' ')[index].split(',');return'<circle cx="'+x+'" cy="'+y+'" r="4" class="club-trend-point"><title>'+esc(item.label)+' · average finish #'+item.value.toFixed(1)+'</title></circle>'}).join('')+'</svg><p class="explain">Average finishing position by season. Lower is better; a season with several club teams is averaged across them.</p>';
}
function clubSeasonCards(rows){
  const groups=new Map();for(const row of rows){const item=groups.get(row.season_id)||{label:row.season_label,order:row.season_order,rows:[]};item.rows.push(row);groups.set(row.season_id,item)}
  return[...groups.values()].sort((a,b)=>b.order-a.order).map(item=>{const stats=clubLabelStats(item.rows),best=Math.min(...item.rows.map(row=>Number(row.position)||Infinity)),titles=uniqueClubCount(item.rows,row=>row.champion),teams=[...new Set(item.rows.map(row=>row.team))];return'<article class="club-season-card"><div><span>'+esc(item.label)+'</span><b>'+(titles?titles+' title'+(titles===1?'':'s'):'No title')+'</b></div><strong>Best finish #'+best+'</strong><p>'+teams.map(teamName).join(' · ')+'</p><small>Best finish #'+best+' · '+stats.record+' · '+stats.winRate+'</small></article>'}).join('');
}
function clubSectionProfile(rows){
  const groups=new Map();for(const row of rows){const item=groups.get(row.section_label)||{label:row.section_label,rows:[]};item.rows.push(row);groups.set(row.section_label,item)}
  return[...groups.values()].sort((a,b)=>b.rows.length-a.rows.length||a.label.localeCompare(b.label)).map(item=>{const stats=clubLabelStats(item.rows),best=Math.min(...item.rows.map(row=>Number(row.position)||Infinity)),avg=(item.rows.reduce((total,row)=>total+(Number(row.position)||0),0)/item.rows.length).toFixed(1);return'<tr><td>'+esc(item.label)+'</td><td>'+item.rows.length+'</td><td>#'+best+'</td><td>#'+avg+'</td><td>'+stats.record+'</td></tr>'}).join('');
}
function clubRivals(rows){
  const groups=new Map();for(const row of rows){const item=groups.get(row.opponent_club)||{name:row.opponent_club,rows:[]};item.rows.push(row);groups.set(row.opponent_club,item)}
  return[...groups.values()].map(item=>{const w=item.rows.filter(row=>row.result==='W').length,l=item.rows.filter(row=>row.result==='L').length,d=item.rows.length-w-l;return{...item,record:w+'–'+d+'–'+l}}).sort((a,b)=>b.rows.length-a.rows.length||a.name.localeCompare(b.name)).slice(0,8);
}
function clubResultRow(row){const score=row.points_for!=null&&row.points_against!=null?row.points_for+'–'+row.points_against:(row.rubbers_for!=null&&row.rubbers_against!=null?row.rubbers_for+'–'+row.rubbers_against:'Result');return'<article class="club-result-row"><span class="club-result-badge '+(row.result==='W'?'win':row.result==='L'?'loss':'')+'">'+row.result+'</span><b>'+teamName(row.team)+' <em>v</em> '+teamName(row.opponent)+'</b><strong>'+esc(score)+'</strong><small>'+esc(row.season_label)+' · '+esc(row.section_label)+' · '+esc(row.label||('Round '+(row.round??'—')))+'</small></article>'}
function clubZoneControls(competition,club,rows){
  const seasons=[...new Set(club.entries.map(row=>row.season_label))],variants=[...new Set(club.entries.map(row=>row.team))].sort((a,b)=>a.localeCompare(b)),opponents=[...new Set((club.fixtures||[]).map(row=>row.opponent_club))].sort((a,b)=>a.localeCompare(b)),{section='',season='',variant='',result='',opponent=''}=activeClubZone;
  return'<section class="club-zone-controls"><label>Section<select id="clubZoneSection"><option value="">All sections</option>'+competition.sections.map(label=>'<option value="'+esc(label)+'"'+(label===section?' selected':'')+'>'+esc(label)+'</option>').join('')+'</select></label><label>Season<select id="clubZoneSeason"><option value="">All seasons</option>'+seasons.map(label=>'<option value="'+esc(label)+'"'+(label===season?' selected':'')+'>'+esc(label)+'</option>').join('')+'</select></label><label>Team variant<select id="clubZoneVariant"><option value="">Combined club</option>'+variants.map(label=>'<option value="'+esc(label)+'"'+(label===variant?' selected':'')+'>'+teamName(label).replace(/<[^>]*>/g,'')+'</option>').join('')+'</select></label><label>Opponent<select id="clubZoneOpponent"><option value="">All opponents</option>'+opponents.map(label=>'<option value="'+esc(label)+'"'+(label===opponent?' selected':'')+'>'+esc(label)+'</option>').join('')+'</select></label><label>Result<select id="clubZoneResult"><option value="">All results</option>'+['W','L','D'].map(value=>'<option value="'+value+'"'+(value===result?' selected':'')+'>'+({W:'Wins',L:'Losses',D:'Draws'})[value]+'</option>').join('')+'</select></label></section>';
}
function renderClubZone(){
  if(!activeClubZone)return;
  const {competition,club}=activeClubZone,entries=clubZoneEntries(),fixtures=clubZoneFixtures(),allEntries=club.entries||[],stats=clubLabelStats(entries),allStats=clubLabelStats(allEntries),first=[...allEntries].sort((a,b)=>a.season_order-b.season_order)[0],last=[...allEntries].sort((a,b)=>b.season_order-a.season_order)[0],championships=uniqueClubCount(entries,row=>row.champion),finals=uniqueClubCount(entries,row=>row.finalist),semifinals=uniqueClubCount(entries,row=>row.semifinalist),best=entries.length?Math.min(...entries.map(row=>Number(row.position)||Infinity)):'—',average=entries.length?(entries.reduce((total,row)=>total+(Number(row.position)||0),0)/entries.length).toFixed(1):'—',teams=new Set(entries.map(row=>row.team)).size,seasons=new Set(entries.map(row=>row.season_id)).size,rivals=clubRivals(fixtures),players=(club.players||[]).slice(0,8),resultLimit=activeClubZone.resultLimit||16,isCurrent=allEntries.some(row=>row.season_id==='current'),activity=isCurrent?'Established '+(first?.season_label||'in the recorded archive')+' · active in '+(last?.season_label||'the current season'):'Active '+(first?.season_label||'in the recorded archive')+' to '+(last?.season_label||'the last recorded season');
  let out='<div class="profile-head lab-head club-zone-head"><div><div class="kicker">CLUB ZONE · '+esc(competition.label)+'</div><h2>'+teamName(club.name)+'</h2><p>'+esc(activity)+' · '+allEntries.length+' historical team entries</p></div><span class="confidence conf-mid"><b>'+allStats.record+' all-time</b><small>'+new Set(allEntries.map(row=>row.season_id)).size+' seasons · '+new Set(allEntries.map(row=>row.team)).size+' variants</small></span></div>';
  out+='<p class="club-recap">'+teamName(club.name)+' have recorded <b>'+allEntries.length+' team entries</b> across <b>'+new Set(allEntries.map(row=>row.season_id)).size+' '+competition.label+' seasons</b>, with <b>'+uniqueClubCount(allEntries,row=>row.champion)+' championship'+(uniqueClubCount(allEntries,row=>row.champion)===1?'':'s')+'</b>, a best finish of <b>#'+Math.min(...allEntries.map(row=>Number(row.position)||Infinity))+'</b>, and a '+allStats.winRate+' team-tie points rate.</p>';
  out+=clubZoneControls(competition,club,entries);
  if(!entries.length){out+='<section class="club-empty"><h3>No matching club entry</h3><p>Try clearing one of the filters.</p></section>';$('#clubZoneContent').innerHTML=out;return}
  out+='<section class="club-hero-grid">'+clubMetric('Filtered record',stats.record,stats.played+' completed ties · '+stats.winRate)+' '+clubMetric('Trophy cabinet',championships+' title'+(championships===1?'':'s'),finals+' grand finals · '+teams+' team variants')+' '+clubMetric('Section record','#'+best+' best',average==='—'?'':'average finish #'+average)+' '+clubMetric('Game share',stats.gameShare,stats.gamesFor+'–'+stats.gamesAgainst+' games')+'</section>';
  out+='<div class="club-zone-layout"><main class="club-zone-main"><section class="club-panel"><div class="club-panel-head"><div><h3>Season journey</h3></div><span>'+seasons+' seasons</span></div><div class="club-season-grid">'+clubSeasonCards(entries)+'</div></section><section class="club-panel"><div class="club-panel-head"><div><h3>Results explorer</h3></div><span>'+fixtures.length+' results</span></div><div class="club-results-list">'+fixtures.slice(0,resultLimit).map(clubResultRow).join('')+(fixtures.length>resultLimit?'<button type="button" id="clubResultMore" class="club-results-more">Show '+Math.min(16,fixtures.length-resultLimit)+' more results</button>':'')+'</div></section><section class="club-panel"><div class="club-panel-head"><div><h3>Section profile</h3></div></div><div class="table-wrap"><table class="club-section-table"><thead><tr><th>Section</th><th>Entries</th><th>Best</th><th>Average</th><th>Record</th></tr></thead><tbody>'+clubSectionProfile(entries)+'</tbody></table></div></section><details class="club-history-details"><summary>Open full standings history · '+entries.length+' team entries</summary><div class="table-wrap"><table class="club-history-table"><thead><tr><th>Season</th><th>Section</th><th>Team</th><th>Finish</th><th>Record</th><th>Games</th><th>Finals</th></tr></thead><tbody>'+entries.map(row=>'<tr><td>'+esc(row.season_label)+'</td><td>'+esc(row.section_label)+'</td><td>'+teamName(row.team)+'</td><td><b>#'+esc(row.position)+'</b></td><td>'+esc(row.wins)+'–'+esc(row.draws)+'–'+esc(row.losses)+'</td><td>'+esc(row.games_for)+'–'+esc(row.games_against)+'</td><td>'+(row.champion?'<b class="club-champion">Champion</b>':row.finalist?'Grand final':row.semifinalist?'Semifinal':'—')+'</td></tr>').join('')+'</tbody></table></div></details></main><aside class="club-zone-side"><section class="club-panel"><div class="club-panel-head"><div><h3>Performance trend</h3><p>Lower finishing position is better.</p></div></div>'+clubTrend(entries)+'</section><section class="club-panel"><div class="club-panel-head"><div><h3>Club vs club</h3><p>Most common opponents in the selected view.</p></div></div><div class="club-rivals">'+(rivals.length?rivals.map(item=>'<button type="button" class="club-rival" data-club-rival="'+esc(item.name)+'"><span>'+esc(item.name)+'</span><b>'+item.record+'</b><small>'+item.rows.length+' ties</small></button>').join(''):'<p class="small-note">No completed ties recorded.</p>')+'</div></section><section class="club-panel"><div class="club-panel-head"><div><h3>Player history</h3></div></div><div class="club-players">'+(players.length?players.map(player=>'<div><b>'+esc(player.name)+'</b><span>'+player.appearances+' appearances · '+player.wins+' wins</span><small>'+esc(player.first_season)+'–'+esc(player.last_season)+'</small></div>').join(''):'<p class="small-note">No player record was published for this club.</p>')+'</div></section></aside></div>';
  $('#clubZoneContent').innerHTML=out;
}
async function openClubPicker(){
  $('#clubPickerOverlay').classList.remove('hidden');document.body.classList.add('modal-open');
  const competition=$('#clubPickerCompetition'),club=$('#clubPickerClub'),status=$('#clubPickerStatus');competition.value='';club.innerHTML='<option value="">Choose a competition first</option>';club.disabled=true;$('#clubPickerOpen').disabled=true;status.textContent='Choose Saturday AM or Sunday AM to load its complete club list.';
  try{await loadClubIndex()}catch(error){status.textContent=error.message}
}
function fillClubChoices(){
  const code=$('#clubPickerCompetition').value,clubSelect=$('#clubPickerClub'),status=$('#clubPickerStatus'),open=$('#clubPickerOpen'),competition=clubIndex?.competitions?.[code];clubSelect.innerHTML='<option value="">Choose a club</option>';clubSelect.disabled=true;open.disabled=true;
  if(!competition){status.textContent='Club history is still being prepared.';return}
  clubSelect.innerHTML+=competition.clubs.map(club=>'<option value="'+esc(club.name)+'">'+esc(club.name)+' · '+club.entries+' entries</option>').join('');clubSelect.disabled=false;status.textContent=competition.clubs.length+' combined clubs across the '+competition.label+' archive.';
}
async function openChosenClubZone(){
  const code=$('#clubPickerCompetition').value,name=$('#clubPickerClub').value;if(!code||!name)return;const button=$('#clubPickerOpen'),status=$('#clubPickerStatus');button.disabled=true;status.textContent='Opening '+name+'…';
  try{const competition=await loadClubCompetition(code),club=competition.clubs.find(item=>item.name===name);if(!club)throw Error('That club has no detailed archive.');activeClubZone={competition,club,section:'',season:'',variant:'',result:'',opponent:'',resultLimit:16};close('#clubPickerOverlay');renderClubZone();$('#clubZoneOverlay').classList.remove('hidden');document.body.classList.add('modal-open');$('#clubZoneClose').focus()}catch(error){status.textContent=error.message;button.disabled=false}
}
async function openClubForTeam(team){
  const code=D?.meta?.competition_code,clubName=clubBaseName(team);if(!code||!clubName)return;
  try{const competition=await loadClubCompetition(code),club=competition.clubs.find(item=>item.name===clubName);if(!club)return;activeClubZone={competition,club,section:'',season:'',variant:'',result:'',opponent:'',resultLimit:16};renderClubZone();$('#clubZoneOverlay').classList.remove('hidden');document.body.classList.add('modal-open')}catch{}
}
function openRound(){const r=D.roundOverview;if(!r)return;const s=r.summary||{},mover=s.topMover?esc(s.topMover.player)+' +'+s.topMover.change:'No prior snapshot',drop=s.biggestDrop?esc(s.biggestDrop.player)+' '+s.biggestDrop.change:'No prior snapshot';$('#roundContent').innerHTML='<div class="overlay-title"><div class="kicker">LATEST ROUND</div><h2>'+esc(r.label||('Round '+r.round))+'</h2><p>'+esc(roundDate(r.date))+' · '+esc(D.meta.section_label)+'</p></div><div class="round-metrics"><div><span>Completed ties</span><b>'+esc(s.completedFixtures??'—')+'</b></div><div><span>Singles rubbers</span><b>'+esc(s.singlesRubbers??'—')+'</b></div><div><span>Doubles rubbers</span><b>'+esc(s.doublesRubbers??'—')+'</b></div><div><span>Average singles margin</span><b>'+(s.averageSinglesMargin??'—')+' games</b></div></div><div class="round-fixtures">'+r.fixtures.map(f=>'<button class="round-fixture '+(f.status!=='Completed'?'pending':'')+'" data-match-id="'+esc(f.fixtureId)+'"><b>'+esc(f.home)+' '+(f.status==='Completed'?f.homeRubbers+'–'+f.awayRubbers:'v')+' '+esc(f.away)+'</b><span>'+(f.status==='Completed'?'Games '+f.homeGames+'–'+f.awayGames+(f.winner?' · '+esc(f.winner)+' won':''):esc(f.status))+' · View result</span></button>').join('')+'</div><div class="round-highlights">'+roundHighlight('Top performance',r.topPerformance,'top')+roundHighlight('Biggest upset',r.biggestUpset,'upset')+roundHighlight('Most dominant',r.dominantWin,'dominant')+roundHighlight('Closest singles',r.closestMatch,'close')+'</div><div class="round-movers"><div><span>Biggest Power rise</span><b>'+mover+'</b></div><div><span>Largest Power fall</span><b>'+drop+'</b></div></div><p class="small-note">Rating movements use the as-of-round snapshots.</p>';$('#roundOverlay').classList.remove('hidden');document.body.classList.add('modal-open')}
function methodologyHTML(){return'<div class="methodology"><h3>Rating model</h3><p>Expected game probability:</p><div class="equation">p = 1 / (1 + e<sup>−(θᵢ − θⱼ) / 0.75</sup>)</div><p>Match-date weighting and displayed scale:</p><div class="equation">w = 2<sup>− age / 365</sup> &nbsp; · &nbsp; Power = 1500 + 600θ</div><p>Rubbers-format multi-set singles are one contest in the record, while all games in their published set scores contribute to the scoreline likelihood.</p><h3>Individual doubles</h3><div class="equation">θ<sub>team</sub> = (θ<sub>A</sub> + θ<sub>B</sub>) / 2</div><p>Sets and Green Ball need 4 appearances, 2 distinct partners and an identifiable network position. Two-player Rubbers sections show 4+ appearance doubles evidence as partner-dependent.</p><div class="model-export"><b>Calculation audit</b><p>Download this section’s entered rubbers, model settings and fitted rating outputs in a readable JSON file.</p><button id="exportModelAuditBtn" class="button secondary" type="button">Export rating model audit</button></div></div>'}
function brtaRulesHTML(){return'<div class="brta-rules"><p class="rules-intro">The site applies these 2026 Weekend Junior By-Law rules consistently to every Saturday and Sunday AM section.</p><details open><summary>Team points</summary><p><b>Sets and Green Ball:</b> 4 points for a team win, 2 points each for a draw or undecided tie, plus 1 point for each set won and 0.5 for each uncompleted set.</p><p><b>Rubbers:</b> 2 points for a team win, 1 point each for a draw or undecided tie, plus the same set points.</p></details><details><summary>Formats and deciding a tie</summary><p>Sets and Green Ball use four players per team. Rubbers uses two. Team ties are decided by sets, then games if sets are level. Green Ball is first to six games with no tiebreak, so 5–5 is decided by the next game; Rubbers singles uses two 6-game sets with a 10-point match tiebreak if required.</p></details><details><summary>Washouts, byes and forfeits</summary><p>Byes earn no points. A washout or unfinished home-and-away tie receives the draw points plus 0.5 for every uncompleted set; recorded games still count toward percentage. A complete team forfeit awards the receiving team all available set points, but no game percentage.</p></details><details><summary>Ladder order and corrections</summary><p>Teams are ordered by points, then games-for divided by games-against percentage. A result missing after five business days may be awarded to the visiting team. Eligibility, order-of-merit and duplicate-player breaches can also change an official result; TROLS remains the public source of truth for entered scorecards.</p></details><p class="rules-source">Summary of BRTA Weekend Junior By-Laws (effective 1 January 2026). <a href="https://www.baysidetennis.asn.au/wp-content/uploads/2026/08/BRTA-By-Laws-Weekend-Junior-V4.pdf" target="_blank" rel="noopener">Read the official by-laws</a>.</p></div>'}
function readHistorySelection(){try{return JSON.parse(localStorage.getItem('brta-history-selection')||'null')}catch{return null}}
function historySectionCode(){return readHistorySelection()?.sectionCode||''}
async function ensureHistoryCatalog(){if(historyCatalog)return historyCatalog;if(!historyCatalogPromise)historyCatalogPromise=fetch('data/archive/catalog.json',{cache:'no-store'}).then(response=>response.ok?response.json():null).catch(()=>null);const catalog=await historyCatalogPromise;if(catalog)historyCatalog=catalog;else historyCatalogPromise=null;return catalog}
function refreshHistorySectionChoices(seasonId=null,sectionCode=null){const seasonSelect=$('#historySeason'),sectionSelect=$('#historySection'),info=$('#historyInfo');if(!seasonSelect||!sectionSelect)return;const competition=$('#historyCompetition').value,seasons=(historyCatalog?.seasons||[]).filter(x=>x.competition_code===competition);let selected=seasonId||seasonSelect.value;if(!seasons.some(x=>x.id===selected)){const saved=readHistorySelection();selected=activeHistorySeasonId||((saved&&seasons.some(x=>x.id===saved.seasonId))?saved.seasonId:'')||seasons.find(x=>x.is_current)?.id||seasons[0]?.id||''}seasonSelect.innerHTML=seasons.map(x=>'<option value="'+esc(x.id)+'">'+esc(x.season_option_label||x.season_label)+'</option>').join('');seasonSelect.value=selected;const season=seasons.find(x=>x.id===selected),sections=season?.sections||[];let currentSection=sectionCode||sectionSelect.value;const saved=readHistorySelection();if(!sections.some(x=>x.section_code===currentSection))currentSection=saved?.seasonId===selected?saved.sectionCode:'';if(!sections.some(x=>x.section_code===currentSection))currentSection=D?.meta?.competition_code===competition?D.meta.section_code:'';if(!sections.some(x=>x.section_code===currentSection))currentSection=sections[0]?.section_code||'';sectionSelect.innerHTML=sections.map(x=>'<option value="'+esc(x.section_code)+'">'+esc(x.section_label)+'</option>').join('');sectionSelect.value=currentSection;if(info)info.textContent=season?season.season_label+' · '+sections.length+' sections'+(season.is_current?' · live season data':' · TROLS archive'):'No archived seasons available.';$('#historyOpenBtn').disabled=!season||!sections.length}
async function hydrateHistorySettings(){const info=$('#historyInfo');if(!info)return;const catalog=await ensureHistoryCatalog();if(!catalog){info.textContent='The season archive is not available yet.';$('#historyOpenBtn').disabled=true;return}const competition=$('#historyCompetition');const currentComp=D?.meta?.competition_code||'UA';const saved=readHistorySelection();const preferred=activeHistorySeasonId||saved?.seasonId||catalog.seasons.find(x=>x.competition_code===currentComp&&x.is_current)?.id;competition.value=(catalog.seasons.find(x=>x.id===preferred)?.competition_code||currentComp);refreshHistorySectionChoices(preferred,saved?.sectionCode||D?.meta?.section_code||'');competition.onchange=()=>refreshHistorySectionChoices();$('#historySeason').onchange=()=>refreshHistorySectionChoices($('#historySeason').value,'');$('#historyOpenBtn').onclick=()=>openHistoryChoice();$('#historyCurrentBtn').onclick=()=>goToCurrentSeason()}
async function openHistoryChoice(){
  const season=historyCatalog?.seasons.find(x=>x.id===$('#historySeason').value),section=season?.sections.find(x=>x.section_code===$('#historySection').value),button=$('#historyOpenBtn'),info=$('#historyInfo');
  if(!season||!section)return;
  const historicalCatalog=historySeasonSections(season),meta=historicalCatalog.find(x=>x.section_code===section.section_code),dataPath=meta?.data_path;
  if(!dataPath){if(info)info.textContent='This historical section has no published archive file yet.';return}
  button.disabled=true;if(info)info.textContent='Opening '+season.season_label+' · '+section.section_label+'…';
  try{
    const response=await fetch(dataPath+'?v='+encodeURIComponent(DATA.globalSync.checkedAt||''),{cache:'no-store'});
    if(!response.ok)throw Error('The archive file is unavailable.');
    const payload=await response.json();
    if(!payload?.meta?.is_archive)throw Error('The selected file is not a historical section.');
    activeHistorySeasonId=season.id;viewCatalog=historicalCatalog;localStorage.setItem('brta-history-selection',JSON.stringify({seasonId:season.id,sectionCode:section.section_code}));
    setupSelectors();primeArchiveGlobalRows();close('#settingsOverlay');switchPage('results');await loadSection(section.section_code);
  }catch(error){
    if(info)info.textContent='Could not open this archive: '+error.message+' Your current section has not been changed.';
  }finally{if(button)button.disabled=false}
}
function goToCurrentSeason(){activeHistorySeasonId=null;viewCatalog=DATA.catalog||[];localStorage.removeItem('brta-history-selection');const code=viewCatalog.some(x=>x.section_code===localStorage.getItem('brta-section'))?localStorage.getItem('brta-section'):DATA.defaultSectionCode;setupSelectors();close('#settingsOverlay');switchPage('results');loadSection(code)}
function openSettings(){
  const s=DATA.globalSync||{},classic=interfaceMode==='classic',palette=[['yellow','Tennis yellow'],['green','Green'],['blue','Blue'],['red','Red'],['purple','Purple'],['black','Black'],['white','White']],colourControls=classic?'':'<div class="accent-setting"><span><b>Colour scheme</b><small>Changes the complete Default interface palette.</small></span><div class="accent-picker">'+palette.map(([value,label])=>'<button type="button" class="accent-choice '+(accent===value?'selected':'')+'" data-accent-choice="'+value+'" aria-label="'+label+' colour scheme" title="'+label+'"><i></i><span>'+label+'</span></button>').join('')+'</div></div>';
  $('#settingsContent').innerHTML=`<div class="overlay-title"><div class="kicker">SITE SETTINGS</div><h2>Settings</h2><p>Preferences are stored only on this device.</p></div>
    <div class="settings-grid">
      <div class="settings-group"><h3>Section</h3><p>Your competition and section choice is remembered. Use the selectors above to change it.</p></div>
      <div class="settings-group"><h3>Interface</h3><div class="interface-choice"><div><b>Website style</b><small>Both styles use the same data and features.</small></div><div class="segmented"><button id="futureModeBtn" class="${!classic?'selected':''}">Default</button><button id="classicModeBtn" class="${classic?'selected':''}">Classic</button></div></div></div>
      <div class="settings-group"><h3>Display</h3><label class="setting-row"><span><b>Show provisional entries</b><small>Show below-threshold entries as unranked.</small></span><input class="custom-check" type="checkbox" id="provToggle" ${showProv?'checked':''}></label><label class="setting-row"><span><b>Theme</b></span><select id="themeSelect"><option value="auto">Automatic</option><option value="light">Light</option><option value="dark">Dark</option></select></label>${colourControls}<div class="setting-row lab-position"><span><b>Player Lab position</b><small>Choose where a player profile opens on larger screens.</small></span><div class="segmented"><button data-profile-position="right" class="${profilePosition==='right'?'selected':''}">Right</button><button data-profile-position="left" class="${profilePosition==='left'?'selected':''}">Left</button><button data-profile-position="center" class="${profilePosition==='center'?'selected':''}">Centre</button></div></div></div>
      <div class="settings-group"><h3>BRTA sync</h3><div class="sync-box"><p><b>Last checked:</b> ${esc(fmtTime(s.checkedAt))}<br><b>Coverage:</b> ${esc(s.sections||DATA.catalog.length)} sections<br><b>Validation:</b> ${esc(s.validation||'—')}</p><a class="button primary" href="https://github.com/affluendo1/brta-power-ratings/actions/workflows/sync-trols.yml" target="_blank" rel="noopener">Check BRTA now</a></div></div>
    </div>
    <div class="settings-group settings-wide"><h3>Methodology</h3>${methodologyHTML()}</div>
    <div class="settings-group settings-wide history-settings"><h3>History</h3><p>View a past Saturday or Sunday AM season using TROLS results, scorecards and final ladders.</p><div class="history-selects"><label>Competition<select id="historyCompetition"><option value="AA">Saturday AM</option><option value="UA">Sunday AM</option></select></label><label>Season<select id="historySeason"></select></label><label>Section<select id="historySection"></select></label></div><div class="history-info" id="historyInfo">Loading available seasons…</div><div class="history-actions"><button class="button primary" id="historyOpenBtn" type="button">View selected section</button><button class="button secondary" id="historyCurrentBtn" type="button">Return to current season</button></div></div>
    <div class="settings-group settings-wide"><h3>BRTA rules used by the site</h3>${brtaRulesHTML()}</div>
    <div class="settings-group settings-wide extras-access"><button id="showExtrasBtn" class="button secondary ${window.AuxiliaryPortal?.isUnlocked?.()?'hidden':''}" type="button">Show Extras</button><button id="hideExtrasBtn" class="button secondary ${window.AuxiliaryPortal?.isUnlocked?.()?'':'hidden'}" type="button">Hide Extras</button></div>`;
  $('#settingsOverlay').classList.remove('hidden');document.body.classList.add('modal-open');$('#themeSelect').value=theme;$('#provToggle').onchange=e=>{showProv=e.target.checked;localStorage.setItem('brta-show-provisional',showProv?'1':'0');renderRatings()};$('#themeSelect').onchange=e=>{theme=e.target.value;localStorage.setItem('brta-theme',theme);applyTheme()};$$('[data-accent-choice]').forEach(button=>button.onclick=()=>{accent=button.dataset.accentChoice;localStorage.setItem('brta-accent',accent);applyTheme();$$('[data-accent-choice]').forEach(x=>x.classList.toggle('selected',x===button))});$$('[data-profile-position]').forEach(button=>button.onclick=()=>{profilePosition=button.dataset.profilePosition;localStorage.setItem('brta-profile-position',profilePosition);applyProfilePosition();$$('[data-profile-position]').forEach(x=>x.classList.toggle('selected',x===button))});$('#exportModelAuditBtn').onclick=exportModelAudit;$('#classicModeBtn').onclick=()=>switchInterface('classic');$('#futureModeBtn').onclick=()=>switchInterface('future');hydrateHistorySettings();window.AuxiliaryPortal?.bindSettings?.()
}
function applyProfilePosition(){$('#profileOverlay').dataset.position=profilePosition}
function runModeTransition(complete,{title='Switching interface',message='Preparing layout…',variant='default'}={}){const ov=$('#modeSwitchOverlay'),ring=$('#progressRing');ov.classList.toggle('royal-transition',variant==='royal');ov.querySelector('h2').textContent=title;$('#switchStatus').textContent=message;ring.style.setProperty('--progress','0deg');$('#progressPct').textContent='0%';ov.classList.remove('hidden');let p=0;const timer=setInterval(()=>{p=Math.min(100,p+4);ring.style.setProperty('--progress',p*3.6+'deg');$('#progressPct').textContent=p+'%';if(p===100){clearInterval(timer);setTimeout(()=>{try{complete()}finally{ov.classList.add('hidden');ov.classList.remove('royal-transition')}},150)}},20)}
function switchInterface(target){if(target===interfaceMode)return;runModeTransition(()=>{localStorage.setItem('brta-interface',target);location.reload()})}
window.runBRTAInterfaceTransition=runModeTransition;
function renderAll(){statusStrip();teamOptions();renderRatings();renderTeams();renderStandings();renderResults();renderFixtures();$('#roundBtn').textContent=D.roundOverview?(D.roundOverview.label||('Round '+D.roundOverview.round))+' overview':'Latest round'}

document.addEventListener('click',e=>{
  if(e.target.closest('[data-aux-backstory]')){if(auxiliaryPlayer(activeProfilePlayer))openAuxiliaryBackstory(auxiliaryCache);return}
  if(e.target.closest('[data-aux-open-archive]')){if(auxiliaryPlayer(activeProfilePlayer))window.AuxiliaryPortal?.open?.();return}
  const choice=e.target.closest('[data-choice-id]');if(choice){const id=choice.dataset.choiceId,value=choice.dataset.choiceValue;closeChoices();if(id==='competitionSelect'){const code=fillSections(value);loadSection(code)}else loadSection(value);return}
  if(!e.target.closest('.section-choice'))closeChoices();
  const searchScopeChoice=e.target.closest('[data-search-scope]');if(searchScopeChoice){setRatingScope(searchScopeChoice.dataset.searchScope);return}
  const historyPlayer=e.target.closest('[data-history-player]');if(historyPlayer){e.stopPropagation();close('#resultOverlay');close('#roundOverlay');openHistoricalProfile(historyPlayer.dataset.historyPlayer,Number(historyPlayer.dataset.historyRound));return}
  const historyTable=e.target.closest('[data-history-table]');if(historyTable){e.stopPropagation();openHistoricalTable(Number(historyTable.dataset.historyTable));return}
  const globalPlayer=e.target.closest('[data-global-player]');if(globalPlayer){e.stopPropagation();openGlobalPlayer(globalPlayer.dataset.sectionCode,globalPlayer.dataset.globalPlayer);return}
  const player=e.target.closest('[data-player]');if(player){e.stopPropagation();close('#resultOverlay');openProfile(player.dataset.player);return}
  const schedule=e.target.closest('[data-sos-open]');if(schedule){openSchedule();return}
  const fixtureResult=e.target.closest('[data-fixture-result-id]');if(fixtureResult){const id=fixtureResult.dataset.fixtureResultId,f=fixtureById(id),result=f&&findFixtureResult(f,f.round);if(result){openMatch(result.fixtureId)}else switchPage('results');return}
  const roundSimulation=e.target.closest('[data-simulate-round]');if(roundSimulation){simulateRound(roundSimulation.dataset.simulateRound);return}
  const closeRoundSimulationButton=e.target.closest('[data-close-round-simulation]');if(closeRoundSimulationButton){closeRoundSimulation(closeRoundSimulationButton.dataset.closeRoundSimulation);return}
  const prediction=e.target.closest('[data-predict-id]');if(prediction){openPrediction(prediction.dataset.predictId);return}
  const predictionHome=e.target.closest('[data-open-prediction-home]');if(predictionHome){openPredictionHome();return}
  const teamPrediction=e.target.closest('[data-team-predict]');if(teamPrediction){openPredictionHome(teamPrediction.dataset.teamPredict);return}
  if(e.target.closest('[data-start-custom-prediction]')){startCustomPrediction();return}
  const lineupHistory=e.target.closest('[data-lineup-history]');if(lineupHistory){openTeamLineupHistory(lineupHistory.dataset.lineupHistory);return}
  const lineupFixture=e.target.closest('[data-lineup-fixture]');if(lineupFixture){close('#lineupHistoryOverlay');openMatch(lineupFixture.dataset.lineupFixture);return}
  const rivalryOpen=e.target.closest('[data-open-rivalries]');if(rivalryOpen){const throughRound=Number(rivalryOpen.dataset.rivalryRound)||0,name=rivalryOpen.dataset.openRivalries,insight=auxiliaryPlayer(name)?auxiliaryCache.insight:(throughRound?historicalInsight(name,throughRound):playerInsight(name));openRivalries(name,insight,throughRound);return}
  const rivalryFixture=e.target.closest('[data-rival-fixture]');if(rivalryFixture){close('#rivalryOverlay');close('#profileOverlay');openMatch(rivalryFixture.dataset.rivalFixture,activeProfilePlayer);return}
  if(e.target.closest('[data-run-simulation]')){runPredictionSimulation();return}
  const autoOrder=e.target.closest('[data-auto-order]');if(autoOrder){const side=autoOrder.dataset.autoOrder,match=currentPredictionMatch();if(match){selectedPrediction[side].manualOrder=false;selectedPrediction.simulation=null;refreshPrediction()}return}
  const match=e.target.closest('[data-match-id]');if(match){const sourcePlayer=!$('#profileOverlay').classList.contains('hidden')?activeProfilePlayer:null;close('#roundOverlay');close('#profileOverlay');openMatch(match.dataset.matchId,sourcePlayer);return}
  const clubTeam=e.target.closest('[data-club-team]');if(clubTeam){e.stopPropagation();openClubForTeam(clubTeam.dataset.clubTeam);return}
  const rival=e.target.closest('[data-club-rival]');if(rival){activeClubZone.opponent=rival.dataset.clubRival;activeClubZone.resultLimit=16;renderClubZone();return}
  if(e.target.closest('#clubResultMore')){activeClubZone.resultLimit=(activeClubZone.resultLimit||16)+16;renderClubZone();return}
  if(e.target.dataset.close)close('#profileOverlay');if(e.target.dataset.searchOptionsClose)close('#searchOptionsOverlay');if(e.target.dataset.rivalryClose)close('#rivalryOverlay');if(e.target.dataset.clubPickerClose)close('#clubPickerOverlay');if(e.target.dataset.clubZoneClose)close('#clubZoneOverlay');if(e.target.dataset.roundClose)close('#roundOverlay');if(e.target.dataset.settingsClose)close('#settingsOverlay');if(e.target.dataset.resultClose)close('#resultOverlay');if(e.target.dataset.predictionClose)close('#predictionOverlay');if(e.target.dataset.lineupHistoryClose)close('#lineupHistoryOverlay');if(e.target.dataset.sosClose)close('#sosOverlay');
});
document.addEventListener('change',e=>{
  if(e.target.matches('[data-aux-profile-opponent]')){const host=e.target.parentElement.parentElement.querySelector('[data-aux-profile-matchup-result]');if(host&&auxiliaryCache)host.innerHTML=auxiliaryMatchupResult(auxiliaryCache,e.target.value);return}
  if(e.target.matches('[data-predict-side]')){updatePrediction(e.target.dataset.predictSide,e.target.dataset.predictPlayer,e.target.checked);return}
  if(e.target.matches('[data-singles-side]')){updateSingles(e.target.dataset.singlesSide,Number(e.target.dataset.singlesPosition),e.target.value);return}
  if(e.target.matches('[data-doubles-side]')){updateDoubles(e.target.dataset.doublesSide,Number(e.target.dataset.doublesPair),Number(e.target.dataset.doublesSlot),e.target.value);return}
  if(e.target.matches('[data-profile-opponent]')){const select=e.target,host=select.parentElement.parentElement.querySelector('[data-profile-matchup-result]');if(host)host.innerHTML=profileMatchupResult(select.dataset.profilePlayer,select.value,Number(select.dataset.profileRound)||null);}
  if(e.target.matches('#clubPickerCompetition'))fillClubChoices();
  if(e.target.matches('#clubPickerClub'))$('#clubPickerOpen').disabled=!e.target.value;
  if(e.target.matches('#clubZoneSection')){activeClubZone.section=e.target.value;activeClubZone.resultLimit=16;renderClubZone();}
  if(e.target.matches('#clubZoneSeason')){activeClubZone.season=e.target.value;activeClubZone.resultLimit=16;renderClubZone();}
  if(e.target.matches('#clubZoneVariant')){activeClubZone.variant=e.target.value;activeClubZone.resultLimit=16;renderClubZone();}
  if(e.target.matches('#clubZoneResult')){activeClubZone.result=e.target.value;activeClubZone.resultLimit=16;renderClubZone();}
  if(e.target.matches('#clubZoneOpponent')){activeClubZone.opponent=e.target.value;activeClubZone.resultLimit=16;renderClubZone();}
});
function setRatingScope(value){ratingScope=value==='all'?'all':'section';localStorage.setItem('brta-rating-scope',ratingScope);if(ratingScope==='all'&&ratingView==='pairs'){ratingView='singles';document.querySelectorAll('.subtab').forEach(x=>x.classList.toggle('active',x.dataset.rating==='singles'))}renderRatings();close('#searchOptionsOverlay')}function openSearchOptions(){document.querySelectorAll('[data-search-scope]').forEach(button=>button.classList.toggle('selected',button.dataset.searchScope===ratingScope));$('#searchOptionsOverlay').classList.remove('hidden');document.body.classList.add('modal-open')}
document.addEventListener('contextmenu',e=>{const schedule=e.target.closest('[data-sos-open]');if(schedule){e.preventDefault();openSchedule()}});
$$('.main-tab').forEach(b=>b.onclick=()=>switchPage(b.dataset.page));
document.querySelectorAll('.subtab').forEach(b=>b.onclick=()=>{ratingView=b.dataset.rating;if(ratingView==='pairs'&&ratingScope==='all'){ratingScope='section';localStorage.setItem('brta-rating-scope',ratingScope)}document.querySelectorAll('.subtab').forEach(x=>x.classList.toggle('active',x===b));renderRatings()});
$('#search').oninput=renderRatings;$('#teamFilter').onchange=renderRatings;$('#clubZoneBtn').onclick=openClubPicker;$('#clubPickerOpen').onclick=openChosenClubZone;$('#clubPickerClose').onclick=()=>close('#clubPickerOverlay');$('#clubZoneClose').onclick=()=>close('#clubZoneOverlay');$('#roundBtn').onclick=openRound;$('#settingsBtn').onclick=openSettings;$('#exportSectionBtn').onclick=exportSectionCSV;
$('#profileClose').onclick=()=>close('#profileOverlay');$('#roundClose').onclick=()=>close('#roundOverlay');$('#settingsClose').onclick=()=>close('#settingsOverlay');$('#resultClose').onclick=()=>close('#resultOverlay');
$('#predictionClose').onclick=()=>close('#predictionOverlay');$('#lineupHistoryClose').onclick=()=>close('#lineupHistoryOverlay');$('#sosClose').onclick=()=>close('#sosOverlay');$('#rivalryClose').onclick=()=>close('#rivalryOverlay');$('#searchOptionsBtn').onclick=openSearchOptions;$('#searchOptionsClose').onclick=()=>close('#searchOptionsOverlay');
document.addEventListener('keydown',e=>{if(e.key==='Escape')$$('.overlay:not(.hidden)').forEach(o=>close('#'+o.id))});
window.addEventListener('brta-module-toggle',()=>{
  cancelAuxiliaryReveal();
  if(!auxiliaryEnabled()){auxiliaryCache=null;auxiliaryCacheKey='';if(activeProfilePlayer===window.AuxiliaryModule?.CANONICAL){activeProfilePlayer=null;close('#profileOverlay');$('#profileMatchExplorer')?.classList.add('hidden')}}
  if(D){teamOptions();renderRatings()}
});
async function startApp(){applyProfilePosition();viewCatalog=DATA.catalog||[];setupSelectors();showSyncToast();const saved=readHistorySelection();if(!saved){await loadSection(choiceValue('sectionSelect'));ensureHistoryCatalog();return}const catalog=await ensureHistoryCatalog(),season=catalog?.seasons.find(x=>x.id===saved.seasonId),section=season?.sections.find(x=>x.section_code===saved.sectionCode);if(season&&section){activeHistorySeasonId=season.id;viewCatalog=historySeasonSections(season);setupSelectors();primeArchiveGlobalRows();await loadSection(section.section_code)}else{activeHistorySeasonId=null;viewCatalog=DATA.catalog||[];setupSelectors();await loadSection(choiceValue('sectionSelect'))}}
startApp();
