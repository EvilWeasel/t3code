#!/usr/bin/env python3
"""Hosted-only fixtures for the actual trusted workflow coordinator blocks.

No reducer copy, real Git/API writes, credentials, models, or product runtime.
The separate helper shell test exercises real temporary Git repositories.
"""
from __future__ import annotations

import ast
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import textwrap

WORKFLOW = Path('.github/workflows/weasel-sync.yml').resolve()
SOURCE = WORKFLOW.read_text()


def block(tag: str) -> str:
    matches = re.findall(
        r"^[ \t]*[^\n]*<<'" + tag + r"'[ \t]*\n(.*?)^[ \t]*" + tag + r"[ \t]*$",
        SOURCE,
        re.MULTILINE | re.DOTALL,
    )
    if len(matches) != 1:
        raise AssertionError('Expected exactly one actual workflow block: ' + tag)
    code = textwrap.dedent(matches[0])
    ast.parse(code)
    return code


ADMISSION = block('PYADMISSION')
PHASE = block('PYPHASE')
OUTCOME = block('PYOUTCOME')
function = re.findall(
    r'^([ ]*)persist_promotion_phase\(\) \{\n(.*?)^\1\}',
    SOURCE,
    re.MULTILINE | re.DOTALL,
)
if len(function) != 1:
    raise AssertionError('Missing unique actual promotion shell function')
PHASE_FUNCTION = textwrap.dedent(
    function[0][0] + 'persist_promotion_phase() {\n' + function[0][1] + function[0][0] + '}'
)
tails = re.findall(
    r'^[ ]*persist_promotion_phase possibly_sent\n.*?^[ ]*persist_promotion_phase verified$',
    SOURCE,
    re.MULTILINE | re.DOTALL,
)
if len(tails) != 1:
    raise AssertionError('Missing unique actual promotion send tail')
PROMOTION_TAIL = textwrap.dedent(tails[0])

# External Git adapter only: generic objects, indexes, refs and injected transport
# failures. No coordinator outcome classification or transition is implemented here.
FAKE_GIT = r'''#!/usr/bin/env python3
import base64,hashlib,json,os,pathlib,sys
p=pathlib.Path(os.environ['FIXTURE_STATE']);s=json.loads(p.read_text());args=sys.argv[1:]
while args and args[0]=='-c':args=args[2:]
def save():p.write_text(json.dumps(s))
def stop(message):
 s.setdefault('unknown',[]).append(message);save();sys.exit(97)
def output(value):
 save();sys.stdout.write(value);sys.exit(0)
def ancestor(old,new):
 todo=[new];seen=set()
 while todo:
  item=todo.pop()
  if item==old:return True
  if item in seen:continue
  seen.add(item);todo.extend(s['commits'].get(item,{}).get('parents',[]))
 return False
def lookup(spec):
 commit,path=spec.split(':',1);commit=s['fetch'] if commit=='FETCH_HEAD' else commit
 if commit not in s['commits']:return None
 return s['trees'][s['commits'][commit]['tree']].get(path)
if not args:stop('empty Git command')
cmd=args[0];data=sys.stdin.buffer.read();s['calls'].append({'kind':'git','args':args})
if cmd=='fetch' and args[1:] == ['origin','refs/heads/automation/upstream-main-ledger']:
 s['fetch']=s['refs']['refs/heads/automation/upstream-main-ledger'];output('')
if cmd=='rev-parse' and args[1:] == ['FETCH_HEAD']:output(s['fetch']+'\n')
if cmd=='merge-base' and len(args)==4 and args[1]=='--is-ancestor':
 ok=ancestor(args[2],args[3]);save();sys.exit(0 if ok else 1)
if cmd=='show' and len(args)==2 and ':' in args[1]:
 blob=lookup(args[1]);save()
 if blob is None:sys.exit(1)
 sys.stdout.buffer.write(base64.b64decode(s['blobs'][blob]));sys.exit(0)
if cmd=='cat-file' and len(args)==3 and args[1]=='-e':
 found=lookup(args[2]);save();sys.exit(0 if found is not None else 1)
if cmd=='hash-object' and args[1:] == ['-w','--stdin']:
 digest=hashlib.sha1(b'blob '+str(len(data)).encode()+b'\0'+data).hexdigest();s['blobs'][digest]=base64.b64encode(data).decode();output(digest+'\n')
if cmd in ('read-tree','update-index','write-tree'):
 index=os.environ.get('GIT_INDEX_FILE')
 if not index or not pathlib.Path(index).is_relative_to(pathlib.Path(os.environ['RUNNER_TEMP'])):stop('nonowned index')
 if cmd=='read-tree' and len(args)==2:
  s['indexes'][index]=dict(s['trees'][s['commits'][args[1]]['tree']]);output('')
 if cmd=='update-index' and '--cacheinfo' in args:
  mode,blob,name=args[-1].split(',',2)
  if mode!='100644' or blob not in s['blobs'] or name.startswith('/') or '..' in pathlib.PurePosixPath(name).parts:stop('invalid index update')
  s['indexes'][index][name]=blob;output('')
 if cmd=='write-tree' and len(args)==1:
  tree=dict(s['indexes'][index]);digest=hashlib.sha1(json.dumps(tree,sort_keys=True).encode()).hexdigest();s['trees'][digest]=tree;output(digest+'\n')
 stop('unsupported index command')
if cmd=='commit-tree' and len(args)==4 and args[2]=='-p':
 tree,parent=args[1],args[3]
 if tree not in s['trees'] or parent not in s['commits']:stop('invalid commit input')
 digest=hashlib.sha1(tree.encode()+parent.encode()+data).hexdigest();s['commits'][digest]={'tree':tree,'parents':[parent]};output(digest+'\n')
if cmd=='push' and len(args)==3 and args[1]=='origin':
 new,ref=args[2].split(':',1)
 if ref not in ('refs/heads/automation/upstream-main-ledger','refs/heads/main') or new not in s['commits']:stop('unexpected Git write')
 kind='state_push' if ref.endswith('upstream-main-ledger') else 'main_push'
 s['counts'][kind]=s['counts'].get(kind,0)+1;failure=s.get('fail',{})
 trigger=failure.get('kind')==kind and failure.get('occurrence')==s['counts'][kind]
 if trigger and failure.get('when')=='before':save();sys.exit(79)
 if not ancestor(s['refs'][ref],new):save();sys.exit(1)
 s['refs'][ref]=new
 if trigger and failure.get('when')=='after':save();sys.exit(79)
 output('')
if cmd=='ls-remote' and len(args)==3 and args[1]=='origin' and args[2] in s['refs']:
 output(s['refs'][args[2]]+'\t'+args[2]+'\n')
stop('unsupported Git command: '+cmd)
'''

