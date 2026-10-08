"""Agent commands use the same review operations as the native interface."""
import argparse
import json
from pathlib import Path
from .library import Library, default_home
from .session import ReviewSession
from .repositories import working_snapshot
from .comparison import git
from . import __version__


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--version', action='version', version=__version__)
    parser.add_argument('--home', type=Path, default=default_home())
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('migrate', help='Upgrade a v5 library to file drafts; quit the app first.')
    checkpoint = commands.add_parser('checkpoint', help='Pin the actual manuscript before the first revision.')
    checkpoint.add_argument('--repo', required=True, type=Path)
    compare = commands.add_parser('compare', help='Create a review from two manuscript versions.')
    compare.add_argument('--repo', required=True, type=Path)
    compare.add_argument('--base', required=True)
    compare.add_argument('--proposed', default='working')
    compare.add_argument('--entry', default='')
    listing = commands.add_parser('list', help='List saved reviews, optionally for one repository.')
    listing.add_argument('--repo', type=Path)
    feedback = commands.add_parser('feedback', help='Read choices, notes, and earlier replies.')
    feedback.add_argument('--review', required=True)
    respond = commands.add_parser('respond', help='Append replies using discussion IDs from feedback.')
    respond.add_argument('--review', required=True)
    respond.add_argument('--revision', required=True, type=int)
    respond.add_argument('--responses', required=True, type=Path)
    apply = commands.add_parser('apply', help='Apply saved choices when the author has requested it.')
    apply.add_argument('--review', required=True)
    apply.add_argument('--revision', required=True, type=int)
    explain = commands.add_parser('explain', help='Explain passage or edit changes in the discussion.')
    explain.add_argument('--review', required=True)
    explain.add_argument('--revision', required=True, type=int)
    explain.add_argument('--explanations', required=True, type=Path)
    begin = commands.add_parser('begin', help='Pin the working draft before an agent changes it.')
    begin.add_argument('--review', required=True)
    finish = commands.add_parser('finish', help='Publish this pass as a reviewable round.')
    finish.add_argument('--review', required=True)
    finish.add_argument('--revision', required=True, type=int)
    finish.add_argument('--from', dest='starting_version', required=True)
    args = parser.parse_args()
    library = Library(args.home)
    try:
        if args.command == 'migrate':
            from .migrations.v5 import upgrade
            result = {'upgraded': upgrade(args.home), 'originals': 'migration-v5/review.json'}
        elif args.command == 'checkpoint':
            repo = str(args.repo.expanduser().resolve())
            starting, _ = working_snapshot(repo)
            git(repo, 'update-ref', 'refs/manuscript-review/inputs/' + starting, starting)
            result = {'repo': repo, 'starting_version': starting}
        elif args.command == 'compare':
            library.prepare({'repo': str(args.repo), 'base': args.base, 'proposed': args.proposed,
                             'entry': args.entry}, 'agent')
            result = library.jobs['agent']
            if result['status'] == 'error':
                raise ValueError(result['error'])
            result['path'] = str(library.directory(result['review']) / 'review.json')
        elif args.command == 'list':
            reviews = library.listing()
            if args.repo:
                repo = str(args.repo.expanduser().resolve())
                reviews = [r for r in reviews if r['repo'] == repo]
            result = reviews
        elif args.command == 'begin':
            result = library.begin(args.review)
        elif args.command == 'finish':
            metadata = library.metadata(args.review)
            library.prepare({**metadata, 'proposed': 'working', 'previous': args.review,
                             'starting_version': args.starting_version, 'expected_revision': args.revision,
                             'require_changes': True}, 'agent')
            result = library.jobs['agent']
            if result['status'] == 'error':
                raise ValueError(result['error'])
            result['path'] = str(library.directory(result['review']) / 'review.json')
        else:
            session = ReviewSession(library.directory(args.review))
            if args.command == 'respond':
                records = json.loads(args.responses.read_text())
                session.import_responses(records, args.revision)
            elif args.command == 'explain':
                records = json.loads(args.explanations.read_text())
                session.import_explanations(records, args.revision)
            elif args.command == 'apply':
                with session.store.transaction():
                    record = session.store.read()
                    session.update('apply', {'revision': args.revision, 'decisions': record['decisions'], 'comments': record['comments']})
            with session.store.transaction():
                record = session.store.read()
                result = {'review': args.review, 'revision': record['revision'],
                          'path': str(session.store.path), **session.report()}
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (ValueError, OSError, KeyError) as error:
        parser.exit(1, str(error) + '\n')


if __name__ == '__main__':
    main()
