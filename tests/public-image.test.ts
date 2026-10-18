import {test,expect} from 'bun:test';
import {publicAddress,publicImageUrl,rasterType,fetchPublicImage} from '../src/lib/publicImage';
test('image connections reject private, mapped, metadata and special-use addresses',()=>{
 for(const address of ['127.0.0.1','10.0.0.2','169.254.169.254','172.16.1.1','192.168.1.1','100.64.0.1','::1','fc00::1','fe80::1','::ffff:127.0.0.1','224.0.0.1','2001:db8::1'])expect(publicAddress(address)).toBe(false);
 expect(publicAddress('8.8.8.8')).toBe(true);expect(publicAddress('2606:4700:4700::1111')).toBe(true);
});
test('signed and authenticated media are never shared-cacheable',()=>{
 for(const url of ['https://user:pass@example.com/x','https://example.com:444/x','https://example.com/x?token=secret','https://example.com/x?X-Amz-Signature=secret','https://example.com/storage/v1/object/authenticated/x'])expect(()=>publicImageUrl(url)).toThrow();
 expect(publicImageUrl('https://example.com/avatar.png?size=128').searchParams.get('size')).toBe('128');
});
test('raster signatures reject HTML and SVG regardless of the content-type header',()=>{
 expect(rasterType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
 expect(rasterType(Buffer.from('<html>error</html>'))).toBeNull();
 expect(rasterType(Buffer.from('GIF89a'))).toBe('image/gif');
});
test('private destinations are rejected before connecting',async()=>{
 await expect(fetchPublicImage('https://127.0.0.1/avatar.png')).rejects.toThrow('not public');
});
