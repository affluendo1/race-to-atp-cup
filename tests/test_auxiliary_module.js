const assert=require('assert');
const M=require('../auxiliary-module.js');

function section({historical=false,latest=4}={}){
  const rubbers=(home,away,homeEmergency=false,awayEmergency=false)=>[{type:'Singles',position:'No. 1',home,away,homeEmergency,awayEmergency}];
  return{
    meta:{season_id:'UA-test',section_code:'UA001',section_label:'Rubbers 1',competition_code:'UA',is_archive:historical,latest_round:latest},
    sync:{latestRound:latest},
    singles:[
      {player:'Ava Core',team:'North',rating:1750},{player:'Bea Core',team:'South',rating:1650},
      {player:'Cleo Late',team:'East',rating:1550},{player:'Dana Emergency',team:'West',rating:1450},{player:'Erin Early Emergency',team:'North',rating:1500}
    ],
    strengthOfSchedule:[{player:'Ava Core',team:'North',matches:2,averageOpponent:1600,rank:1,total:5}],
    results:[
      {round:1,date:'1 Jan 26',fixtures:[{status:'Completed',date:'1 Jan 26',rubbers:rubbers('Ava Core','Erin Early Emergency',false,true)}]},
      {round:2,date:'8 Jan 26',fixtures:[{status:'Completed',date:'8 Jan 26',rubbers:rubbers('Bea Core','Ava Core')}]},
      {round:3,date:'15 Jan 26',fixtures:[{status:'Completed',date:'15 Jan 26',rubbers:rubbers('Dana Emergency','Bea Core',true,false)}]},
      {round:4,date:'22 Jan 26',fixtures:[{status:'Completed',date:'22 Jan 26',rubbers:rubbers('Cleo Late','Ava Core')}]}
    ],
    upcomingFixtures:Array.from({length:10},(_,index)=>({round:index+5,date:(29+index*7)+' Jan 26',fixtures:[]})),
    ratingHistory:{players:{'Ava Core':[[1,1700,120,1,'North']], 'Bea Core':[[1,1600,120,1,'South']]}}
  };
}

{
  const sections=[{competition_code:'AA',section_code:'AA001'},{competition_code:'UA',section_code:'UA002'},{competition_code:'UA',section_code:'UA001'}];
  assert.strictEqual(M.firstSundaySection(sections).section_code,'UA002');
  assert.strictEqual(M.isHighestSundaySection(sections[1],sections),true);
  assert.strictEqual(M.isHighestSundaySection(sections[2],sections),false);
}
{
  const r=M.roster(section());
  assert.deepStrictEqual(r.core.map(x=>x.player),['Ava Core','Bea Core']);
  assert.deepStrictEqual(r.oneOff.map(x=>x.player),['Cleo Late','Dana Emergency','Erin Early Emergency']);
}
{
  const data=section();
  data.results[2].fixtures[0].rubbers.push({type:'Singles',position:'No. 1',home:'Erin Early Emergency',away:'Ava Core',homeEmergency:false,awayEmergency:false});
  const r=M.roster(data);
  assert.ok(r.core.some(x=>x.player==='Erin Early Emergency'),'a normal early appearance promotes an early emergency to core');
  assert.ok(!r.oneOff.some(x=>x.player==='Erin Early Emergency'));
}
{
  const a=M.generatedSchedule(section()),b=M.generatedSchedule(section());
  assert.deepStrictEqual(a,b,'schedule is stable');
  assert.strictEqual(a.filter(x=>x.player==='Ava Core').length,2);
  assert.strictEqual(a.filter(x=>x.player==='Bea Core').length,2);
  assert.strictEqual(a.filter(x=>x.player==='Cleo Late').length,1);
  assert.strictEqual(a.filter(x=>x.player==='Dana Emergency').length,1);
  assert.strictEqual(a.filter(x=>x.player==='Erin Early Emergency').length,1);
  assert.strictEqual(new Set(a.map(x=>x.fixtureId)).size,a.length);
}
{
  assert.strictEqual(M.scoreFromRandom(0),0);
  assert.strictEqual(M.scoreFromRandom(.899999),0);
  assert.strictEqual(M.scoreFromRandom(.90),1);
  assert.strictEqual(M.scoreFromRandom(.959999),1);
  assert.strictEqual(M.scoreFromRandom(.96),2);
  assert.strictEqual(M.scoreFromRandom(.989999),2);
  assert.strictEqual(M.scoreFromRandom(.99),3);
  assert.strictEqual(M.scoreFromRandom(.999999),3);
}
{
  const current=section({latest:3}),before=JSON.stringify(current),context=M.buildContext(current);
  assert.strictEqual(context.historical,false);
  assert.ok(context.matches.every(match=>match.round<=3),'current only includes published round context');
  assert.strictEqual(JSON.stringify(current),before,'official section data is never mutated');
  assert.strictEqual(context.row.player,'Sid Basa');
  assert.strictEqual(context.row.losses,0);
  assert.strictEqual(context.row.matches,context.matches.length);
  assert.strictEqual(context.row.rating,Math.round(context.row.rating));
  assert.ok(context.row.se>0);
  assert.strictEqual(M.godlyThreshold(context.row),context.row.rating-10,'Godly threshold is Power minus ten');
  assert.ok(context.history.length<=context.matches.length);
}
{
  const first=M.royalScore('fixed-score'),second=M.royalScore('fixed-score');
  assert.deepStrictEqual(first,second,'best-of-three scores are stable');
  const scores=Array.from({length:200},(_,index)=>M.royalScore('straight-'+index));
  assert.ok(scores.every(score=>score.sets.length===2&&score.sets.every(([a,b])=>a===6&&b>=0&&b<=3)),'Sid wins every set 6-x');
  assert.ok(scores.every(score=>score.matchTiebreak===null&&score.setsLost===0&&score.score.split(' ').length===2),'Sid never drops a set or reaches a deciding tiebreak');
}
{
  assert.deepStrictEqual(M.teamChoices(['North','South'],true),['North','South','Kings Park']);
  assert.deepStrictEqual(M.teamChoices(['North','Kings Park'],true),['North','Kings Park'],'real Kings Park is never duplicated');
  assert.deepStrictEqual(M.teamChoices(['North'],false),['North'],'the neutral team option is gated');
}
{
  const historical=M.buildContext(section({historical:true,latest:1}));
  assert.strictEqual(historical.matches.length,historical.all.length,'historical season is complete');
  assert.ok(historical.matches.every(match=>match.gf>=8&&match.ga>=0&&match.score.split(' ').length>=2));
  assert.ok(historical.sos.some(row=>row.player==='Sid Basa'));
  assert.ok(historical.sos.some(row=>row.player==='Ava Core'));
}
{
  const base={extras:true,page:'ratings',scope:'section',view:'singles',team:'Kings Park',query:'Sid Basa',section:{section_code:'UA001'},sections:[{competition_code:'UA',section_code:'UA001'}]};
  assert.strictEqual(M.discoveryState(base),true);
  for(const key of ['extras','team','query']){
    const value=base[key];base[key]=key==='extras'?false:key==='team'?'Other':'Sid Bas';assert.strictEqual(M.discoveryState(base),false);base[key]=value;
  }
  assert.strictEqual(M.discoveryState({...base,scope:'all'}),false);
  assert.strictEqual(M.exactAlias(' Sid Basa '),'Sid Basa');
  assert.strictEqual(M.exactAlias('Sid Bas'),null);
  assert.strictEqual(M.delayedAlias('Sid Basa'),false);
  assert.strictEqual(M.delayedAlias('Siddharth Basa'),true);
}
console.log('auxiliary module tests passed');
