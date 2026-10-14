#!/usr/bin/env python3
"""Offline release/installation tests; no GUI, credentials or live profile writes."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).with_name('install.sh').resolve()
VERSION = '0.0.47-nightly.20261014.1'

class UpdaterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
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
        self.asset = self.root / 'asset'; self.asset.write_bytes(b'release-payload')
        digest = hashlib.sha256(self.asset.read_bytes()).hexdigest()
        self.releases = self.root / 'releases.json'
        self.releases.write_text(json.dumps([
            {'draft': False, 'prerelease': True, 'tag_name': 'v'+VERSION,
             'name': 'Weasel Nightly '+VERSION, 'published_at': '2026-10-14T00:00:00Z',
             'assets': [{'name': 'T3-Code-'+VERSION+'-x86_64.AppImage',
                        'browser_download_url': 'https://github.com/morrowbyte/t3code/releases/download/v'+VERSION+'/T3-Code-'+VERSION+'-x86_64.AppImage',
                        'digest': 'sha256:'+digest}]},
            {'draft': True, 'prerelease': True, 'tag_name': 'v'+VERSION,
             'name': 'Weasel Nightly draft', 'published_at': '2099-01-01T00:00:00Z', 'assets': []}
        ]))
        self.stub('curl', '''#!/usr/bin/env python3
import os,sys,shutil
args=sys.argv[1:]
if '--output' in args:
 shutil.copyfile(os.environ['TEST_ASSET'],args[args.index('--output')+1])
else:
 print(open(os.environ['TEST_RELEASES']).read())
''')
        self.stub('nix', '''#!/usr/bin/env python3
import os,sys
if os.environ.get('TEST_BUILD_FAIL') == '1': sys.exit(7)
args=sys.argv[1:]; root=args[args.index('--out-link')+1]
os.symlink(os.environ['TEST_PACKAGE'],root)
print(os.environ['TEST_PACKAGE'])
''')
        self.stub('nix-store', '''#!/usr/bin/env python3
import os,sys
args=sys.argv[1:]
root=args[args.index('--add-root')+1]
if not os.path.lexists(root): os.symlink(os.environ['TEST_PACKAGE'],root)
''')
        self.env = {**os.environ, 'PATH': str(self.bin)+':'+os.environ['PATH'],
                    'T3_WEASEL_DATA_DIR': str(self.data), 'T3_WEASEL_MANAGED': '1',
                    'T3_WEASEL_REPOSITORY': 'morrowbyte/t3code', 'T3_WEASEL_CHANNEL': 'nightly',
                    'TEST_RELEASES': str(self.releases), 'TEST_ASSET': str(self.asset),
                    'TEST_PACKAGE': self.package}

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
        self.assertFalse(self.data.exists())

    def test_bad_digest_preserves_previous_version(self):
        old=self.previous(); self.asset.write_bytes(b'corrupt-payload')
        r=self.run_update('--update'); self.assertNotEqual(r.returncode,0)
        self.assertIn('SHA-256',r.stderr)
        self.assertEqual(os.readlink(self.data/'current'),old)
        self.assertFalse((self.data/'versions'/VERSION).exists())

    def test_failed_build_preserves_previous_root(self):
        old=self.previous(); self.env['TEST_BUILD_FAIL']='1'
        r=self.run_update('--update'); self.assertNotEqual(r.returncode,0)
        self.assertEqual(os.readlink(self.data/'current'),old)
        self.assertTrue((self.data/'versions/0.0.47-nightly.20261013.3').is_symlink())

    def test_success_roots_new_version_and_keeps_rollback(self):
        old=self.previous(); r=self.run_update('--update')
        self.assertEqual(r.returncode,0,r.stderr)
        self.assertEqual((self.data/'current').resolve(),Path(self.package))
        self.assertEqual(os.readlink(self.data/'previous'),old)
        self.assertTrue((self.data/'.gcroots'/Path(self.package).name).is_symlink())
        r=self.run_update('--rollback','0.0.47-nightly.20261013.3')
        self.assertEqual(r.returncode,0,r.stderr)
        self.assertEqual(os.readlink(self.data/'current'),old)

    def test_existing_private_launcher_is_preserved_through_update_and_rollback(self):
        old=self.previous()
        launcher_dir=self.root/'private-bin'; launcher_dir.mkdir()
        desktop_dir=self.root/'private-data/applications'; desktop_dir.mkdir(parents=True)
        launcher=launcher_dir/'t3code-weasel'
        desktop=desktop_dir/'t3code-weasel.desktop'
        launcher_bytes=b'#!/bin/sh\n# credential-aware private launcher sentinel\nexit 91\n'
        desktop_bytes=b'[Desktop Entry]\n# user-owned desktop sentinel\n'
        launcher.write_bytes(launcher_bytes); launcher.chmod(0o710)
        desktop.write_bytes(desktop_bytes); desktop.chmod(0o600)
        launcher_before=hashlib.sha256(launcher_bytes).hexdigest()
        desktop_before=hashlib.sha256(desktop_bytes).hexdigest()
        launcher_mode=launcher.stat().st_mode & 0o777
        desktop_mode=desktop.stat().st_mode & 0o777
        self.env.update({'T3_WEASEL_MANAGED':'0','XDG_BIN_HOME':str(launcher_dir),
                         'XDG_DATA_HOME':str(self.root/'private-data')})

        r=self.run_update('--update')
        self.assertEqual(r.returncode,0,r.stderr)
        self.assertEqual(hashlib.sha256(launcher.read_bytes()).hexdigest(),launcher_before)
        self.assertEqual(launcher.stat().st_mode & 0o777,launcher_mode)
        self.assertEqual(hashlib.sha256(desktop.read_bytes()).hexdigest(),desktop_before)
        self.assertEqual(desktop.stat().st_mode & 0o777,desktop_mode)
        self.assertEqual(os.readlink(self.data/'current'),str(self.data/'versions'/VERSION))
        self.assertEqual(os.readlink(self.data/'previous'),old)
        self.assertTrue((self.data/'.gcroots'/Path(self.package).name).is_symlink())

        r=self.run_update('--rollback','0.0.47-nightly.20261013.3')
        self.assertEqual(r.returncode,0,r.stderr)
        self.assertEqual(os.readlink(self.data/'current'),old)
        self.assertEqual(hashlib.sha256(launcher.read_bytes()).hexdigest(),launcher_before)
        self.assertEqual(launcher.stat().st_mode & 0o777,launcher_mode)

    def test_stable_does_not_fall_back_to_nightly(self):
        self.env['T3_WEASEL_CHANNEL']='stable'
        r=self.run_update('--check'); self.assertNotEqual(r.returncode,0)
        self.assertIn('no fork-owned stable release',r.stderr)
        self.assertFalse(self.data.exists())

if __name__ == '__main__': unittest.main()
