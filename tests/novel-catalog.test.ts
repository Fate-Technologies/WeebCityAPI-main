import {test,expect,mock} from 'bun:test';
const reads:any[]=[];
mock.module('../src/mirror/db',()=>({prisma:{media:{count:async({where}:any)=>{expect(where.format).toBe('NOVEL');return 1;},findMany:async(args:any)=>{reads.push(args);return [{id:1,type:'MANGA',format:'MANGA',titleRomaji:'Manga'},{id:2,type:'MANGA',format:'NOVEL',titleRomaji:'Novel',averageScore:90,startYear:2025,startMonth:2,startDay:3}].filter(row=>row.format===args.where.format);}}}}));
mock.module('../src/mirror/anilist/searchBackfill',()=>({maybeBackfillSearch:()=>{}}));
const {executeMirror}=await import('../src/mirror/execute');
// Production NovelSearch document: optional date declarations must validate even
// when no year filter is selected. This previously made every fallback a 503.
const query=`query NovelSearch($page: Int, $perPage: Int, $search: String, $genre: String, $tags: [String], $statuses: [MediaStatus], $sort: [MediaSort], $origin: CountryCode, $adult: Boolean, $minDate: FuzzyDateInt, $maxDate: FuzzyDateInt, $minScore: Int, $maxScore: Int) {
 Page(page: $page, perPage: $perPage) {
  pageInfo { currentPage lastPage hasNextPage total }
  media(type: MANGA, format: NOVEL, search: $search, genre: $genre, tag_in: $tags, status_in: $statuses, sort: $sort, countryOfOrigin: $origin, isAdult: $adult, startDate_greater: $minDate, startDate_lesser: $maxDate, averageScore_greater: $minScore, averageScore_lesser: $maxScore) {
   id idMal title { romaji english native } coverImage { large } bannerImage description
   format status startDate { year } averageScore popularity isAdult chapters volumes countryOfOrigin
  }
 }
}`;
test('real novel document validates and keeps top-rated novels separate from manga',async()=>{
 const result:any=await executeMirror(query,{page:1,perPage:24,sort:['SCORE_DESC'],adult:false});
 expect(result.errors).toBeUndefined();expect(result.data.Page.media.map((row:any)=>row.format)).toEqual(['NOVEL']);
 expect(result.data.Page.pageInfo.total).toBe(1);
 expect(reads.at(-1).where).toMatchObject({format:'NOVEL',type:'MANGA',isAdult:false});
 expect(reads.at(-1).orderBy).toEqual([{averageScore:{sort:'desc',nulls:'last'}},{id:'desc'}]);
});
test('newest uses full dates and stable pagination, with unknown dates last',async()=>{
 const result:any=await executeMirror(query,{page:2,perPage:24,sort:['START_DATE_DESC'],minDate:20200000});
 expect(result.errors).toBeUndefined();const call=reads.at(-1);
 expect(call.where.format).toBe('NOVEL');expect(call.where.startYear).toEqual({gte:2020});expect(call.skip).toBe(24);
 expect(call.orderBy).toEqual([{startYear:{sort:'desc',nulls:'last'}},{startMonth:{sort:'desc',nulls:'last'}},{startDay:{sort:'desc',nulls:'last'}},{id:'desc'}]);
});
test('date variables reject invalid non-integer values before reaching the database',async()=>{
 const count=reads.length;const result=await executeMirror(query,{minDate:'2020',sort:['SCORE_DESC']});
 expect(result.errors?.length).toBeGreaterThan(0);expect(reads.length).toBe(count);
});
