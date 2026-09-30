import {derive} from './derive.js';
import {assertValid} from './validation.js';
let cachedKey=null,cachedValue=null;
self.onmessage=({data:{data,seasonId,requestId}})=>{try{const key=JSON.stringify([data,seasonId]);if(key!==cachedKey){assertValid(data);cachedValue=derive(data,seasonId);cachedKey=key;}self.postMessage({requestId,value:cachedValue});}catch(e){self.postMessage({requestId,error:e.message});}};
