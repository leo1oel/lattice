#!/usr/bin/env python3
"""Real human HTTP/CLI Git consumers; only temporary repositories/local bare remotes."""
import json
import os
from pathlib import Path
import subprocess
import unittest
from unittest import mock
import smoke

COMMANDS = ['git_user_name','git_show_diff','git_compare_files','git_compare_file','git_restore_file','git_restore_project','git_auto_commit']

class GitParity(unittest.TestCase):
    request = smoke.HeadlessSmoke.__dict__['request']
    login = smoke.HeadlessSmoke.__dict__['login']
    invoke = smoke.HeadlessSmoke.__dict__['invoke']

    @classmethod
    def setUpClass(cls):
        cls.environment = dict(os.environ, GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull, GIT_TERMINAL_PROMPT='0')
        with mock.patch.dict(os.environ, cls.environment, clear=True):
            smoke.HeadlessSmoke.setUpClass.__func__(cls)
        cls.root = cls.workspace / 'alpha'
        (cls.root / 'escape.txt').unlink()
        cls.environment = dict(os.environ, GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull, GIT_TERMINAL_PROMPT='0')
        cls.git('init', '-b', 'main')
        cls.git('config', 'user.name', 'Synthetic Writer')
        cls.git('config', 'user.email', 'synthetic@example.invalid')
        cls.bare = cls.base / 'remote.git'
        subprocess.run(['git','init','--bare',str(cls.bare)],env=cls.environment,check=True,capture_output=True)
        cls.git('remote','add','origin',str(cls.bare))
        cls.git('add','.')
        cls.git('commit','-m','Initial synthetic version')
        cls.initial = cls.git('rev-parse','HEAD')
        cls.git('push','-u','origin','main')
        # The server and CLI inherit no user Git identity/credential configuration.
        # The fixture supplies a repository-local identity and only a local remote.

    @classmethod
    def tearDownClass(cls):
        smoke.HeadlessSmoke.tearDownClass.__func__(cls)

    @classmethod
    def git(cls,*args,cwd=None):
        result=subprocess.run(['git',*args],cwd=cwd or cls.root,env=cls.environment,capture_output=True,text=True)
        assert result.returncode==0,result.stderr
        return result.stdout.strip()

    def api(self,command,args=None):
        status,result=self.invoke(command,args)
        self.assertEqual(status,200,result)
        return result['result']

    def test_a_native_timeline_record_compare_restore_and_cli(self):
        status,_,raw=self.request('GET','/api/capabilities',cookie=self.cookie)
        self.assertEqual(status,200)
        capabilities=json.loads(raw)['commands']
        self.assertTrue(set(COMMANDS).issubset(capabilities))
        self.assertTrue(set(['git_stage','git_branch','git_push']).isdisjoint(capabilities))
        self.assertEqual(self.api('git_user_name'),'Synthetic Writer')
        (self.root/'notes.md').write_text('version two\n')
        second=self.api('git_auto_commit',{'message':'Version two','author':None,'expectedHead':self.initial,'projectRoot':str(self.root)})
        diff=self.api('git_show_diff',{'rev':second,'path':'notes.md'})
        self.assertEqual((diff['before'],diff['after']),('alpha original\n','version two\n'))
        self.assertEqual(self.api('git_compare_file',{'from':self.initial,'to':second,'path':'notes.md'})['after'],'version two\n')
        files=self.api('git_compare_files',{'from':self.initial,'to':second})
        self.assertIn('notes.md',[entry['path'] for entry in files])
        (self.root/'notes.md').write_text('unsaved newer edit\n')
        self.assertEqual(self.invoke('git_restore_file',{'rev':self.initial,'path':'notes.md','expectedContent':'stale','expectedHead':second})[0],400)
        self.assertEqual(self.git('rev-parse','HEAD'),second)
        self.api('git_restore_file',{'rev':self.initial,'path':'notes.md','expectedContent':'unsaved newer edit\n','expectedHead':second,'projectRoot':str(self.root)})
        self.assertEqual((self.root/'notes.md').read_text(),'alpha original\n')
        backup=self.git('rev-parse','HEAD')
        self.assertEqual(self.git('show',backup+':notes.md'),'unsaved newer edit')
        third=self.api('git_auto_commit',{'message':'Restored file','expectedHead':backup})
        (self.root/'notes.md').write_text('latest project edit\n')
        restored=self.api('git_restore_project',{'rev':second,'expectedHead':third,'projectRoot':str(self.root)})
        self.assertEqual((self.root/'notes.md').read_text(),'version two\n')
        self.assertEqual(self.git('rev-parse','HEAD'),restored)
        self.assertEqual(self.git('show',restored+'^:notes.md'),'latest project edit')
        process=subprocess.run([smoke.BINARY,'invoke','git_compare_file','--project',str(self.root),'--state-dir',str(self.base/'cli-state')],input=json.dumps({'from':self.initial,'to':second,'path':'notes.md'}),capture_output=True,text=True,env=self.environment)
        self.assertEqual(process.returncode,0,process.stderr)
        self.assertEqual(json.loads(process.stdout)['result']['after'],'version two\n')
        self.assertEqual(self.git('rev-parse','refs/heads/main',cwd=self.bare),self.initial,'No API pushes to the bare remote')

    def test_b_conflicts_pins_paths_and_invalid_restore_do_not_commit(self):
        head=self.git('rev-parse','HEAD')
        (self.root/'notes.md').write_text('do not lose this edit\n')
        self.assertEqual(self.request('POST','/api/invoke',{'command':'git_auto_commit','args':{'message':'unauthenticated'}})[0],401)
        for command,values in [
            ('git_auto_commit',{'message':'stale','expectedHead':'0'*40}),
            ('git_restore_project',{'rev':self.initial,'expectedHead':'0'*40}),
            ('git_restore_file',{'rev':self.initial,'path':'notes.md','projectRoot':str(self.workspace/'beta')}),
            ('git_restore_file',{'rev':self.initial,'path':'../outside.txt'}),
            ('git_restore_project',{'rev':'--all'}),
            ('git_restore_file',{'rev':self.initial,'path':'absent.pdf'}),
        ]:
            self.assertEqual(self.invoke(command,values)[0],400,(command,values))
            self.assertEqual(self.git('rev-parse','HEAD'),head)
        self.assertEqual((self.root/'notes.md').read_text(),'do not lose this edit\n')
        outside=self.root/'link.md';outside.symlink_to(self.outside)
        for command,values in [('git_show_diff',{'rev':self.initial,'path':'link.md'}),('git_compare_file',{'from':self.initial,'path':'link.md'})]:
            self.assertEqual(self.invoke(command,values)[0],400)
        outside.unlink()

    def test_c_nested_project_snapshot_does_not_commit_sibling_staged_files(self):
        nested=self.root/'paper';nested.mkdir()
        (nested/'main.tex').write_text('nested paper\n')
        (self.root/'sibling.md').write_text('outside staged sentinel\n')
        self.git('add','sibling.md')
        process=subprocess.run([smoke.BINARY,'invoke','git_auto_commit','--project',str(nested),'--state-dir',str(self.base/'nested-state')],input=json.dumps({'message':'Nested project version'}),capture_output=True,text=True,env=self.environment)
        self.assertEqual(process.returncode,0,process.stderr)
        self.assertEqual(self.git('diff','--cached','--name-only'),'sibling.md')
        self.assertNotIn('sibling.md',self.git('ls-tree','--name-only','HEAD').splitlines())
        process=subprocess.run([smoke.BINARY,'invoke','git_compare_files','--project',str(nested),'--state-dir',str(self.base/'nested-state')],input=json.dumps({'from':self.initial}),capture_output=True,text=True,env=self.environment)
        self.assertNotEqual(process.returncode,0)
        self.assertIn('repository root',process.stderr)

if __name__=='__main__': unittest.main()