# Installed only in each owned fixture subprocess. Real networking is denied even
# if the fake HTTPS adapter is bypassed. Authorization is synthetic and never logged.
SITE_CUSTOMIZE = r'''
import http.client,json,os,pathlib,socket,time
p=pathlib.Path(os.environ['FIXTURE_STATE'])
def load():return json.loads(p.read_text())
def save(s):p.write_text(json.dumps(s))
def denied(*args,**kwargs):raise AssertionError('Real network forbidden by fixture')
socket.socket.connect=denied;socket.create_connection=denied
real_time=time.time
time.time=lambda:load()['clock']
class Response:
 def __init__(self,status,value):self.status=status;self.data=json.dumps(value).encode()
 def read(self,limit):return self.data[:limit]
class HTTPS:
 def __init__(self,host,**kwargs):
  if host!='api.github.com':raise AssertionError('Unexpected API host')
 def request(self,method,path,body=None,headers=None):
  s=load();mode=s.get('http','accepted');payload=None if body is None else json.loads(body)
  if headers.get('Authorization')!='Bearer synthetic-fixture-no-access':raise AssertionError('Nonsynthetic fixture auth')
  if method not in ('GET','POST') or path not in ('/repos/morrowbyte/t3code','/repos/morrowbyte/t3code/issues'):raise AssertionError('Unexpected API request')
  s['calls'].append({'kind':'api','method':method,'path':path,'payload':payload,'state':s['refs']['refs/heads/automation/upstream-main-ledger']})
  if method=='POST' and sum(x.get('method')=='POST' for x in s['calls'])>1:raise AssertionError('Duplicate POST attempt')
  if method=='GET':
   if mode=='expiry_after_get':s['clock']=4000000001
   save(s)
   if mode=='get_error':raise TimeoutError('Synthetic GET failure')
   self.response=Response(200,{'full_name':'other/repository' if mode=='wrong_repo' else 'morrowbyte/t3code','private':mode!='public'})
  else:
   save(s)
   if mode=='timeout':raise TimeoutError('Synthetic POST outcome unknown')
   result={'number':17,'id':901,'html_url':'https://github.com/morrowbyte/t3code/issues/17','repository_url':'https://api.github.com/repos/morrowbyte/t3code','title':payload['title'],'body':payload['body'],'assignees':[{'login':'EvilWeasel'}]}
   if mode=='wrong_url':result['html_url']='https://github.com/another/repository/issues/17'
   if mode=='negative_id':result['id']=-1
   if mode=='wrong_body':result['body']='synthetic mismatched body'
   if mode=='wrong_assignee':result['assignees']=[]
   self.response=Response(302 if mode=='redirect' else 500 if mode=='server_error' else 201,result)
 def getresponse(self):return self.response
 def close(self):pass
http.client.HTTPSConnection=HTTPS
'''


