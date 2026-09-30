/*
 * Lazy, read-only derived-player support.  Nothing in this file writes to a
 * section payload: it receives a snapshot and returns a separate context.
 */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  root.AuxiliaryModule=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  const VERSION='m1',SCORE_VERSION='m2-straight-sets';
  const DISPLAY_CENTRE=1500,DISPLAY_SCALE=600,GAME_SCALE=.75,L2=5;
  const CANONICAL='Sid Basa',ALIASES=new Set(['Sid Basa','Siddharth Basa','Siddharth R. Basa']);
  const KINGS_PARK='Kings Park';

  function text(value){return String(value??'').trim()}
  function hash(value){let h=2166136261;for(const char of String(value)){h^=char.charCodeAt(0);h=Math.imul(h,16777619)}return h>>>0}
  function random(seed){return hash(seed)/4294967296}
  function shuffled(rows,seed){const out=rows.slice();for(let i=out.length-1;i>0;i--){const j=Math.floor(random(seed+'|'+i)*(i+1));[out[i],out[j]]=[out[j],out[i]]}return out}
  function logistic(value){return value>=0?1/(1+Math.exp(-value)):Math.exp(value)/(1+Math.exp(value))}
  function scoreFromRandom(value){return value<.90?0:value<.96?1:value<.99?2:3}
  function royalScore(seed){
    const first=scoreFromRandom(random(SCORE_VERSION+'|'+seed+'|set-one')),
      second=scoreFromRandom(random(SCORE_VERSION+'|'+seed+'|set-two')),
      sets=[[6,first],[6,second]];
    return{sets,matchTiebreak:null,setsWon:2,setsLost:0,gamesFor:12,gamesAgainst:first+second,score:sets.map(set=>set.join('-')).join(' ')};
  }
  function validPlayer(value){const name=text(value);return !!name&&/[A-Za-z]/.test(name)&&!/(?:^|\s)(?:bye|unknown|tbc|none|null)(?:\s|$)/i.test(name)}
  function dateValue(value){
    const match=text(value).match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2,4})$/);
    if(!match)return null;
    const month={jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11}[match[2].toLowerCase()];
    if(month==null)return null;
    let year=Number(match[3]);if(year<100)year+=2000;
    return Date.UTC(year,month,Number(match[1]));
  }
  function firstSundaySection(sections){return(sections||[]).find(section=>text(section.competition_code)==='UA'||/^Sunday AM\b/i.test(text(section.competition_label)))||null}
  function isHighestSundaySection(section,sections){const highest=firstSundaySection(sections);return !!highest&&text(highest.section_code)===text(section?.section_code)}
  function exactAlias(value){return ALIASES.has(text(value))?text(value):null}
  function delayedAlias(value){const alias=exactAlias(value);return alias&&alias!==CANONICAL}
  function teamChoices(names,enabled){const rows=[...(names||[])];return enabled&&!rows.includes(KINGS_PARK)?[...rows,KINGS_PARK]:rows}
  function godlyThreshold(row){return Number(row?.rating)-10}
  function discoveryState(state){
    return !!state?.extras&&state.page==='ratings'&&state.scope==='section'&&state.view==='singles'&&
      isHighestSundaySection(state.section,state.sections)&&text(state.team)===KINGS_PARK&&!!exactAlias(state.query);
  }
  function playerParts(name,flags){
    return text(name).split('/').map((part,index)=>({name:text(part),emergency:Array.isArray(flags)?!!flags[index]:!!flags})).filter(item=>validPlayer(item.name));
  }
  function appearances(section){
    const rows=[];
    for(const round of section?.results||[]){
      const number=Number(round.round);if(!Number.isFinite(number))continue;
      for(const fixture of round.fixtures||[])for(const rubber of fixture.rubbers||[]){
        for(const side of [['home','homeEmergency','homeEmergencies'],['away','awayEmergency','awayEmergencies']]){
          for(const player of playerParts(rubber[side[0]],rubber[side[2]]??rubber[side[1]]))rows.push({player:player.name,emergency:player.emergency,round:number,date:fixture.date||round.date||'',type:rubber.type||''});
        }
      }
    }
    return rows.sort((a,b)=>a.round-b.round||a.player.localeCompare(b.player));
  }
  function roster(section){
    const people=new Map();
    for(const item of appearances(section)){
      const row=people.get(item.player)||{player:item.player,firstRound:item.round,firstDate:item.date,earlyNormal:false};
      if(item.round<row.firstRound){row.firstRound=item.round;row.firstDate=item.date}
      if(item.round<=3&&!item.emergency)row.earlyNormal=true;
      people.set(item.player,row);
    }
    const core=[],oneOff=[];
    for(const row of people.values())(row.firstRound<=3&&row.earlyNormal?core:oneOff).push(row);
    return{core:core.sort((a,b)=>a.player.localeCompare(b.player)),oneOff:oneOff.sort((a,b)=>a.player.localeCompare(b.player)),people};
  }
  function roundCalendar(section){
    const dates=new Map(),rounds=new Set();
    for(const group of [...(section?.results||[]),...(section?.upcomingFixtures||[])]){
      const round=Number(group.round);if(Number.isFinite(round)){rounds.add(round);if(group.date)dates.set(round,group.date)}
      for(const fixture of group.fixtures||[]){const number=Number(fixture.round??round);if(Number.isFinite(number)){rounds.add(number);if(fixture.date)dates.set(number,fixture.date)}}
    }
    return{dates,rounds:[...rounds].sort((a,b)=>a-b)};
  }
  function sectionIdentity(section){return text(section?.meta?.season_id||section?.season_id)+'|'+text(section?.meta?.section_code||section?.section_code)}
  function generatedSchedule(section){
    const id=sectionIdentity(section),pool=roster(section),calendar=roundCalendar(section);
    const core=shuffled(pool.core.flatMap(person=>[1,2].map(meeting=>({...person,meeting,kind:'core'}))),VERSION+'|'+id+'|schedule');
    const usable=calendar.rounds.filter(round=>round>=3)||[];
    const fallbackMax=Math.max(14,...calendar.rounds,3),span=usable.length?usable:Array.from({length:Math.max(1,fallbackMax-2)},(_,i)=>i+3);
    const rows=core.map((person,index)=>{
      const round=span[Math.min(span.length-1,Math.floor((index+.5)*span.length/core.length))];
      return{...person,round,date:calendar.dates.get(round)||null};
    });
    for(const person of pool.oneOff){
      const round=person.firstRound;
      rows.push({...person,meeting:1,kind:'oneoff',round,date:calendar.dates.get(round)||person.firstDate||null});
    }
    return rows.map((row,index)=>{
      const key=VERSION+'|'+id+'|'+row.kind+'|'+row.player+'|'+row.meeting;
      return{...row,index,fixtureId:'derived-'+hash(key).toString(36),...royalScore(key),seed:key};
    }).sort((a,b)=>a.round-b.round||a.index-b.index||a.player.localeCompare(b.player));
  }
  function latestPublishedRound(section){
    const sync=Number(section?.sync?.latestRound??section?.meta?.latest_round);if(Number.isFinite(sync)&&sync>0)return sync;
    return Math.max(0,...(section?.results||[]).filter(round=>(round.fixtures||[]).some(fixture=>fixture.status==='Completed')).map(round=>Number(round.round)||0));
  }
  function fixedRating(section,name,round){
    const history=section?.ratingHistory?.players?.[name]||[];
    const snapshot=[...history].reverse().find(row=>Number(row[0])<Number(round));
    if(snapshot&&Number.isFinite(Number(snapshot[1])))return Number(snapshot[1]);
    const row=(section?.singles||[]).find(item=>item.player===name);
    return Number.isFinite(Number(row?.rating))?Number(row.rating):1500;
  }
  function fit(matches,referenceDate){
    let theta=1.5,hessian=-L2;
    for(let step=0;step<32;step++){
      let gradient=-L2*theta;hessian=-L2;
      for(const match of matches){
        const dated=dateValue(match.date),age=dated&&referenceDate?Math.max(0,(referenceDate-dated)/86400000):0,weight=Math.pow(2,-age/365);
        const opponent=(match.opponentRating-DISPLAY_CENTRE)/DISPLAY_SCALE,p=logistic((theta-opponent)/GAME_SCALE),games=match.gamesFor+match.gamesAgainst;
        gradient+=weight*(match.gamesFor*(1-p)-match.gamesAgainst*p)/GAME_SCALE;
        hessian-=weight*games*p*(1-p)/(GAME_SCALE*GAME_SCALE);
      }
      const next=Math.max(-4,Math.min(8,theta-gradient/hessian));
      if(Math.abs(next-theta)<1e-8){theta=next;break}theta=next;
    }
    let curvature=-L2;
    for(const match of matches){const dated=dateValue(match.date),age=dated&&referenceDate?Math.max(0,(referenceDate-dated)/86400000):0,weight=Math.pow(2,-age/365),opponent=(match.opponentRating-DISPLAY_CENTRE)/DISPLAY_SCALE,p=logistic((theta-opponent)/GAME_SCALE),games=match.gamesFor+match.gamesAgainst;curvature-=weight*games*p*(1-p)/(GAME_SCALE*GAME_SCALE)}
    return{theta,power:Math.round(DISPLAY_CENTRE+DISPLAY_SCALE*theta),se:Math.max(1,Math.round(DISPLAY_SCALE*Math.sqrt(-1/curvature)))};
  }
  function buildContext(section){
    const all=generatedSchedule(section),historical=!!section?.meta?.is_archive,cutoff=historical?Infinity:latestPublishedRound(section);
    const completed=all.filter(match=>match.round<=cutoff).map(match=>({...match,opponentRating:fixedRating(section,match.player,match.round)}));
    const reference=Math.max(...completed.map(match=>dateValue(match.date)||0),0)||null,fitResult=fit(completed,reference),matches=[];
    for(const match of completed){
      const before=fit(matches,dateValue(match.date)||reference),theta=(before.power-DISPLAY_CENTRE)/DISPLAY_SCALE,opponent=(match.opponentRating-DISPLAY_CENTRE)/DISPLAY_SCALE,p=logistic((theta-opponent)/GAME_SCALE);
      const performance=Math.round(match.opponentRating+450*Math.log((match.gamesFor+.5)/(match.gamesAgainst+.5)));
      matches.push({...match,opp:match.player,gf:match.gamesFor,ga:match.gamesAgainst,won:true,expectedWinProbability:p,performance,performanceDelta:performance-before.power,position:1,result:'W',ratingAtTime:before.power,opponentRatingAtTime:match.opponentRating});
    }
    const gf=matches.reduce((sum,match)=>sum+match.gf,0),ga=matches.reduce((sum,match)=>sum+match.ga,0),row={player:CANONICAL,team:KINGS_PARK,rating:fitResult.power,se:fitResult.se,matches:matches.length,wins:matches.length,losses:0,gf,ga,qualified:true,synthetic:true};
    const history=[];for(const round of [...new Set(matches.map(match=>match.round))].sort((a,b)=>a-b)){const slice=matches.filter(match=>match.round<=round),ref=Math.max(...slice.map(match=>dateValue(match.date)||0),0)||null,result=fit(slice,ref);history.push([round,result.power,result.se,slice.length,KINGS_PARK])}
    const rivalries=new Map();for(const match of matches){const rival=rivalries.get(match.opp)||{opponent:match.opp,rows:[],wins:0,gamesFor:0,gamesAgainst:0,expected:0};rival.rows.push(match);rival.wins++;rival.gamesFor+=match.gf;rival.gamesAgainst+=match.ga;rival.expected+=match.expectedWinProbability;rivalries.set(match.opp,rival)}
    const rivalryList=[...rivalries.values()].map(rival=>({...rival,record:rival.wins+'–0',matches:rival.rows.length,winsAboveExpected:rival.wins-rival.expected})).sort((a,b)=>b.matches-a.matches||a.opponent.localeCompare(b.opponent));
    const expected=matches.reduce((sum,match)=>sum+match.expectedWinProbability,0),deltas=matches.map(match=>match.performanceDelta),mean=deltas.length?deltas.reduce((a,b)=>a+b,0)/deltas.length:0,variance=deltas.length>1?deltas.reduce((sum,value)=>sum+(value-mean)**2,0)/deltas.length:0;
    const deciding=matches.filter(match=>match.matchTiebreak).length;
    const insight={team:KINGS_PARK,roundsPlayed:new Set(matches.map(match=>match.round)).size,teamCompletedTies:matches.length,availabilityPercent:null,averageListedPosition:'1.0',emergencyAppearances:0,positions:matches.length?[{position:1,matches:matches.length,wins:matches.length,record:matches.length+'–0',gamesFor:gf,gamesAgainst:ga,gameShare:gf+ga?Math.round(100*gf/(gf+ga)):0,expectedWins:expected.toFixed(1)}]:[],rivalries:rivalryList,consistency:{matches:matches.length,averagePerformanceDelta:Number(mean.toFixed(1)),volatility:Math.sqrt(variance),score:Math.max(0,Math.round(100-Math.sqrt(variance)*4))},scoreProfile:{straightSetMatches:matches.length-deciding,scoredMatches:matches.length,setsWon:matches.reduce((sum,match)=>sum+match.setsWon,0),setsLost:matches.reduce((sum,match)=>sum+match.setsLost,0),tiebreaksWon:deciding,tiebreaksLost:0,decidingWins:deciding,decidingLosses:0}};
    const sos=[...(section?.strengthOfSchedule||[]).map(item=>({...item})),{player:CANONICAL,team:KINGS_PARK,matches:matches.length,averageOpponent:matches.length?Math.round(matches.reduce((sum,match)=>sum+match.opponentRating,0)/matches.length):0,synthetic:true}].sort((a,b)=>b.averageOpponent-a.averageOpponent||a.player.localeCompare(b.player));
    sos.forEach((item,index)=>item.rank=index+1);const schedule=sos.find(item=>item.player===CANONICAL);if(schedule)schedule.total=sos.length;
    return{row,matches,history,insight,rivalries:rivalryList,schedule,sos,all,core:roster(section).core,oneOff:roster(section).oneOff,historical,cutoff,sectionLabel:text(section?.meta?.section_label||section?.section_label)};
  }
  return{CANONICAL,ALIASES,KINGS_PARK,VERSION,random,scoreFromRandom,royalScore,firstSundaySection,isHighestSundaySection,exactAlias,delayedAlias,teamChoices,godlyThreshold,discoveryState,roster,generatedSchedule,buildContext,fit,latestPublishedRound};
});
