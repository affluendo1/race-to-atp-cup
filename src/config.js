/** Default sporting rules only. Administrator-owned overrides live in data/events.json. */
export const ENGINE_VERSION='1.0.0';
export const DEFAULT_RULES = {
 teamCount:18, rosterSize:12, squadSize:8, singlesRubbers:4, doublesRubbers:4,
 rosterSlots:{S:2,C:6,D:4}, regularSeasonRounds:34, finalsTeams:8,
 points:{win:3,draw:1,loss:0},
 standingsTiebreaks:['points','rubberDiff','setDiff','gameDiff','wins'],
 singlesUnique:true, doublesUseWholeSquad:true, allowTransfers:false,
 finals:{surfaces:['hard','indoor-hard'],exactTie:'manual',quarterfinalSeeds:[[1,8],[4,5],[2,7],[3,6]],finalHostOrder:['B','A']},
 rating:{scale:.75,halfLifeDays:365,l2:5,centre:1500,displayScale:600,minMatches:4,matchTiebreakGames:2,includeRetirements:false},
 surfaces:{hard:'Hard','indoor-hard':'Indoor Hard',clay:'Clay',grass:'Grass'},
 classifications:{S:'Singles Player',C:'ATP Cup Player',D:'Doubles Specialist'}
};
export function merge(base, override={}) {
 const out=structuredClone(base);
 for(const [k,v] of Object.entries(override||{}))out[k]=v&&typeof v==='object'&&!Array.isArray(v)&&out[k]&&typeof out[k]==='object'?merge(out[k],v):structuredClone(v);
 return out;
}
export function rulesFor(data, seasonId) {return merge(merge(DEFAULT_RULES,data.config?.rules),data.seasons.find(s=>s.id===seasonId)?.rules);}
export const pairKey = ids => [...ids].sort().join('|');
export const dateValid = s => typeof s==='string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
export function rosterFor(data,seasonId,teamId,date) {return data.rosters.filter(r=>r.seasonId===seasonId&&r.teamId===teamId&&(!date||(!r.startDate||r.startDate<=date)&&(!r.endDate||r.endDate>=date))).sort((a,b)=>a.rosterPosition-b.rosterPosition);}
export function fixtureDefaults(data,f) {
 const s=data.seasons.find(x=>x.id===f.seasonId),t={...data.teams.find(x=>x.id===f.homeTeamId),...s?.teamOverrides?.[f.homeTeamId]};
 return {...f,venue:f.venue||t.venue||'',surface:f.surface||t.homeSurface||null};
}
