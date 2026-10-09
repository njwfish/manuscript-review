"""Prepare one comment task and hand it to an installed agent CLI."""
import shlex
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path
from .feedback import feedback_report
from .setup import skill_directory
from .workspace import working_directory


AGENTS = {'codex': 'Codex', 'claude': 'Claude Code'}


def comment_task(record, directory, identifier, *, skill=None, launcher=None, dirty=False):
    if not isinstance(identifier, str) or not identifier:
        raise ValueError('Save this comment before sending it to an agent.')
    skill = Path(skill) if skill else skill_directory()
    launcher = Path(launcher) if launcher else skill / 'scripts/review-agent'
    report = feedback_report(record['snapshot'], record['decisions'], record['comments'],
                             record['history'], record['metadata']['id'], record['resolved'])
    note = next((item for item in [*report['comments'], *report['history']]
                 if identifier in (item['id'], item.get('discussion_id'))), None)
    if note is None or not note['comment'].strip():
        raise ValueError('Save this comment before sending it to an agent.')
    discussion = note.get('discussion_id', note['id'])
    directory = Path(directory)
    workspace = str(working_directory(record))
    if dirty or record['drafts']:
        scope = 'The manuscript has unsaved editor text. Think through this comment and reply without changing files.'
    elif any(edit['decision'] == 'pending' for edit in report['edits']):
        scope = 'The author is still reviewing this round. Think through this comment and reply without changing manuscript files or decisions.'
    else:
        scope = 'Work through this comment. Make only the surgical source changes it requires, preserving the author’s wording. Do not apply review decisions automatically.'
    prefix = f'{shlex.quote(str(launcher))} --home {shlex.quote(str(directory.parent.parent))}'
    prompt = f'''Address only discussion {discussion}, at {note['file']}:{note['line']}, including its earlier replies. Other comments are context, not additional tasks.
Read the Manuscript Review skill at {Path(skill) / 'SKILL.md'}. Use this exact command prefix for feedback, begin, finish, and respond: {prefix}.
Review {record['metadata']['id']} in {workspace}. The saved record is {directory / 'review.json'}.

Author’s comment:
{note['comment']}

Original quoted source (read the current manuscript before editing):
{note.get('before') or note.get('proposed') or ''}

{scope}
Read the current feedback and repository instructions first. Use begin before any source changes, follow the repository’s Git workflow, run its checks, then finish to publish a reviewable revision. Keep the original baseline and earlier rounds. For replies only, use the existing round. Append only your final, concise explanation to discussion {discussion} using respond; identify the published revision when wording changes, and keep your working conversation in this agent session. Preserve thread resolution and review decisions; the author owns both. Reread feedback before responding and respect its current revision. Return the resulting review ID and record path.'''
    return {'prompt': prompt, 'discussion': discussion, 'repo': workspace, 'revision': record['revision']}


def start_codex(executable, task, home):
    login = subprocess.run([executable, 'login', 'status'], cwd=task['repo'], stdin=subprocess.DEVNULL,
                           capture_output=True, text=True, timeout=15)
    if login.returncode:
        raise ValueError('Sign in to Codex CLI with codex login before sending a comment.')
    # A file-backed stdin avoids blocking on a large prompt while the CLI starts.
    with tempfile.TemporaryFile() as prompt:
        prompt.write(task['prompt'].encode())
        prompt.seek(0)
        process = subprocess.Popen([executable, 'exec', '--add-dir', str(home), '-'],
                                   cwd=task['repo'], stdin=prompt, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, start_new_session=True)
    threading.Thread(target=process.wait, daemon=True).start()


def start_claude(executable, task, home):
    result = subprocess.run([executable, '--bg', '--add-dir', str(home), '--', task['prompt']],
                            cwd=task['repo'], stdin=subprocess.DEVNULL, capture_output=True,
                            text=True, timeout=30, start_new_session=True)
    if result.returncode:
        raise ValueError(result.stderr.strip() or 'Claude Code could not start. Check its CLI login and settings.')


START = {'codex': start_codex, 'claude': start_claude}


def dispatch_comment(task, agent, home):
    if agent not in START:
        raise ValueError('Choose Codex or Claude Code.')
    executable = shutil.which(agent)
    if not executable:
        raise ValueError(f'{AGENTS[agent]} CLI is not installed or is not on PATH. Install and sign in to {agent} first.')
    START[agent](executable, task, home)
    return {'revision': task['revision'], 'message': f'Comment sent to {AGENTS[agent]}.'}
