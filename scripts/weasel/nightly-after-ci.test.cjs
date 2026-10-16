'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {validateTrigger,decideDispatch}=require('./nightly-after-ci.cjs');
const source='a'.repeat(40),other='b'.repeat(40);
const run={id:123,repository:{full_name:'morrowbyte/t3code'},head_repository:{full_name:'morrowbyte/t3code'},event:'push',head_branch:'main',path:'.github/workflows/weasel-ci.yml',status:'completed',conclusion:'success',head_sha:source};
const state=()=>({source,main:source,statuses:[],runs:[],runCount:0,releases:[]});
test('only successful normal main-push CI qualifies',()=>{
  assert.equal(validateTrigger(run,'morrowbyte/t3code'),source);
  const {repository: omitted, ...webhookRun}=run; assert.equal(validateTrigger(webhookRun,'morrowbyte/t3code'),source);
  for(const delta of [{event:'pull_request'},{event:'workflow_dispatch'},{head_branch:'weasel/check'},{conclusion:'failure'},{repository:{full_name:'foreign/repo'}}])assert.throws(()=>validateTrigger({...run,...delta},'morrowbyte/t3code'));
});
test('one eligible source without intent requests dispatch',()=>assert.equal(decideDispatch(state()).action,'dispatch'));
test('main advancing does not release unpinned source',()=>assert.equal(decideDispatch({...state(),main:other}).action,'skip'));
test('persisted intent without visible run fails closed for every marker state',()=>{
  for(const markerState of ['pending','success','error','failure'])assert.equal(decideDispatch({...state(),statuses:[{context:'weasel/nightly-dispatch',state:markerState}]}).action,'stop');
});
test('existing exact run is reconciled, never dispatched again',()=>{
  const release={id:456,head_sha:source,path:'.github/workflows/weasel-release.yml',event:'workflow_dispatch',head_branch:'main'};
  assert.equal(decideDispatch({...state(),runs:[release],runCount:1}).action,'reconcile');
  assert.throws(()=>decideDispatch({...state(),runs:[release,{...release,id:457}],runCount:2}));
  const published={id:789,target_commitish:source,draft:false,published_at:'2026-10-16T18:00:00Z'};
  assert.equal(decideDispatch({...state(),releases:[published]}).reason,'source-already-published');
  assert.equal(decideDispatch({...state(),releases:[{...published,target_commitish:other}]}).action,'dispatch');
  assert.equal(decideDispatch({...state(),releases:[{...published,draft:true}]}).action,'dispatch');
});
test('truncated observations cannot clear intent or invent a unique run',()=>{
  assert.throws(()=>decideDispatch({...state(),statuses:Array(100).fill({context:'unrelated'})}));
  assert.throws(()=>decideDispatch({...state(),runCount:1}));
  assert.throws(()=>decideDispatch({...state(),releases:undefined}));
});