class Fixture:
    def __init__(self, root: Path):
        self.root = root
        (root / 'bin').mkdir()
        (root / 'python').mkdir()
        (root / 'runner').mkdir()
        self.state_file = root / 'state.json'
        self.env = {
            'PATH': str(root / 'bin') + os.pathsep + os.environ['PATH'],
            'PYTHONPATH': str(root / 'python'),
            'FIXTURE_STATE': str(self.state_file),
            'RUNNER_TEMP': str(root / 'runner'),
            'GITHUB_REPOSITORY': 'morrowbyte/t3code',
            'GITHUB_RUN_ID': '101',
            'GITHUB_RUN_ATTEMPT': '1',
            'GITHUB_STEP_SUMMARY': str(root / 'summary.txt'),
            'GH_TOKEN': 'synthetic-fixture-no-access',
            'ACTIVE_LEDGER': '3' * 40,
            'FORK': '1' * 40,
            'UPSTREAM': '2' * 40,
            'CANDIDATE': '4' * 40,
            'TRUSTED_WORKFLOW_SHA': '5' * 40,
            'PREPARE': 'success',
            'PUBLISH': 'success',
            'QUALIFY': 'failure',
            'PROMOTE': 'skipped',
            'POLICY_ALLOWED': 'true',
            'SOURCE_STATUS': 'candidate_unqualified',
            'PUBLISH_OUTCOME': '',
            'PROMOTE_OUTCOME': '',
            'WORKFLOW_CANCELLED': 'false',
        }
        self.state = {
            'refs': {}, 'commits': {}, 'trees': {}, 'blobs': {},
            'fetch': '', 'indexes': {}, 'calls': [], 'counts': {},
            'clock': 1700000000, 'http': 'accepted', 'unknown': [],
        }
        self.save()
        (root / 'python/sitecustomize.py').write_text(textwrap.dedent(SITE_CUSTOMIZE))
        git = root / 'bin/git'
        git.write_text(textwrap.dedent(FAKE_GIT))
        git.chmod(0o700)
        for name, code in [('admission', ADMISSION), ('phase', PHASE), ('outcome', OUTCOME)]:
            (root / (name + '.py')).write_text(code)
        subprocess.run([sys.executable, str(root / 'admission.py')], env=self.env,
                       cwd=root, stdin=subprocess.DEVNULL, capture_output=True, check=True, timeout=10)
        admission = (root / 'runner/admission.json').read_bytes()
        pair = {'forkSha': self.env['FORK'], 'upstreamSha': self.env['UPSTREAM'], 'status': 'active'}
        ledger = {'schemaVersion': 1, 'repository': 'morrowbyte/t3code', 'initialized': True,
                  'expiresAt': 4000000000, 'pairs': [pair]}
        tree = {
            'ledger.json': self.blob(json.dumps(ledger).encode()),
            'admissions/' + self.pair + '/101.json': self.blob(admission),
            'outcomes/old-owner-history/sentinel.json': self.blob(b'{"preserved":true}'),
        }
        self.state['trees']['6' * 40] = tree
        self.state['commits']['3' * 40] = {'tree': '6' * 40, 'parents': []}
        self.state['commits']['1' * 40] = {'tree': '6' * 40, 'parents': []}
        self.state['commits']['2' * 40] = {'tree': '6' * 40, 'parents': []}
        self.state['commits']['4' * 40] = {'tree': '6' * 40, 'parents': ['1' * 40, '2' * 40]}
        self.state['refs'] = {'refs/heads/automation/upstream-main-ledger': '3' * 40,
                              'refs/heads/main': '1' * 40}
        self.save()

    @property
    def pair(self):
        return self.env['FORK'] + '-' + self.env['UPSTREAM']

    @property
    def prefix(self):
        return 'outcomes/' + self.pair + '/' + self.env['ACTIVE_LEDGER'] + '/'

    def blob(self, data: bytes):
        key = hashlib.sha1(data).hexdigest()
        self.state['blobs'][key] = base64.b64encode(data).decode()
        return key

    def save(self):
        self.state_file.write_text(json.dumps(self.state))

    def load(self):
        self.state = json.loads(self.state_file.read_text())
        assert not self.state['unknown'], 'Fake Git rejected an unsupported command'
        return self.state

    def read(self, path, commit=None):
        state = self.load()
        commit = commit or state['refs']['refs/heads/automation/upstream-main-ledger']
        tree = state['trees'][state['commits'][commit]['tree']]
        return json.loads(base64.b64decode(state['blobs'][tree[path]]))

    def calls(self, method):
        return [c for c in self.load()['calls'] if c.get('method') == method]

    def run(self, name='outcome', *, ok=True, reason=None):
        result = subprocess.run([sys.executable, str(self.root / (name + '.py'))], env=self.env,
                                cwd=self.root, stdin=subprocess.DEVNULL, capture_output=True, timeout=15)
        self.load()
        assert (result.returncode == 0) == ok, (name, result.returncode, result.stderr.decode())
        if reason is not None:
            assert reason in result.stderr.decode(), 'Unexpected refusal boundary'
        return result

    def phase(self, value):
        self.env['PROMOTION_PHASE'] = value
        self.run('phase')

    def retained(self, outcome, status):
        assert self.read(self.prefix + 'result.json')['outcome'] == outcome
        ledger = self.read('ledger.json')
        assert ledger['pairs'][-1]['status'] == status
        assert ledger['expiresAt'] == 4000000000
        assert set(ledger) == {'schemaVersion', 'repository', 'initialized', 'expiresAt', 'pairs'}
        assert self.read('outcomes/old-owner-history/sentinel.json') == {'preserved': True}


