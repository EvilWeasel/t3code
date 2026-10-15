#!/usr/bin/env bash
set -euo pipefail

# Only process-boundary stubs run here; no git repository or GitHub state is changed.
python3 - <<'PY'
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

source = Path('scripts/weasel/sync-upstream-nightly.sh').resolve()
bash = shutil.which('bash')
with tempfile.TemporaryDirectory(prefix='fork-sync-test-') as directory:
    root = Path(directory)
    stub = root / 'stub'
    stub.write_text('''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
tool = Path(sys.argv[0]).name
args = sys.argv[1:]
root = Path(os.environ['FIXTURE_ROOT'])
with (root / 'calls').open('a') as stream:
    stream.write(json.dumps([tool, *args]) + '\\n')
scenario = os.environ['SCENARIO']
if tool == 'gh':
    if args[0] == 'api':
        assert args == ['api', '--method', 'GET', 'repos/pingdotgg/t3code/releases', '--paginate', '--slurp'], args
        print('[[{"draft":false,"published_at":"2026-10-15T00:00:00Z","tag_name":"v1-nightly.1"}]]')
    else:
        assert '--repo' in args and args[args.index('--repo') + 1] == 'morrowbyte/t3code', args
        if args[:2] == ['run', 'list']:
            print(os.environ.get('RUNS', '[]'))
        elif args[:2] == ['issue', 'list']:
            print('42' if scenario == 'existing-conflict' else '')
        elif args[:2] == ['issue', 'view']:
            print('Previous conflict')
        else:
            assert args[:2] in [['workflow', 'run'], ['issue', 'create'], ['issue', 'comment']], args
elif tool == 'git':
    if args == ['remote', 'get-url', '--push', 'origin']:
        print(os.environ.get('ORIGIN_URL', 'https://github.com/morrowbyte/t3code.git'))
    elif args == ['rev-parse', 'FETCH_HEAD']:
        counter = root / 'counter'
        count = int(counter.read_text()) if counter.exists() else 0
        counter.write_text(str(count + 1))
        print(('a' if count == 0 else 'b') * 40)
    elif args == ['rev-parse', 'HEAD']:
        print('b' * 40 if scenario.startswith('contained') else 'c' * 40)
    elif args[:2] == ['merge-base', '--is-ancestor']:
        sys.exit(0 if scenario.startswith('contained') or args[-1] == 'HEAD' else 1)
    elif args[:2] == ['merge', '--no-edit']:
        sys.exit(1 if scenario in ['new-conflict', 'existing-conflict', 'merge-error'] else 0)
    elif args == ['diff', '--name-only', '--diff-filter=U']:
        print('conflicted.ts' if scenario != 'merge-error' else '')
    elif args[:1] == ['push']:
        assert args == ['push', 'origin', 'HEAD:refs/heads/main'], args
    else:
        assert args[0] in ['fetch', 'switch', 'config', 'merge', 'status'], args
elif tool == 'bash':
    assert args == ['scripts/weasel/check.sh'], args
elif tool == 'vp':
    assert args == ['install', '--frozen-lockfile'], args
else:
    raise AssertionError(tool)
''')
    stub.chmod(0o755)
    for name in ['gh', 'git', 'vp', 'bash']:
        (root / name).symlink_to(stub)

    def run(scenario, *, repository='morrowbyte/t3code', runs=None, origin=None, success=True):
        for path in [root / 'calls', root / 'counter']:
            path.unlink(missing_ok=True)
        env = {**os.environ, 'PATH': str(root) + os.pathsep + os.environ['PATH'],
               'GITHUB_REPOSITORY': repository, 'GH_REPO': 'pingdotgg/t3code',
               'FIXTURE_ROOT': str(root), 'SCENARIO': scenario,
               'RUNS': json.dumps(runs or [])}
        env.pop('ORIGIN_URL', None)
        if origin is not None:
            env['ORIGIN_URL'] = origin
        result = subprocess.run([bash, str(source)], env=env, capture_output=True, text=True)
        assert (result.returncode == 0) == success, (scenario, result.stdout, result.stderr)
        calls = [json.loads(line) for line in (root / 'calls').read_text().splitlines()] if (root / 'calls').exists() else []
        print('PASS', scenario, repository or '<empty>')
        return calls

    for repository in ['', 'pingdotgg/t3code', 'another/fork']:
        assert run('invalid-target', repository=repository, success=False) == []
    calls = run('wrong-origin', origin='https://github.com/pingdotgg/t3code.git', success=False)
    assert all(call[0] != 'gh' and call[:2] != ['git', 'push'] for call in calls)
    for scenario, expected in [('new-conflict', 'create'), ('existing-conflict', 'comment')]:
        calls = run(scenario)
        assert any(call[:3] == ['gh', 'issue', expected] for call in calls)
        assert not any(call[:2] == ['git', 'push'] or call[:3] == ['gh', 'workflow', 'run'] for call in calls)
    calls = run('merge-error', success=False)
    assert not any(call[:2] == ['gh', 'issue'] for call in calls)
    for scenario in ['contained-missing-release', 'merge-success']:
        calls = run(scenario)
        assert sum(call[:3] == ['gh', 'workflow', 'run'] for call in calls) == 1
        assert sum(call[:2] == ['git', 'push'] for call in calls) == (scenario == 'merge-success')
    for status, conclusion, success in [('in_progress', '', True), ('completed', 'success', True), ('completed', 'failure', False)]:
        runs = [{'databaseId': 123, 'displayTitle': 'Weasel desktop release ' + 'b' * 40,
                 'status': status, 'conclusion': conclusion, 'event': 'workflow_dispatch'}]
        calls = run('contained-release-' + (conclusion or status), runs=runs, success=success)
        assert not any(call[:3] == ['gh', 'workflow', 'run'] for call in calls)
PY
