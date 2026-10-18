import {describe,test,expect} from 'bun:test';
import {Hono} from 'hono';
import {cacheControl} from '../src/middleware/cacheControl';
import {MemoryCache} from '../src/lib/cache';
import {clientIp} from '../src/lib/clientIp';
import {requireAdminSecret} from '../src/middleware/auth';

describe('operations API safeguards',()=> {
  test('private routes, sessions, and error responses are never shared-cacheable',async()=> {
    const app=new Hono();app.use('*',cacheControl);app.get('/api/v3/content/:id',c=>c.json({public:true}));app.get('/api/v3/admin/users',c=>c.json({private:true}));app.get('/api/v3/news/failure',c=>c.json({error:true},503));
    expect((await app.request('/api/v3/content/42')).headers.get('cache-control')).toContain('public');
    expect((await app.request('/api/v3/content/42',{headers:{Authorization:'Bearer user'}})).headers.get('cache-control')).toBe('private, no-store');
    expect((await app.request('/api/v3/content/42',{headers:{Cookie:'session=private'}})).headers.get('cache-control')).toBe('private, no-store');
    expect((await app.request('/api/v3/admin/users')).headers.get('cache-control')).toBe('private, no-store');
    expect((await app.request('/api/v3/news/failure')).headers.get('cache-control')).toBe('private, no-store');
  });
  test('in-memory fallback evicts entries rather than growing indefinitely',()=> {
    const cache=new MemoryCache(2);cache.set('a',1,60);cache.set('b',2,60);cache.set('c',3,60);
    expect(cache.get('a')).toBeNull();expect(cache.get('b')?.hit).toBe(2);expect(cache.get('c')?.hit).toBe(3);
  });
  test('untrusted forwarded headers are not client identity',async()=> {
    const app=new Hono();app.get('/',c=>c.text(clientIp(c)));
    const response=await app.request('/',{headers:{'x-forwarded-for':'attacker','x-real-ip':'198.51.100.1','cf-connecting-ip':'203.0.113.1'}});
    expect(await response.text()).toBe('unknown');
  });
  test('formerly disabled admin gate rejects anonymous requests',async()=> {
    const app=new Hono();app.use('*',requireAdminSecret);app.get('/',c=>c.text('private'));
    expect([401,503]).toContain((await app.request('/')).status);
  });
});
