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
from .comparison import git


AGENTS = {'codex': 'Codex', 'claude': 'Claude Code'}


def comment_task(record, directory, identifier, *, skill=None, launcher=None):
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
    prefix = f'{shlex.quote(str(launcher))} --home {shlex.quote(str(directory.parent.parent))}'
    prompt = f'''Address only discussion {discussion}, at {note['file']}:{note['line']}, including its earlier replies. Other comments are context, not additional tasks.
Read the Manuscript Review skill at {Path(skill) / 'SKILL.md'}. Use this exact command prefix for feedback, begin, finish, and respond: {prefix}.
Review {record['metadata']['id']} in {workspace}. The saved record is {directory / 'review.json'}.

Author’s comment:
{note['comment']}

Original quoted source (read the current manuscript before editing):
{note.get('before') or note.get('proposed') or ''}

Make the surgical manuscript changes this comment requests. The author may continue editing and reviewing in parallel. Use begin --parallel and edit only its returned proposal checkout; never overwrite the author’s working files. Unsaved author text remains context.
Read feedback --review {record['metadata']['id']} --thread {discussion} and repository instructions first. Use begin --review {record['metadata']['id']} --parallel before any source changes. Keep its starting_version, revision, and workspace. Follow the repository’s Git workflow and run its checks there. Use finish --review {record['metadata']['id']} --revision STARTING_REVISION --from STARTING_VERSION --workspace PROPOSAL_CHECKOUT to merge your changes into the current review. Clean changes accumulate as undecided edits against its fixed base; concurrent author edits and earlier agent results are preserved. If finish reports a conflict, begin a fresh parallel proposal against the current review, resolve the wording there, and finish with its new starting version. Keep the earlier checkout for reference; do not write to the author’s checkout. Keep the original baseline and earlier rounds. For replies only, use the existing review. Append only your final, concise explanation to discussion {discussion} using respond; identify the published revision when wording changes, and keep your working conversation in this agent session. Preserve thread resolution and review decisions; the author owns both. Reread scoped feedback before responding and respect its current revision. Return the resulting review ID and record path.'''
    repo = Path(record['snapshot']['repo'])
    common = Path(git(repo, 'rev-parse', '--git-common-dir').decode().strip())
    return {'prompt': prompt, 'discussion': discussion, 'repo': workspace, 'revision': record['revision'],
            'git_directory': str((common if common.is_absolute() else repo / common).resolve())}


def dispatch_comment(task, agent, home):
    if agent not in AGENTS:
        raise ValueError('Choose Codex or Claude Code.')
    executable = shutil.which(agent)
    if not executable:
        raise ValueError(f'{AGENTS[agent]} CLI is not installed or is not on PATH. Install and sign in to {agent} first.')
    logs = Path(home) / 'agent-output'
    logs.mkdir(parents=True, exist_ok=True)
    command = ([executable, 'exec', '--sandbox', 'workspace-write', '--add-dir', str(home), '--add-dir', task['git_directory'], '-'] if agent == 'codex'
               else [executable, '--bg', '--add-dir', str(home), '--add-dir', task['git_directory'], '--', task['prompt']])
    # Neither provider startup nor its working transcript blocks the author.
    with tempfile.NamedTemporaryFile(prefix=agent+'-', suffix='.log', dir=logs, delete=False) as output:
        with tempfile.TemporaryFile() as prompt:
            prompt.write(task['prompt'].encode())
            prompt.seek(0)
            try:
                process = subprocess.Popen(command, cwd=task['repo'], stdin=prompt,
                                           stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
            except OSError as error:
                raise ValueError(f'{AGENTS[agent]} could not start: {error}') from error
    def reap():
        code = process.wait()
        if code:
            with open(output.name, 'a') as log:
                log.write(f'\n{AGENTS[agent]} exited with status {code}. Check its CLI login and settings.\n')
    threading.Thread(target=reap, daemon=True).start()
    return {'revision': task['revision'], 'discussion': task['discussion'], 'log': output.name,
            'message': f'Sent to {AGENTS[agent]} in the background.'}
