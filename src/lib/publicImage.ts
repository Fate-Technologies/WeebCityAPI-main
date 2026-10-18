import {lookup} from 'node:dns/promises';
import {request} from 'node:https';
import ipaddr from 'ipaddr.js';

export function publicAddress(address:string):boolean {
  try{return ipaddr.process(address).range()==='unicast';}catch{return false;}
}
export function publicImageUrl(value:string):URL {
  const url=new URL(value);
  if(value.length>2048||url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443'))throw new Error('Unsupported image URL');
  if([...url.searchParams.keys()].some(k=>/token|signature|credential|authorization|^sig$|^key$|^auth$/i.test(k))||/\/storage\/v1\/object\/(?!public\/)/.test(url.pathname))throw new Error('Private images are not shared-cacheable');
  return url;
}
export function rasterType(body:Buffer):string|null {
  if(body.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))return 'image/png';
  if(body[0]===255&&body[1]===216&&body[2]===255)return 'image/jpeg';
  if(['GIF87a','GIF89a'].includes(body.subarray(0,6).toString()))return 'image/gif';
  if(body.subarray(0,4).toString()==='RIFF'&&body.subarray(8,12).toString()==='WEBP')return 'image/webp';
  if(body.subarray(4,8).toString()==='ftyp'&&/avif|avis/.test(body.subarray(8,32).toString()))return 'image/avif';
  return null;
}

/** Pin validated DNS answers to the connection, including every redirect hop. */
export async function fetchPublicImage(value:string,deadline=Date.now()+10_000,hops=0):Promise<{body:Buffer;type:string;cacheable:boolean}> {
  if(hops>3||Date.now()>=deadline)throw new Error('Image deadline exceeded');
  const url=publicImageUrl(value),host=url.hostname.replace(/^\[|\]$/g,'');
  let timer:ReturnType<typeof setTimeout>;
  const addresses=await Promise.race([lookup(host,{all:true,verbatim:true}),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Image DNS deadline')),Math.min(2000,deadline-Date.now()));})]).finally(()=>clearTimeout(timer));
  if(!addresses.length||addresses.some(a=>!publicAddress(a.address)))throw new Error('Image address is not public');
  const selected=addresses[0];
  const result=await new Promise<{body:Buffer;type:string;cacheable:boolean;redirect?:string}>((resolve,reject)=>{
    const req=request(url,{headers:{Accept:'image/avif,image/webp,image/png,image/jpeg,image/gif','Accept-Encoding':'identity','User-Agent':'Tatakai-Image-Cache/1.0'},lookup:(_hostname,options,callback)=>{
      // Node may request all answers for automatic family selection.
      if(typeof options==='object'&&options.all)(callback as any)(null,[selected]);
      else (callback as any)(null,selected.address,selected.family);
    }},res=>{
      if([301,302,303,307,308].includes(res.statusCode??0)&&res.headers.location){res.destroy();resolve({body:Buffer.alloc(0),type:'',cacheable:false,redirect:new URL(res.headers.location!,url).href});return;}
      if(res.statusCode!==200){res.destroy();reject(new Error('Image upstream unavailable'));return;}
      if(Number(res.headers['content-length']||0)>4*1024*1024){res.destroy();reject(new Error('Image too large'));return;}
      const chunks:Buffer[]=[];let size=0;
      res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>4*1024*1024){res.destroy(new Error('Image too large'));return;}chunks.push(chunk);});
      res.on('error',reject);
      res.on('end',()=>{const body=Buffer.concat(chunks),type=rasterType(body);if(!type){reject(new Error('Unsupported image format'));return;}
        resolve({body,type,cacheable:!res.headers['set-cookie']&&!/private|no-store/i.test(String(res.headers['cache-control']||''))&&!/cookie|authorization/i.test(String(res.headers.vary||''))});});
    });
    const timeout=setTimeout(()=>req.destroy(new Error('Image deadline exceeded')),Math.max(1,deadline-Date.now()));
    req.on('error',reject);req.on('close',()=>clearTimeout(timeout));req.end();
  });
  return result.redirect?fetchPublicImage(result.redirect,deadline,hops+1):result;
}
