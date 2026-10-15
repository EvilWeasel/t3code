#!/usr/bin/env python3
"""Offline updater behavior. Run on Namespace; never downloads or builds a package."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('install.sh').resolve()
VERSION = '0.0.47-nightly.20261014.1'

class UpdaterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.real_store = shutil.which('nix-store') is not None
        cls.package = '/nix/store/' + '0' * 32 + '-updater-fixture'
        if cls.real_store:
            # Register a tiny local fixture, without evaluation, network or compilation.
            with tempfile.TemporaryDirectory() as directory:
                app = Path(directory) / 'updater-test-app'
                (app / 'bin').mkdir(parents=True)
                launcher = app / 'bin/t3code-weasel'
                launcher.write_text('#!/bin/sh\nexit 0\n')
                launcher.chmod(0o755)
                cls.package = subprocess.check_output(['nix-store', '--add', str(app)], text=True).strip()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin = self.root / 'bin'; self.bin.mkdir()
        self.data = self.root / 'app'
        self.asset = self.root / 'closure'; self.asset.write_bytes(b'namespace-export-fixture')
        self.manifest = self.root / 'manifest.json'
        self.releases = self.root / 'releases.json'
        self.log = self.root / 'nix.log'
        self.write_release()
        self.stub('curl', '''#!/usr/bin/env python3
import os,sys,shutil
args=sys.argv[1:]
url=next(a for a in args if a.startswith('https://'))
if os.environ.get('TEST_NETWORK_FAIL'): sys.exit(90)
if 'api.github.com' in url: print(open(os.environ['TEST_RELEASES']).read())
elif '--output' in args:
 source=os.environ['TEST_MANIFEST'] if url.endswith('.json') else os.environ['TEST_ASSET']
 shutil.copyfile(source,args[args.index('--output')+1])
else: sys.exit(91)
''')
        self.stub('nix', '#!/bin/sh\necho "LOCAL BUILD FORBIDDEN" >&2\nexit 99\n')
        self.stub('zstd', '#!/bin/sh\ncat "$3"\n')
        self.stub('nix-store', '''#!/usr/bin/env python3
import os,sys
args=sys.argv[1:]
with open(os.environ['TEST_NIX_LOG'],'a') as f: f.write(' '.join(args)+'\\n')
if '--import' in args:
 sys.stdin.buffer.read()
 if os.environ.get('TEST_IMPORT_FAIL'): sys.exit(7)
elif '--requisites' in args: print(os.environ['TEST_PACKAGE'])
elif '--add-root' in args:
 root=args[args.index('--add-root')+1]
 if not os.path.lexists(root): os.symlink(os.environ['TEST_PACKAGE'],root)
elif '--verify-path' not in args: sys.exit(88)
''')
        self.env = {**os.environ, 'PATH': str(self.bin)+':'+os.environ['PATH'],
                    'T3_WEASEL_DATA_DIR': str(self.data), 'T3_WEASEL_MANAGED': '1',
                    'T3_WEASEL_REPOSITORY': 'morrowbyte/t3code', 'T3_WEASEL_CHANNEL': 'nightly',
                    'TEST_RELEASES': str(self.releases), 'TEST_ASSET': str(self.asset),
                    'TEST_MANIFEST': str(self.manifest), 'TEST_PACKAGE': self.package,
                    'TEST_NIX_LOG': str(self.log)}

    def write_release(self, manifest_version=VERSION):
        prefix = 'T3-Code-' + VERSION + '-x86_64-linux-nix-closure'
        digest = hashlib.sha256(self.asset.read_bytes()).hexdigest()
        self.manifest.write_text(json.dumps(dict(schemaVersion=1, version=manifest_version,
            system='x86_64-linux', storePath=self.package, asset=prefix+'.nar.zst',
            sha256=digest, compression='zstd'))+'\n')
        assets = []
        for name, file in [(prefix+'.nar.zst', self.asset), (prefix+'.json', self.manifest)]:
            assets.append(dict(name=name,
                browser_download_url='https://github.com/morrowbyte/t3code/releases/download/v'+VERSION+'/'+name,
                digest='sha256:'+hashlib.sha256(file.read_bytes()).hexdigest()))
        self.releases.write_text(json.dumps([
            dict(draft=False, prerelease=True, tag_name='v'+VERSION,
                 name='Weasel Nightly '+VERSION, published_at='2026-10-14T00:00:00Z', assets=assets),
            dict(draft=True, prerelease=True, tag_name='v'+VERSION,
                 name='Weasel Nightly draft', published_at='2099-01-01T00:00:00Z', assets=[])]))

    def stub(self, name, content):
        p=self.bin/name; p.write_text(content); p.chmod(0o755)

    def run_update(self, *args):
        return subprocess.run(['bash',str(SCRIPT),*args],env=self.env,capture_output=True,text=True)

    def previous(self):
        (self.data/'versions').mkdir(parents=True)
        old = self.data/'versions/0.0.47-nightly.20261013.3'
        old.symlink_to(self.package)
        (self.data/'current').symlink_to(old)
        return os.readlink(self.data/'current')

    def test_check_is_read_only_and_excludes_draft(self):
        r=self.run_update('--check'); self.assertEqual(r.returncode,0,r.stderr)
        self.assertEqual(json.loads(r.stdout)['available'],VERSION)
        self.assertFalse(self.data.exists()); self.assertFalse(self.log.exists())

    def test_bad_closure_digest_preserves_previous_version(self):
        old=self.previous(); self.asset.write_bytes(b'corrupt-export')
        r=self.run_update('--prepare', VERSION); self.assertNotEqual(r.returncode,0)
        self.assertIn('SHA-256',r.stderr)
        self.assertEqual(os.readlink(self.data/'current'),old)
        self.assertFalse(self.log.exists())

    def test_corrupt_manifest_is_rejected_before_import(self):
        self.manifest.write_text('{}')
        r=self.run_update('--prepare',VERSION); self.assertNotEqual(r.returncode,0)
        self.assertIn('SHA-256',r.stderr); self.assertFalse(self.log.exists())

    def test_wrong_manifest_version_is_rejected(self):
        self.write_release(manifest_version='9.9.9')
        r=self.run_update('--check'); self.assertNotEqual(r.returncode,0)
        self.assertIn('invalid closure manifest',r.stderr)

    def test_missing_closure_never_falls_back_to_appimage_or_build(self):
        releases=json.loads(self.releases.read_text()); releases[0]['assets']=[]
        self.releases.write_text(json.dumps(releases))
        r=self.run_update('--prepare',VERSION); self.assertNotEqual(r.returncode,0)
        self.assertFalse(self.log.exists()); self.assertFalse(self.data.exists())

    def test_failed_import_keeps_previous_pointer(self):
        old=self.previous(); self.env['TEST_IMPORT_FAIL']='1'
        r=self.run_update('--prepare',VERSION); self.assertNotEqual(r.returncode,0)
        self.assertEqual(os.readlink(self.data/'current'),old)
        self.assertFalse((self.data/'prepared'/f'{VERSION}.json').exists())

    def test_prepare_is_separate_from_activation_and_roots_closure(self):
        if not self.real_store: self.skipTest('Namespace Nix fixture needed for Store path validation')
        old=self.previous(); r=self.run_update('--prepare',VERSION)
        self.assertEqual(r.returncode,0,r.stderr)
        self.assertEqual(os.readlink(self.data/'current'),old)
        self.assertTrue((self.data/'.gcroots'/Path(self.package).name).is_symlink())
        self.assertIn('--option max-jobs 0',self.log.read_text())
        self.assertIn('--option builders ',self.log.read_text())
        self.env['TEST_NETWORK_FAIL']='1'
        r=self.run_update('--activate',VERSION); self.assertEqual(r.returncode,0,r.stderr)
        self.assertEqual(os.readlink(self.data/'previous'),old)
        self.assertEqual((self.data/'current').resolve(),Path(self.package))
        r=self.run_update('--rollback','0.0.47-nightly.20261013.3')
        self.assertEqual(r.returncode,0,r.stderr)
        self.assertEqual(os.readlink(self.data/'current'),old)

    def test_unprepared_activation_is_rejected(self):
        r=self.run_update('--activate',VERSION); self.assertNotEqual(r.returncode,0)
        self.assertFalse(self.data.exists())

    def test_prepare_never_replaces_an_existing_version_identity(self):
        old = self.previous()
        version_link = self.data/'versions'/VERSION
        version_link.symlink_to('/nix/store/' + '1'*32 + '-original-version')
        (self.data/'current').unlink()
        (self.data/'current').symlink_to(version_link)
        (self.data/'previous').symlink_to(old)
        before = {name: os.readlink(self.data/name) for name in ['current', 'previous']}
        r = self.run_update('--prepare', VERSION)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('version identity changed', r.stderr)
        self.assertEqual(os.readlink(version_link), '/nix/store/' + '1'*32 + '-original-version')
        self.assertEqual({name: os.readlink(self.data/name) for name in before}, before)
        self.assertFalse(self.log.exists())

    def test_activation_rechecks_prepared_provenance_under_lock(self):
        if not self.real_store: self.skipTest('Namespace Nix fixture needed for Store path validation')
        old = self.previous()
        r = self.run_update('--prepare', VERSION)
        self.assertEqual(r.returncode, 0, r.stderr)
        receipt = self.data/'prepared'/f'{VERSION}.json'
        original = json.loads(receipt.read_text())
        self.assertEqual(original['repository'], 'morrowbyte/t3code')
        self.assertEqual(original['channel'], 'nightly')
        for field, value in [('version','9.9.9'), ('repository','pingdotgg/t3code'), ('channel','stable'), ('storePath','/nix/store/wrong')]:
            with self.subTest(field=field):
                receipt.write_text(json.dumps({**original, field:value}))
                r = self.run_update('--activate', VERSION)
                self.assertNotEqual(r.returncode, 0)
                self.assertIn('provenance changed', r.stderr)
                self.assertEqual(os.readlink(self.data/'current'), old)
        receipt.write_text(json.dumps(original))
        self.env['T3_WEASEL_CHANNEL'] = 'stable'
        r = self.run_update('--activate', VERSION)
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(os.readlink(self.data/'current'), old)

    def test_wrong_repository_is_rejected_without_network_or_install(self):
        self.env['T3_WEASEL_REPOSITORY'] = 'pingdotgg/t3code'
        r = self.run_update('--prepare', VERSION)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('approved fork', r.stderr)
        self.assertFalse(self.data.exists())
        self.assertFalse(self.log.exists())

    def test_stable_does_not_fall_back_to_nightly(self):
        self.env['T3_WEASEL_CHANNEL']='stable'
        r=self.run_update('--check'); self.assertNotEqual(r.returncode,0)
        self.assertIn('no fork-owned stable release',r.stderr)
        self.assertFalse(self.data.exists())

if __name__ == '__main__': unittest.main()
