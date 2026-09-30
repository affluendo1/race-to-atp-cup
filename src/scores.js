import {DEFAULT_RULES} from './config.js';
const normalSet = (a,b) => Number.isInteger(a)&&Number.isInteger(b)&&Math.min(a,b)>=0&&((Math.max(a,b)===6&&Math.min(a,b)<=4)||(Math.max(a,b)===7&&[5,6].includes(Math.min(a,b))));
export function parseScore(text,type='singles',status='completed',winner=null) {
 if(!['singles','doubles'].includes(type))throw Error('Unknown rubber type.');
 if(!['completed','retirement','walkover','default'].includes(status))throw Error('Unknown rubber status.');
 if(status!=='completed'&&!['home','away'].includes(winner))throw Error('A retirement, walkover or default needs an explicit winner.');
 const tokens=String(text||'').trim().replace(/,/g,' ').split(/\s+/).filter(Boolean),sets=[];let matchTiebreak=null,hs=0,as=0;
 if(['walkover','default'].includes(status)&&tokens.length)throw Error('Walkovers and defaults must have an empty score.');
 for(let i=0;i<tokens.length;i++) {
  if(hs===2||as===2)throw Error('The score continues after the rubber was won.');
  const tb=tokens[i].match(/^\[(\d+)-(\d+)\]$/),m=tokens[i].match(/^(\d+)-(\d+)(?:\((\d+)\))?$/);
  if(tb) {
   const a=Number(tb[1]),b=Number(tb[2]);
   if(type!=='doubles'||hs!==1||as!==1||i!==2||i!==tokens.length-1)throw Error('A doubles match tiebreak must follow two split sets.');
   if(Math.max(a,b)<10||Math.abs(a-b)<2||(Math.max(a,b)>10&&Math.abs(a-b)!==2))throw Error('Match tiebreak must reach 10 and finish with a two-point margin.');
   matchTiebreak={home:a,away:b};hs+=a>b;as+=b>a;
  } else if(m) {
   const a=Number(m[1]),b=Number(m[2]),detail=m[3]===undefined?null:Number(m[3]);
   const partial=status==='retirement'&&i===tokens.length-1&&!normalSet(a,b);
   if(!normalSet(a,b)&&!(partial&&a>=0&&b>=0&&a<=6&&b<=6&&Math.abs(a-b)<=5))throw Error(`Impossible set score: ${tokens[i]}.`);
   if(detail!==null&&(![a,b].includes(7)||![a,b].includes(6)))throw Error('Tiebreak detail is only valid for a 7–6 set.');
   if(type==='doubles'&&i>=2)throw Error('Doubles uses a [10–x] match tiebreak instead of a third normal set.');
   sets.push({home:a,away:b,tiebreakLoser:detail,complete:!partial});if(!partial){hs+=a>b;as+=b>a;}
  } else throw Error(`Unrecognised score: ${tokens[i]}. Use 6-4 3-6 6-2 or 6-4 3-6 [10-7].`);
 }
 if(status==='completed'&&hs!==2&&as!==2)throw Error('A completed rubber needs two sets won.');
 const derived=hs===2?'home':as===2?'away':winner;
 if(winner&&status==='completed'&&winner!==derived)throw Error('Winner conflicts with the entered score.');
 return {sets,matchTiebreak,status,winner:status==='completed'?derived:winner};
}
export function scoreText(r) {return [...(r.sets||[]).map(s=>`${s.home}-${s.away}${s.tiebreakLoser!=null?'('+s.tiebreakLoser+')':''}`),...(r.matchTiebreak?[`[${r.matchTiebreak.home}-${r.matchTiebreak.away}]`]:[])].join(' ');}
export function scoreTotals(r,rules=DEFAULT_RULES) {
 let sets=[0,0],games=[0,0];
 for(const s of r.sets||[]){games[0]+=s.home;games[1]+=s.away;if(s.complete!==false){sets[0]+=s.home>s.away;sets[1]+=s.away>s.home;}}
 if(r.matchTiebreak){const side=r.matchTiebreak.home>r.matchTiebreak.away?0:1;sets[side]++;games[side]+=rules.rating.matchTiebreakGames;}
 return {sets,games,winner:r.winner};
}
export function fixtureResult(f,rules=DEFAULT_RULES) {
 const rubbers=[0,0],sets=[0,0],games=[0,0];
 for(const r of f.rubbers||[]){if(!r.winner)continue;rubbers[r.winner==='home'?0:1]++;const t=scoreTotals(r,rules);for(let i=0;i<2;i++){sets[i]+=t.sets[i];games[i]+=t.games[i];}}
 const complete=(f.rubbers||[]).length===rules.singlesRubbers+rules.doublesRubbers&&(f.rubbers||[]).every(r=>['home','away'].includes(r.winner));
 let winner=null,decidedBy=null;
 if(complete){for(const [label,a] of [['rubbers',rubbers],['sets',sets],['games',games]])if(a[0]!==a[1]){winner=a[0]>a[1]?'home':'away';decidedBy=label;break;}
 if(!winner){if(f.stage!=='regular'){winner=['home','away'].includes(f.manualWinner)?f.manualWinner:null;decidedBy=winner?'manual':'requires-procedure';}else decidedBy='draw';}}
 return {rubbers,sets,games,winner,decidedBy,complete,draw:complete&&decidedBy==='draw'};
}
export function normalizeRubber(r) {return {...r,...parseScore(r.score??scoreText(r),r.type,r.status||'completed',r.winner||null),score:undefined};}