def outcome_case(root, env, outcome, status='failed'):
    f = Fixture(root)
    f.env.update(env)
    f.run()
    f.retained(outcome, status)
    assert len(f.calls('POST')) == 1
    call = f.calls('POST')[0]
    claim = f.read(f.prefix + 'notification-claim.json', call['state'])
    assert claim['state'] == 'sending' and claim['body'] == call['payload']['body']
    assert claim['body'].count(claim['marker']) == 1
    accepted = f.read(f.prefix + 'notification-accepted.json')
    assert accepted['state'] == 'accepted_by_github' and accepted['pmRead'] == 'UNKNOWN'
    assert accepted['issueURL'] == 'https://github.com/morrowbyte/t3code/issues/17'


def no_post_case(root, mode):
    f = Fixture(root)
    f.state['http'] = mode
    f.save()
    f.run(ok=False)
    assert not f.calls('POST')
    assert f.read('ledger.json')['pairs'][-1]['status'] == 'active'


def unknown_case(root, mode):
    f = Fixture(root)
    f.state['http'] = mode
    f.save()
    f.run(ok=False, reason='Owner POST outcome unknown')
    f.retained('qualification_failed', 'failed')
    assert len(f.calls('POST')) == 1
    assert f.read(f.prefix + 'notification-unknown.json')['state'] == 'outcome_unknown'
    f.run(ok=False, reason='Reservation already transitioned')
    assert len(f.calls('POST')) == 1


def interrupted_case(root, *, verified=False):
    f = Fixture(root)
    f.phase('possibly_sent')
    if verified:
        f.phase('verified')
    f.env['PROMOTE'] = 'failure'
    f.run()
    f.retained('success' if verified else 'interrupted_unknown', 'success' if verified else 'active')
    assert len(f.calls('POST')) == (0 if verified else 1)


def state_failure_case(root, occurrence):
    f = Fixture(root)
    f.state['fail'] = {'kind': 'state_push', 'occurrence': occurrence, 'when': 'after' if occurrence == 1 else 'before'}
    f.save()
    f.run(ok=False)
    assert len(f.calls('POST')) == (0 if occurrence == 1 else 1)
    if occurrence == 2:
        assert f.read(f.prefix + 'notification-claim.json')['state'] == 'sending'
    f.run(ok=False)
    assert len(f.calls('POST')) == (0 if occurrence == 1 else 1)


