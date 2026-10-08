"""Local prerequisites and explicit installation of the bundled agent skill."""
import shutil
import subprocess
import sys
from pathlib import Path


AGENTS = {'codex': ('Codex', ('.agents/skills', '.codex/skills')),
          'claude': ('Claude Code', ('.claude/skills',))}


def skill_directory():
    root = (Path(sys.executable).resolve().parent.parent if getattr(sys, 'frozen', False)
            else Path(__file__).resolve().parent.parent)
    return root / 'skills/manuscript-review'


def git_available():
    command = shutil.which('git')
    if command == '/usr/bin/git' and sys.platform == 'darwin':
        # Apple's Git stub exists before the Command Line Tools do. Checking
        # xcode-select avoids launching their installer merely to open Setup.
        return subprocess.run(['xcode-select', '-p'], capture_output=True).returncode == 0
    return bool(command)


def agent_status(agent, home, source):
    name, folders = AGENTS[agent]
    targets = [Path(home) / folder / 'manuscript-review' for folder in folders]
    # Honor an existing personal installation before creating another link.
    target = next((path for path in targets if path.exists() or path.is_symlink()), targets[0])
    occupied = target.exists() or target.is_symlink()
    installed = (target / 'SKILL.md').is_file()
    return {'id': agent, 'name': name, 'path': str(target), 'installed': installed,
            'occupied': occupied, 'linked': occupied and target.resolve() == source.resolve()}


def setup_status(home=None):
    home, source = Path(home or Path.home()), skill_directory()
    tools = {name: shutil.which(name) for name in ('latexmk', 'pdflatex', 'pdftocairo', 'pdftotext', 'pdfinfo')}
    return {'git': git_available(), 'preview_tools': tools, 'skill_available': (source / 'SKILL.md').is_file(),
            'agents': [agent_status(agent, home, source) for agent in AGENTS]}


def install_skill(agent, home=None):
    if agent not in AGENTS:
        raise ValueError('Choose Codex or Claude Code.')
    home, source = Path(home or Path.home()), skill_directory()
    if not (source / 'SKILL.md').is_file():
        raise ValueError('The bundled skill is missing. Use the app release or a source checkout.')
    status = agent_status(agent, home, source)
    if status['linked']:
        return {'message': f'{status["name"]} already has this skill.'}
    if status['occupied']:
        raise ValueError(f'A skill already exists at {status["path"]}. It was kept in place; remove it explicitly before installing another copy.')
    target = Path(status['path'])
    target.parent.mkdir(parents=True, exist_ok=True)
    target.symlink_to(source, target_is_directory=True)
    return {'message': f'Skill installed for {status["name"]}. Start a new agent session to use it.'}
