import datetime as dt
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from urllib.parse import quote

SCRIPT = Path(__file__).with_name('resume.py')
START = 1793439642401
STAMP = dt.datetime.fromtimestamp((START + 1000) / 1000, dt.timezone.utc).isoformat()
CWD = '/tmp/my-project'


class ResumeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)

    def call(self, agent, command=None, others=(), end=9000):
        rec = {'id': 'run', 'agent': agent, 'cwd': CWD, 'created_ms': START, 'finished_ms': START + end,
               'command': command or agent}
        history = self.home / 'history.json'
        history.write_text(json.dumps({'records': [rec, *others]}))
        result = subprocess.run(['python3', '-I', str(SCRIPT), '--home', str(self.home), '--history', str(history), 'run'],
                                capture_output=True, text=True, check=True)
        return json.loads(result.stdout)

    def fixture(self, agent, sid, stamp=STAMP):
        if agent == 'claude':
            path = self.home / '.claude/projects/-tmp-my-project' / (sid + '.jsonl')
            row = {'cwd': CWD, 'sessionId': sid, 'timestamp': stamp}
        elif agent == 'codex':
            day = dt.datetime.fromtimestamp(START / 1000, dt.timezone.utc).strftime('%Y/%m/%d')
            path = self.home / '.codex/sessions' / day / (sid + '.jsonl')
            row = {'type': 'session_meta', 'payload': {'cwd': CWD, 'id': sid, 'timestamp': stamp}}
        elif agent == 'cmd':
            path = self.home / '.commandcode/projects/tmp-my-project' / (sid + '.jsonl')
            row = {'type': 'session', 'cwd': CWD, 'id': sid, 'timestamp': stamp}
        else:
            path = self.home / '.grok/sessions' / quote(CWD, safe='') / sid / 'summary.json'
            row = {'info': {'id': sid, 'cwd': CWD}, 'created_at': stamp}
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(row) + '\n')

    def test_exact_and_ambiguous(self):
        for agent in ('claude', 'codex', 'grok', 'cmd'):
            with self.subTest(agent=agent):
                self.fixture(agent, 'first')
                flag = 'resume' if agent == 'codex' else '--resume'
                self.assertEqual(self.call(agent), {'argv': [agent, flag, 'first'], 'cwd': CWD, 'session': 'first'})
                self.fixture(agent, 'second')
                result = self.call(agent)
                if agent == 'grok':
                    self.assertIn('no documented interactive resume picker', result['error'])
                else:
                    self.assertEqual(result, {'argv': [agent, flag], 'cwd': CWD, 'session': None})

    def test_late_start_and_next_run_bound(self):
        for agent, alias in (('claude', 'claude-code'), ('codex', 'codex'), ('grok', 'grok-build'), ('cmd', 'command-code')):
            with self.subTest(agent=agent):
                later = lambda seconds: dt.datetime.fromtimestamp((START + seconds * 1000) / 1000, dt.timezone.utc).isoformat()
                self.fixture(agent, 'late', later(49))
                self.fixture(agent, 'next', later(70))
                result = self.call(agent, end=100000)
                self.assertEqual(result['session'], 'late')
                neighbour = {'id': 'next-run', 'agent': alias, 'cwd': CWD, 'created_ms': START + 60000}
                self.assertEqual(self.call(agent, others=[neighbour], end=100000)['session'], 'late')
                neighbour['created_ms'] = START + 30000
                result = self.call(agent, others=[neighbour], end=100000)
                if agent == 'grok':
                    self.assertIn('error', result)
                else:
                    self.assertIsNone(result['session'])

    def test_absent_and_absolute_executable(self):
        self.assertEqual(self.call('command-code', '/opt/bin/cmd --trust'),
                         {'argv': ['/opt/bin/cmd', '--resume'], 'cwd': CWD, 'session': None})
        self.assertIn('error', self.call('grok'))


if __name__ == '__main__':
    unittest.main()
