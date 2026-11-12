import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sortVideos, visibleVideos, matchingChapters, removeFolder, folderTrail, filename } from '../src/library.ts';
import type { LibraryDocument, Video } from '../src/library.ts';
const make = (id: string, name: string, path: string, folderId: string | null, addedAt: number): Video => ({id,name,path,folderId,addedAt,modifiedAt:addedAt,chapters:[]});
const a = {...make('a','Zebra','/set2.mp4','child',100),chapters:[{id:'s',name:'Opening Scene',start:10,end:50}]};
const b = make('b','Alpha','C:\\videos\\set10.mp4',null,200);
const c = make('c','Beta','/set1.mp4','parent',0);
const doc: LibraryDocument = {version:2,videos:[a,b,c],folders:[{id:'parent',name:'Weekend',parentId:null,createdAt:1},{id:'child',name:'Morning',parentId:'parent',createdAt:2}]};
test('sorts by friendly name separately from natural filename order',()=>{
 assert.deepEqual(sortVideos(doc.videos,'friendly',false).map(v=>v.id),['b','c','a']);
 assert.deepEqual(sortVideos(doc.videos,'filename',false).map(v=>v.id),['c','a','b']);
 assert.deepEqual(sortVideos(doc.videos,'friendly',true).map(v=>v.id),['a','c','b']);
 assert.equal(filename(b.path),'set10.mp4');
});
test('sorts dates while keeping unknown legacy dates last',()=>{
 assert.deepEqual(sortVideos(doc.videos,'added',true).map(v=>v.id),['b','a','c']);
 assert.deepEqual(sortVideos(doc.videos,'modified',false).map(v=>v.id),['a','b','c']);
});
test('chapter search finds results across folders and preserves the jump range',()=>{
 assert.deepEqual(visibleVideos(doc,null,'opening').map(v=>v.id),['a']);
 assert.equal(matchingChapters(a,' OPENING ')[0].start,10);
 assert.deepEqual(visibleVideos(doc,null,'set10').map(v=>v.id),['b']);
});
test('folder browsing shows direct videos and all-videos view spans folders',()=>{
 assert.deepEqual(visibleVideos(doc,null,'').map(v=>v.id),['b']);
 assert.deepEqual(visibleVideos(doc,'parent','').map(v=>v.id),['c']);
 assert.equal(visibleVideos(doc,undefined,'').length,3);
 assert.deepEqual(folderTrail(doc.folders,'child').map(f=>f.name),['Weekend','Morning']);
});
test('deleting a folder moves its children up without losing files or chapter markers',()=>{
 const next=removeFolder(doc,'parent');
 assert.equal(next.folders[0].parentId,null);
 assert.equal(next.videos.find(v=>v.id==='c')!.folderId,null);
 assert.deepEqual(next.videos.find(v=>v.id==='a')!.chapters,a.chapters);
 assert.equal(next.videos[0].path,a.path);
 assert.equal(doc.folders.length,2);
});
