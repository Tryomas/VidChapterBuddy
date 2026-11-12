import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseTime,formatTime,validateChapter} from '../src/time.ts';
test('parses chapter timestamps including hours',()=>{assert.equal(parseTime('1:02:30'),3750);assert.equal(parseTime('3:45'),225);assert.equal(formatTime(3750),'1:02:30');});
test('rejects malformed timestamps',()=>{for(const t of ['','1:70','-1','a','1:2:3:4'])assert.throws(()=>parseTime(t));});
test('requires a named range within the video',()=>{validateChapter({name:'Chapter',start:5,end:10},20);for(const s of [{name:'',start:0,end:3},{name:'Chapter',start:8,end:7},{name:'Chapter',start:0,end:25}])assert.throws(()=>validateChapter(s,20));});
