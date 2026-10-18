import {env} from '../config/env.js';
let inFlight=0;
export function captureApiTiming(route:string,seconds:number,status:number) {
  if(!env.POSTHOG_KEY || !env.POSTHOG_HOST || inFlight>=2 || Math.random()>.05)return;
  let url: URL;
  try { url = new URL('/capture/',env.POSTHOG_HOST); if(url.protocol !== 'https:' && url.hostname !== 'localhost') return; }
  catch { return; }
  inFlight++;
  void fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({api_key:env.POSTHOG_KEY,event:'api_request',properties:{distinct_id:'tatakai-api',$process_person_profile:false,route,duration_seconds:seconds,status_class:Math.floor(status/100)}}),signal:AbortSignal.timeout(1500)}).catch(()=>{}).finally(()=>{inFlight--;});
}
