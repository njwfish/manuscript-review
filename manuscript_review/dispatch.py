"""Prepare one comment task and hand it to an installed agent CLI."""
import shlex
import json
import os
import re
import uuid
from datetime import datetime, timezone
import shutil
import subprocess
import tempfile
import threading
from pathlib import Path
from .feedback import feedback_report
from .setup import skill_directory
from .workspace import working_directory
from .comparison import git
from .storage import atomic_json, read_json


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
            'review': record['metadata']['id'], 'title': f"{note['file']}:{note['line']}",
            'git_directory': str((common if common.is_absolute() else repo / common).resolve())}


def dispatch_comment(task, agent, home, *, model=None):
    if agent not in AGENTS:
        raise ValueError('Choose Codex or Claude Code.')
    executable = shutil.which(agent)
    if not executable:
        raise ValueError(f'{AGENTS[agent]} CLI is not installed or is not on PATH. Install and sign in to {agent} first.')
    if model is not None and (not isinstance(model, str) or len(model) > 200 or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._:/-]*', model)):
        raise ValueError('Choose a model name or use the CLI default.')
    logs = Path(home) / 'agent-output'
    logs.mkdir(parents=True, exist_ok=True)
    session = str(uuid.uuid4()) if agent == 'claude' else None
    commands = {
        'codex': [executable, 'exec', '--json', '--thread-source', 'cli', '--sandbox', 'workspace-write'],
        'claude': [executable, '--bg', '--session-id', session, '--name', 'Manuscript: ' + task['title']]}
    command = [*commands[agent], *(['--model', model] if model else []), '--add-dir', str(home),
               '--add-dir', task['git_directory'], *(['-'] if agent == 'codex' else ['--', task['prompt']])]
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
    receipt = Path(output.name).with_suffix('.json')
    run = {key: task[key] for key in ('review', 'discussion', 'repo', 'title')}
    run.update(agent=agent, model=model, session=session, log=output.name, created=datetime.now(timezone.utc).isoformat(), status='running')
    atomic_json(receipt, run)
    def reap():
        code = process.wait()
        if code:
            with open(output.name, 'a') as log:
                log.write(f'\n{AGENTS[agent]} exited with status {code}. Check its CLI login and settings.\n')
        run.update(status='failed' if code else 'done' if agent == 'codex' else 'dispatched')
        atomic_json(receipt, run)
    threading.Thread(target=reap, daemon=True).start()
    return {'revision': task['revision'], 'discussion': task['discussion'], 'log': output.name,
            'message': f'Sent to {AGENTS[agent]} in the background.'}


def agent_runs(home, review):
    """Return handles to provider-owned conversations, never their transcripts."""
    runs = []
    for path in (Path(home) / 'agent-output').glob('*.json'):
        run = read_json(path)
        if run['review'] != review:
            continue
        if run['agent'] == 'codex' and not run['session']:
            with open(run['log']) as log:
                for line in log.read(65_536).splitlines():
                    try:
                        event = json.loads(line)
                    except ValueError:
                        continue
                    if event.get('type') == 'thread.started':
                        run['session'] = event['thread_id']
                        break
        runs.append(run)
    if any(run['agent'] == 'claude' for run in runs) and shutil.which('claude'):
        try:
            result = subprocess.run(['claude', 'agents', '--json', '--all'], capture_output=True, timeout=5, check=True)
            sessions = {item.get('sessionId'): item for item in json.loads(result.stdout)}
            for run in runs:
                if run['agent'] == 'claude' and run['session'] in sessions:
                    item = sessions[run['session']]
                    run.update(status=item.get('state', run['status']), job=item.get('id'))
        except (subprocess.SubprocessError, OSError, ValueError):
            pass
    return sorted(runs, key=lambda run: run['created'], reverse=True)


def agent_models(agent):
    if agent == 'claude':
        return [{'id': name, 'label': name.title()} for name in ('opus', 'sonnet', 'haiku')]
    if agent != 'codex':
        raise ValueError('Choose Codex or Claude Code.')
    cache = read_json(Path(os.environ.get('CODEX_HOME', Path.home() / '.codex')) / 'models_cache.json', {})
    return [{'id': model['slug'], 'label': model.get('display_name', model['slug'])}
            for model in cache.get('models', []) if model.get('slug') and model.get('visibility') != 'hidden']
