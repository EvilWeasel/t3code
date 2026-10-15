#!/usr/bin/env bash
set -euo pipefail
# Hosted deterministic behavior fixtures. Real temporary Git repos/merges/bundles,
# no GitHub writes, network, model invocation, product build, or user's checkout changes.
exec python3 - <<'PY'
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

source = Path('scripts/weasel/sync-upstream-main.sh').resolve()
root_mapping = Path('.gitmodules').resolve().read_bytes()
vendored_mapping = Path('.repos/alchemy-effect/.gitmodules').resolve().read_bytes()
real_git = shutil.which('git')
bash = shutil.which('bash')
assert real_git and bash
with tempfile.TemporaryDirectory(prefix='upstream-main-source-tests-') as temporary:
    root = Path(temporary)
    repo = root / 'repo'
    repo.mkdir()
    env = {key: value for key, value in os.environ.items() if not key.startswith(('GIT_', 'GH_'))}
    env.update(GITHUB_REPOSITORY='morrowbyte/t3code', GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null',
               GIT_AUTHOR_NAME='Owned fixture', GIT_COMMITTER_NAME='Owned fixture', GIT_AUTHOR_EMAIL='fixture@example.invalid',
               GIT_COMMITTER_EMAIL='fixture@example.invalid', GIT_AUTHOR_DATE='1700000000 +0000', GIT_COMMITTER_DATE='1700000000 +0000')
    def git(*args, cwd=repo):
        return subprocess.check_output([real_git, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', *args], cwd=cwd, env=env).decode().strip()
    git('init', '--initial-branch=main')
    git('config', 'remote.origin.url', 'https://github.com/morrowbyte/t3code.git')
    (repo / 'shared.txt').write_text('base\n')
    git('add', '.'); git('commit', '-m', 'base')
    base = git('rev-parse', 'HEAD')
    (repo / 'fork.txt').write_text('fork behavior retained\n')
    git('add', '.'); git('commit', '-m', 'fork behavior')
    fork = git('rev-parse', 'HEAD')
    git('switch', '-c', 'upstream', base)
    (repo / 'upstream.txt').write_text('new upstream feature\n')
    git('add', '.'); git('commit', '-m', 'upstream behavior')
    upstream = git('rev-parse', 'HEAD')
    git('switch', 'main')
    ledger = root / 'ledger.json'
    ledger.write_text(json.dumps({'schemaVersion': 1, 'repository': 'morrowbyte/t3code', 'initialized': True, 'expiresAt': 4000000000, 'pairs': []}))
    original_index = (repo / '.git/index').read_bytes()
    counter = 0
    def run(fork_sha=fork, upstream_sha=upstream, *, state=ledger, overrides=None, ok=True):
        global counter
        counter += 1
        output = root / f'output-{counter}'
        result = subprocess.run([bash, str(source), 'prepare', '--fork-sha', fork_sha, '--upstream-sha', upstream_sha, '--state-file', str(state), '--output', str(output)], cwd=repo, env={**env, **(overrides or {})}, capture_output=True, text=True)
        assert (result.returncode == 0) == ok, (result.returncode, result.stdout, result.stderr)
        return json.loads((output / 'receipt.json').read_text()) if output.exists() else None, output
    first, bundle_dir = run()
    assert first['status'] == 'candidate_unqualified' and first['qualification'] == 'NOT_QUALIFIED' and first['semanticReview'] == 'REQUIRED'
    candidate = first['candidateSha']
    assert git('show', '-s', '--format=%T %P', candidate) == f"{first['treeSha']} {fork} {upstream}"
    assert git('show', candidate + ':fork.txt') == 'fork behavior retained'
    assert git('show', candidate + ':upstream.txt') == 'new upstream feature'
    assert git('rev-parse', 'HEAD') == fork and (repo / '.git/index').read_bytes() == original_index
    assert git('for-each-ref', '--format=%(refname)', 'refs/weasel-sync/') == ''
    assert hashlib.sha256((bundle_dir / 'candidate.bundle').read_bytes()).hexdigest() == first['bundleSha256']
    verifier = root / 'verifier'; verifier.mkdir(); git('init', cwd=verifier)
    git('fetch', str(repo), fork, cwd=verifier)
    git('bundle', 'verify', str(bundle_dir / 'candidate.bundle'), cwd=verifier)
    git('bundle', 'unbundle', str(bundle_dir / 'candidate.bundle'), cwd=verifier)
    assert git('show', '-s', '--format=%T %P', candidate, cwd=verifier) == f"{first['treeSha']} {fork} {upstream}"
    second, _ = run(overrides={'GITHUB_RUN_ID': '999', 'GIT_AUTHOR_NAME': 'Different ambient identity', 'GIT_AUTHOR_DATE': '1800000000 +0700'})
    assert second['candidateSha'] == candidate and second['runId'] == '999'
    contained, out = run(fork_sha=candidate)
    assert contained['status'] == 'no_change' and not (out / 'candidate.bundle').exists()
    for status in ('active', 'failed', 'success'):
        ledger.write_text(json.dumps({'schemaVersion': 1, 'repository': 'morrowbyte/t3code', 'initialized': True, 'expiresAt': 4000000000, 'pairs': [{'forkSha': fork, 'upstreamSha': upstream, 'status': status}]}))
        skipped, out = run()
        assert skipped['status'] == 'skipped_known_pair' and skipped['candidateSha'] is None and not (out / 'candidate.bundle').exists()
    for content in ('{', '{}', '{"schemaVersion":1,"schemaVersion":1}', json.dumps({'schemaVersion': 1, 'repository': 'morrowbyte/t3code', 'initialized': False, 'expiresAt': 4000000000, 'pairs': []}), json.dumps({'schemaVersion': 1, 'repository': 'pingdotgg/t3code', 'initialized': True, 'expiresAt': 4000000000, 'pairs': []})):
        ledger.write_text(content)
        failed, out = run(ok=False)
        assert failed['status'] == 'error' and not (out / 'candidate.bundle').exists()
    ledger.write_text(json.dumps({'schemaVersion': 1, 'repository': 'morrowbyte/t3code', 'initialized': True, 'expiresAt': 1, 'pairs': []}))
    assert run(ok=False)[0]['reason'] == 'ledger-expired-or-invalid-expiry'
    missing, _ = run(state=root / 'expired-or-missing-artifact.json', ok=False)
    assert missing['reason'] == 'ledger-missing'
    ledger.write_text(json.dumps({'schemaVersion': 1, 'repository': 'morrowbyte/t3code', 'initialized': True, 'expiresAt': 4000000000, 'pairs': []}))
    for key, value in [('remote.origin.pushurl', 'https://github.com/pingdotgg/t3code.git'), ('remote.origin.mirror', 'true')]:
        git('config', key, value)
        failed, _ = run(ok=False)
        assert failed['status'] == 'error'
        git('config', '--unset', key)
    git('config', '--add', 'remote.origin.pushurl', 'https://github.com/morrowbyte/t3code.git')
    git('config', '--add', 'remote.origin.pushurl', 'https://github.com/another/repo.git')
    assert run(ok=False)[0]['reason'] == 'origin-not-exclusive-fork'
    git('config', '--unset-all', 'remote.origin.pushurl')
    assert run(overrides={'GITHUB_REPOSITORY': 'pingdotgg/t3code'}, ok=False)[0] is None
    # A real content conflict leaves HEAD/index untouched and creates no candidate.
    (repo / 'shared.txt').write_text('fork edit\n'); git('add', '.'); git('commit', '-m', 'fork edit')
    conflict_fork = git('rev-parse', 'HEAD')
    git('switch', 'upstream'); (repo / 'shared.txt').write_text('upstream edit\n'); git('add', '.'); git('commit', '-m', 'upstream edit')
    conflict_upstream = git('rev-parse', 'HEAD'); git('switch', 'main')
    index = (repo / '.git/index').read_bytes()
    conflict, out = run(fork_sha=conflict_fork, upstream_sha=conflict_upstream)
    assert conflict['status'] == 'conflict' and conflict['conflictingPaths'] == ['shared.txt']
    assert not (out / 'candidate.bundle').exists() and git('rev-parse', 'HEAD') == conflict_fork and (repo / '.git/index').read_bytes() == index
    # Advanced fork main is not modified; privileged promotion must reject old forkSha.
    advanced, _ = run()
    assert advanced['forkSha'] == fork and git('rev-parse', 'main') == conflict_fork
    # Only transport is stubbed for probe: assert actual public git invocation isolation.
    stubs = root / 'bin'; stubs.mkdir()
    wrapper = stubs / 'git'
    wrapper.write_text('''#!/usr/bin/env python3
import json, os, subprocess, sys
from pathlib import Path
args=sys.argv[1:]
if 'ls-remote' in args:
    public='https://github.com/pingdotgg/t3code.git' in args
    if public:
        assert os.environ.get('GIT_CONFIG_NOSYSTEM')=='1'
        assert os.environ.get('GIT_CONFIG_GLOBAL')=='/dev/null'
        assert 'GH_TOKEN' not in os.environ and 'GIT_ASKPASS' not in os.environ
        assert not (Path.cwd()/'.git').exists()
        assert 'credential.helper=' in args and 'http.extraHeader=' in args
    print(('2' if public else '1')*40+'\\trefs/heads/main')
    sys.exit(0)
sys.exit(subprocess.call([os.environ['REAL_GIT'],*args]))
''')
    wrapper.chmod(0o755)
    probe = root / 'probe'
    probe_env = {**env, 'PATH': str(stubs)+os.pathsep+env['PATH'], 'REAL_GIT': real_git, 'GH_TOKEN': 'synthetic-not-a-real-token', 'GIT_ASKPASS': '/not-executable'}
    # Public env intentionally excludes REAL_GIT too; stub only needs it for local commands.
    subprocess.run([bash, str(source), 'probe', '--output', str(probe)], cwd=repo, env=probe_env, check=True, capture_output=True)
    assert json.loads((probe / 'receipt.json').read_text())['status'] == 'probed'
    # Checkout's persist-credentials:false cleanup traverses gitlinks even with
    # submodules:false. Exercise the root-relative metadata using owned local objects.
    metadata_repo = root / 'checkout-metadata'; metadata_repo.mkdir()
    git('init', '--initial-branch=main', cwd=metadata_repo)
    nested = metadata_repo / '.repos/alchemy-effect'; nested.mkdir(parents=True)
    (nested / '.gitmodules').write_bytes(vendored_mapping)
    git('add', '.', cwd=metadata_repo)
    for name in ('distilled', 'floci'):
        git('update-index', '--add', '--cacheinfo', '160000,' + fork + ',.repos/alchemy-effect/submodules/' + name, cwd=metadata_repo)
    git('commit', '-m', 'fixture nested vendored gitlinks', cwd=metadata_repo)
    immutable_links = git('ls-files', '--stage', '.repos/alchemy-effect/submodules/', cwd=metadata_repo)
    cleanup = ['submodule', 'foreach', '--recursive', 'git config --local --name-only --get-regexp "core\\.sshCommand" && git config --local --unset-all core.sshCommand || :']
    no_network_env = {**env, 'GIT_ALLOW_PROTOCOL': ''}
    before = subprocess.run([real_git, *cleanup], cwd=metadata_repo, env=no_network_env, capture_output=True)
    assert before.returncode != 0 and b'No url found for submodule path' in before.stderr
    (metadata_repo / '.gitmodules').write_bytes(root_mapping)
    git('add', '.gitmodules', cwd=metadata_repo)
    for name in ('distilled', 'floci'):
        assert git('config', '-f', '.gitmodules', 'submodule.' + name + '.path', cwd=metadata_repo) == '.repos/alchemy-effect/submodules/' + name
        assert git('config', '-f', '.gitmodules', 'submodule.' + name + '.url', cwd=metadata_repo) == 'https://github.com/alchemy-run/' + name + '.git'
    for key, value in [('shallow', 'true'), ('update', 'none'), ('ignore', 'all')]:
        assert git('config', '-f', '.gitmodules', 'submodule.floci.' + key, cwd=metadata_repo) == value
    for command in [cleanup, ['submodule', 'foreach', '--recursive', 'git config --local --name-only --get-regexp "http\\.https\\:\\/\\/github\\.com\\/\\.extraheader" && git config --local --unset-all "http.https://github.com/.extraheader" || :']]:
        result = subprocess.run([real_git, *command], cwd=metadata_repo, env=no_network_env, capture_output=True)
        assert result.returncode == 0, 'Root metadata must allow recursive auth cleanup'
    assert git('ls-files', '--stage', '.repos/alchemy-effect/submodules/', cwd=metadata_repo) == immutable_links
    assert not (metadata_repo / '.git/modules').exists()
    assert all(not (nested / 'submodules' / name).exists() for name in ('distilled', 'floci'))
    print('PASS: deterministic real Git fixture matrix; not product/platform qualification')
PY