def stale_or_replay_case(root, kind):
    f = Fixture(root)
    if kind == 'attempt2':
        f.env['GITHUB_RUN_ATTEMPT'] = '2'
        reason = 'Invalid exact outcome binding'
    elif kind == 'expired':
        f.state['clock'] = 4000000001
        f.save()
        reason = 'Missing or expired exact reservation'
    else:
        f.phase('possibly_sent')
        f.env['CANDIDATE'] = '9' * 40
        reason = 'Durable phase mismatch'
    f.run(ok=False, reason=reason)
    assert not f.calls('POST')


def promotion_tail_case(root, crash):
    f = Fixture(root)
    if crash:
        f.state['fail'] = {'kind': 'main_push', 'occurrence': 1, 'when': 'after'}
        f.save()
    command = PHASE_FUNCTION + '\n' + PROMOTION_TAIL
    result = subprocess.run(['bash', '-e', '-c', command], cwd=root, env=f.env,
                            stdin=subprocess.DEVNULL, capture_output=True, timeout=20)
    f.load()
    assert (result.returncode == 0) != crash
    calls = f.state['calls']
    pushes = [c['args'][2].split(':', 1)[1] for c in calls
              if c.get('kind') == 'git' and c['args'][0] == 'push']
    state_ref = 'refs/heads/automation/upstream-main-ledger'
    assert pushes == ([state_ref, 'refs/heads/main'] if crash else [state_ref, 'refs/heads/main', state_ref])
    f.env['PROMOTE'] = 'failure' if crash else 'success'
    f.run()
    f.retained('interrupted_unknown' if crash else 'success', 'active' if crash else 'success')
    assert f.state['refs']['refs/heads/main'] == f.env['CANDIDATE']
    assert len(f.calls('POST')) == (1 if crash else 0)


def main():
    cases = [
        ('qualification-failure-claim-before-post', lambda p: outcome_case(p, {}, 'qualification_failed')),
        ('conflict-is-source-outcome', lambda p: outcome_case(p, {'SOURCE_STATUS': 'conflict', 'QUALIFY': 'skipped'}, 'source_conflict')),
        ('initial-semantic-hold', lambda p: outcome_case(p, {'POLICY_ALLOWED': 'false'}, 'policy_hold')),
        ('protected-source-hold', lambda p: outcome_case(p, {'PUBLISH_OUTCOME': 'policy_hold'}, 'policy_hold')),
        ('stale-source-fence', lambda p: outcome_case(p, {'PUBLISH_OUTCOME': 'stale_fence'}, 'stale_fence')),
        ('operational-refusal', lambda p: outcome_case(p, {'SOURCE_STATUS': 'error', 'QUALIFY': 'skipped'}, 'operational_refusal')),
        ('cancel-keeps-active-unknown', lambda p: outcome_case(p, {'WORKFLOW_CANCELLED': 'true'}, 'interrupted_unknown', 'active')),
        ('private-proof-public-refused', lambda p: no_post_case(p, 'public')),
        ('private-proof-wrong-repo-refused', lambda p: no_post_case(p, 'wrong_repo')),
        ('private-proof-get-failure', lambda p: no_post_case(p, 'get_error')),
        ('expiry-after-get-before-send', lambda p: no_post_case(p, 'expiry_after_get')),
        *[(mode + '-never-retried', lambda p, m=mode: unknown_case(p, m))
          for mode in ('timeout', 'redirect', 'server_error', 'wrong_url', 'negative_id', 'wrong_body', 'wrong_assignee')],
        ('durable-sent-keeps-unknown', lambda p: interrupted_case(p)),
        ('durable-verified-known-boundary', lambda p: interrupted_case(p, verified=True)),
        ('state-ACK-lost-before-post', lambda p: state_failure_case(p, 1)),
        ('post-accepted-state-failure-no-replay', lambda p: state_failure_case(p, 2)),
        *[(kind + '-refused', lambda p, k=kind: stale_or_replay_case(p, k))
          for kind in ('attempt2', 'expired', 'foreign-source')],
        ('actual-send-tail-ordering', lambda p: promotion_tail_case(p, False)),
        ('actual-send-tail-crash-keeps-unknown', lambda p: promotion_tail_case(p, True)),
    ]
    with tempfile.TemporaryDirectory(prefix='upstream-coordinator-fixtures-') as temporary:
        for index, (name, case) in enumerate(cases):
            root = Path(temporary) / str(index)
            root.mkdir()
            case(root)
            print('PASS ' + name)
    print('Coordinator source fixtures passed: ' + str(len(cases)))


if __name__ == '__main__':
    main()
