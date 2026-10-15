#!/usr/bin/env bash
set -euo pipefail
# Trusted-workflow helper only. Never executes candidate code or performs network writes.
exec python3 - "${BASH_SOURCE[0]}" "$@" <<'PY'
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

REPO = 'morrowbyte/t3code'
UPSTREAM = 'https://github.com/pingdotgg/t3code.git'
SHA = re.compile(r'^[0-9a-f]{40}$')
URLS = {'https://github.com/morrowbyte/t3code.git', 'https://github.com/morrowbyte/t3code', 'git@github.com:morrowbyte/t3code.git'}
parser = argparse.ArgumentParser()
parser.add_argument('mode', choices=['probe', 'prepare'])
parser.add_argument('--fork-sha')
parser.add_argument('--upstream-sha')
parser.add_argument('--state-file')
parser.add_argument('--output', required=True)
source_path = Path(sys.argv.pop(1)).resolve()
args = parser.parse_args()
if os.environ.get('GITHUB_REPOSITORY') != REPO:
    sys.exit('Refusing non-fork repository.')
output = Path(args.output)
if not output.is_absolute() or output.exists() or not output.parent.is_dir():
    sys.exit('Output must be a new absolute directory with an existing parent.')
output.mkdir(mode=0o700)
receipt = {'schemaVersion': 1, 'repository': REPO, 'status': 'error', 'candidateSha': None,
           'qualification': 'NOT_QUALIFIED', 'semanticReview': 'REQUIRED',
           'helperSha256': hashlib.sha256(source_path.read_bytes()).hexdigest(),
           'runId': os.environ.get('GITHUB_RUN_ID'), 'forkSha': None, 'upstreamSha': None}

class Refusal(Exception):
    pass

def strict_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise Refusal('duplicate-json-key')
        result[key] = value
    return result

def write_receipt():
    temporary = output / '.receipt.tmp'
    with temporary.open('w') as stream:
        json.dump(receipt, stream, sort_keys=True, separators=(',', ':'))
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(output / 'receipt.json')

def git(*command, env=None, cwd=None, allowed=(0,), data=None):
    # No shell, hooks, model tools, install scripts, or inherited Git config injection.
    child_env = dict(os.environ) if env is None else dict(env)
    for key in list(child_env):
        if key in {'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_INDEX_FILE', 'GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'} or key.startswith(('GIT_CONFIG_KEY_', 'GIT_CONFIG_VALUE_')):
            del child_env[key]
    result = subprocess.run(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'i18n.commitEncoding=UTF-8', *command],
                            cwd=cwd, env=child_env, input=data, capture_output=True, timeout=120)
    if result.returncode not in allowed:
        raise Refusal('git-operation-failed')
    return result

def text(*command):
    return git(*command).stdout.decode('utf-8', 'strict').strip()

def remote_sha(url, public=False):
    # PUBLIC transport is outside this checkout and ignores system/global/local Git
    # config and inherited auth environment, not just a less-specific header override.
    if public:
        keep = {'PATH', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy'}
        public_env = {key: value for key, value in os.environ.items() if key in keep}
        public_env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_SYSTEM='/dev/null', GIT_CONFIG_GLOBAL='/dev/null', GIT_TERMINAL_PROMPT='0')
        with tempfile.TemporaryDirectory(prefix='public-upstream-read-') as directory:
            result = git('-c', 'http.extraHeader=', '-c', 'credential.helper=', '-c', 'core.askPass=', 'ls-remote', '--exit-code', url, 'refs/heads/main', env=public_env, cwd=directory)
    else:
        result = git('ls-remote', '--exit-code', url, 'refs/heads/main')
    lines = result.stdout.decode('ascii', 'strict').splitlines()
    if len(lines) != 1:
        raise Refusal('ambiguous-main')
    sha, ref = lines[0].split('\t')
    if not SHA.fullmatch(sha) or ref != 'refs/heads/main':
        raise Refusal('invalid-main')
    return sha

