import {Hono} from 'hono';
import {createHash} from 'node:crypto';
import {cacheRedisClient} from '../lib/cacheStore.js';
import {fetchPublicImage,publicImageUrl} from '../lib/publicImage.js';
import {recordCache} from '../lib/metrics.js';

export const profileImagesRouter=new Hono();
const pending=new Map<string,Promise<Awaited<ReturnType<typeof fetchPublicImage>>>>();
profileImagesRouter.get('/profile',async c=>{
  const value=c.req.query('url')||'';
  try{publicImageUrl(value);}catch{return c.json({error:'Unsupported public image URL'},400);}
  const key='profile-image:v1:'+createHash('sha256').update(value).digest('hex');
  const redis=cacheRedisClient();
  const headers={'Content-Type':'image/jpeg','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'cross-origin','Cache-Control':'public, max-age=3600'};
  try{
    const cached=await redis?.getBuffer(key).catch(()=>null);
    if(cached){const split=cached.indexOf(10);if(split>0&&split<64){recordCache('hit');return new Response(new Uint8Array(cached.subarray(split+1)),{headers:{...headers,'Content-Type':cached.subarray(0,split).toString(),'X-Tatakai-Image-Cache':'HIT'}});}}
    recordCache('miss');
    let work=pending.get(key);
    if(!work){if(pending.size>=8)return c.json({error:'Image service busy'},503);work=fetchPublicImage(value);pending.set(key,work);}
    let image;try{image=await work;}finally{if(pending.get(key)===work)pending.delete(key);}
    // Redis has its own bounded evictable memory budget; never retain image
    // buffers in the application's JSON fallback when Redis is unavailable.
    if(image.cacheable&&image.body.length<=2*1024*1024)await redis?.set(key,Buffer.concat([Buffer.from(image.type+'\n'),image.body]),'EX',3600).catch(()=>null);
    return new Response(new Uint8Array(image.body),{headers:{...headers,'Content-Type':image.type,'Cache-Control':image.cacheable?'public, max-age=3600':'private, no-store','X-Tatakai-Image-Cache':'MISS'}});
  }catch{return c.json({error:'Image unavailable'},502);}
});