try:
    for option in [('--all',), ('--push', '--all')]:
        if text('remote', 'get-url', *option, 'origin').splitlines() not in [[url] for url in URLS]:
            raise Refusal('origin-not-exclusive-fork')
    if git('config', '--get', 'remote.origin.mirror', allowed=(0, 1)).stdout.strip().lower() == b'true':
        raise Refusal('mirror-origin')
    if git('config', '--name-only', '--get-regexp', r'^merge\..*\.driver$', allowed=(0, 1)).stdout.strip():
        raise Refusal('external-merge-driver')
    if args.mode == 'probe':
        if args.fork_sha or args.upstream_sha or args.state_file:
            raise Refusal('unexpected-probe-input')
        receipt.update(forkSha=remote_sha('origin'), upstreamSha=remote_sha(UPSTREAM, public=True), status='probed')
    else:
        if not args.fork_sha or not SHA.fullmatch(args.fork_sha) or not args.upstream_sha or not SHA.fullmatch(args.upstream_sha):
            raise Refusal('invalid-pins')
        fork, upstream = args.fork_sha, args.upstream_sha
        receipt.update(forkSha=fork, upstreamSha=upstream, pair=f'{fork}:{upstream}', candidateRef=f'refs/heads/automation/upstream-main/{fork}-{upstream}')
        # No implicit ledger initialization or retry on missing/expired Actions artifacts.
        state_path = Path(args.state_file or '')
        if not state_path.is_absolute() or not state_path.is_file() or state_path.stat().st_size > 2_097_152:
            raise Refusal('ledger-missing')
        ledger = json.loads(state_path.read_text(), object_pairs_hook=strict_object)
        if set(ledger) != {'schemaVersion', 'repository', 'initialized', 'pairs'} or type(ledger['schemaVersion']) is not int or ledger['schemaVersion'] != 1 or ledger['repository'] != REPO or ledger['initialized'] is not True or not isinstance(ledger['pairs'], list) or len(ledger['pairs']) > 10000:
            raise Refusal('ledger-invalid')
        seen = set()
        for entry in ledger['pairs']:
            if not isinstance(entry, dict) or set(entry) != {'forkSha', 'upstreamSha', 'status'} or not isinstance(entry['forkSha'], str) or not SHA.fullmatch(entry['forkSha']) or not isinstance(entry['upstreamSha'], str) or not SHA.fullmatch(entry['upstreamSha']) or entry['status'] not in ('active', 'failed', 'success'):
                raise Refusal('ledger-entry-invalid')
            pair = (entry['forkSha'], entry['upstreamSha'])
            if pair in seen:
                raise Refusal('ledger-duplicate')
            seen.add(pair)
        if (fork, upstream) in seen:
            receipt['status'] = 'skipped_known_pair'
        else:
            for sha in (fork, upstream):
                if text('rev-parse', '--verify', f'{sha}^{{commit}}') != sha:
                    raise Refusal('missing-pinned-commit')
            receipt['mergeBase'] = text('merge-base', fork, upstream)
            if git('merge-base', '--is-ancestor', upstream, fork, allowed=(0, 1)).returncode == 0:
                receipt['status'] = 'no_change'
            else:
                # --write-tree never changes any worktree/index; no candidate code runs.
                merge = git('merge-tree', '--write-tree', '--messages', '-z', fork, upstream, allowed=(0, 1))
                tokens = merge.stdout.split(b'\0')
                tree = tokens[0].decode('ascii')
                if not SHA.fullmatch(tree):
                    raise Refusal('invalid-merge-tree')
                receipt['treeSha'] = tree
                if merge.returncode == 1:
                    entries = tokens[1:tokens.index(b'', 1)]
                    paths = sorted({entry.split(b'\t', 1)[1].decode('utf-8', 'strict') for entry in entries})
                    if not paths:
                        raise Refusal('merge-error-without-conflicts')
                    receipt.update(status='conflict', conflictingPaths=paths)
                    (output / 'conflicts.txt').write_text(''.join(path + '\n' for path in paths))
                else:
                    epoch = max(int(text('show', '-s', '--format=%ct', sha)) for sha in (fork, upstream)) + 1
                    commit_env = dict(os.environ)
                    commit_env.update(GIT_AUTHOR_NAME='github-actions[bot]', GIT_COMMITTER_NAME='github-actions[bot]',
                                      GIT_AUTHOR_EMAIL='41898282+github-actions[bot]@users.noreply.github.com', GIT_COMMITTER_EMAIL='41898282+github-actions[bot]@users.noreply.github.com',
                                      GIT_AUTHOR_DATE=f'{epoch} +0000', GIT_COMMITTER_DATE=f'{epoch} +0000')
                    message = f'Merge upstream main {upstream} into morrowbyte main {fork}\n'
                    candidate = git('commit-tree', tree, '-p', fork, '-p', upstream, env=commit_env, data=message.encode()).stdout.decode('ascii').strip()
                    if not SHA.fullmatch(candidate) or text('show', '-s', '--format=%T %P', candidate) != f'{tree} {fork} {upstream}':
                        raise Refusal('candidate-identity-mismatch')
                    # Exact candidate commit is the bundle head; no ref or branch is published.
                    private_ref = f'refs/weasel-sync/{fork}-{upstream}'
                    git('update-ref', private_ref, candidate, '0' * 40)
                    try:
                        bundle = output / 'candidate.bundle'
                        git('bundle', 'create', str(bundle), private_ref, f'^{fork}')
                        if text('bundle', 'list-heads', str(bundle)) != f'{candidate} {private_ref}':
                            raise Refusal('bundle-head-mismatch')
                        git('bundle', 'verify', str(bundle))
                        # Verify the actual exported commit in a separate object database.
                        # Fetch only immutable prerequisite snapshots from this owned local repo.
                        prerequisites = []
                        with bundle.open('rb') as stream:
                            if stream.readline() != b'# v2 git bundle\n':
                                raise Refusal('unsupported-bundle-format')
                            for line in stream:
                                if line == b'\n':
                                    break
                                if line.startswith(b'-'):
                                    prerequisite = line[1:41].decode('ascii')
                                    if not SHA.fullmatch(prerequisite):
                                        raise Refusal('invalid-bundle-prerequisite')
                                    prerequisites.append(prerequisite)
                        if not prerequisites:
                            raise Refusal('missing-bundle-prerequisite')
                        local_repo = text('rev-parse', '--absolute-git-dir')
                        with tempfile.TemporaryDirectory(prefix='verify-sync-bundle-') as verifier:
                            git('init', '--bare', '--object-format=sha1', verifier)
                            git('-c', 'protocol.file.allow=always', 'fetch', '--no-tags', '--depth=1', local_repo, *prerequisites, cwd=verifier)
                            git('bundle', 'verify', str(bundle), cwd=verifier)
                            git('bundle', 'unbundle', str(bundle), cwd=verifier)
                            verified = git('show', '-s', '--format=%T %P', candidate, cwd=verifier).stdout.decode('ascii').strip()
                            if verified != f'{tree} {fork} {upstream}':
                                raise Refusal('bundle-identity-mismatch')
                        if text('show', '-s', '--format=%T %P', candidate) != f'{tree} {fork} {upstream}':
                            raise Refusal('bundle-source-mismatch')
                        receipt.update(status='candidate_unqualified', candidateSha=candidate,
                                       bundleSha256=hashlib.sha256(bundle.read_bytes()).hexdigest(), bundleRef=private_ref,
                                       deterministicDate=f'{epoch} +0000')
                    finally:
                        git('update-ref', '-d', private_ref, candidate)
    write_receipt()
    print(receipt['status'])
except Exception as error:
    # No raw Git/HTTP/config/credential output is emitted, including failure paths.
    (output / 'candidate.bundle').unlink(missing_ok=True)
    receipt['candidateSha'] = None
    receipt['status'] = 'error'
    receipt['reason'] = error.args[0] if isinstance(error, Refusal) else 'runtime-or-invalid-json'
    write_receipt()
    print('Sync source preparation failed; inspect the pinned receipt.', file=sys.stderr)
    sys.exit(1)
PY
