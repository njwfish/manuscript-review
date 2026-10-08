#!/usr/bin/env python3
"""Typeset review passages using their pinned manuscript sources and local TeX."""
import argparse
import concurrent.futures
import hashlib
import io
import json
import re
import subprocess
import sys
import tarfile
from pathlib import Path
from .storage import atomic_json
from .comparison import git
from .latex_highlight import highlight_changes

SCAN = re.compile(r'%[^\n]*|\\(?:begin|end)\{[^}]+\}|\\[\[\]{}%$]|'
                  r'\\(?:begingroup|endgroup|bgroup|egroup)\b|\\[A-Za-z@]+|[{}]|\$\$?|\n[ \t]*\n')


def safe_boundaries(source):
    """Paragraph boundaries outside braces, math, and LaTeX environments."""
    boundaries, environments, braces, math = [0], [], 0, None
    for match in SCAN.finditer(source):
        token = match.group()
        if token.startswith('%'):
            continue
        if token == '\\begin{document}' or token == '\\end{document}':
            continue
        if token.startswith('\\begin{'):
            environments.append(token[7:-1])
        elif token.startswith('\\end{'):
            if environments and environments[-1] == token[5:-1]:
                environments.pop()
        elif token in ('{', '\\begingroup', '\\bgroup'):
            braces += 1
        elif token in ('}', '\\endgroup', '\\egroup'):
            braces -= 1
        elif token in ('$', '$$'):
            math = None if math == token else token if math is None else math
        elif token == '\\[':
            math = '\\['
        elif token == '\\]':
            math = None
        elif token.startswith('\n') and not environments and braces == 0 and math is None:
            boundaries.append(match.end())
    boundaries.append(len(source))
    return sorted(set(boundaries))


def render_context(source, span):
    start, end = span
    if start < 0 or end < start or end > len(source):
        raise ValueError('Review passage is outside its source version.')
    if start == end:
        return ''
    document = source.find('\\begin{document}')
    if document >= 0:
        lo = document + len('\\begin{document}')
        hi = source.find('\\end{document}', lo)
        hi = len(source) if hi < 0 else hi
        start, end = max(start, lo), min(end, hi)
        fragment = source[start:end]
        source = source[lo:hi]
        if not fragment.strip():
            return ''
        start, end = start - lo, end - lo
    boundaries = safe_boundaries(source)
    lo = max(p for p in boundaries if p <= start)
    hi = min(p for p in boundaries if p >= end)
    return source[lo:hi]


def run(command, cwd, log, timeout=180):
    with log.open('wb') as output:
        result = subprocess.run(command, cwd=cwd, stdout=output, stderr=subprocess.STDOUT, timeout=timeout)
    if result.returncode:
        lines = log.read_text(errors='replace').splitlines()
        raise RuntimeError(f'{command[0]} failed: ' + '\n'.join(lines[-18:]))


def prepare_sources(data, directory, side):
    root = directory / ('sources-' + side)
    revision = data['base'] if side == 'before' else data['proposed']
    if not root.exists():
        root.mkdir()
        archive = git(data['repo'], 'archive', revision)
        with tarfile.open(fileobj=io.BytesIO(archive)) as bundle:
            bundle.extractall(root, filter='data')
    # Each side has its own real manuscript references, citation numbers, and labels.
    entry = root / data.get('entry', 'main.tex')
    if not entry.is_file():
        raise ValueError(f'LaTeX entry file not present in this version: {entry.relative_to(root)}')
    if not entry.with_suffix('.aux').exists():
        run(['latexmk', '-pdf', '-interaction=nonstopmode', '-halt-on-error', entry.name],
            entry.parent, directory / (side + '-reference-build.log'))
    return root


def extra_macros(root, preamble):
    declarations = []
    for file in root.rglob('*.tex'):
        if file.name == 'review-previews.tex':
            continue
        source = re.sub(r'(?<!\\)%[^\n]*', '', file.read_text(errors='replace'))
        for match in re.finditer(r'(?m)^\s*(\\newcommand\*?\s*\{?\\[A-Za-z@]+)', source):
            name = re.search(r'\\([A-Za-z@]+)$', match[1])[1]
            if re.search(r'\\(?:newcommand|renewcommand|providecommand)\*?\s*\{?\\' + re.escape(name) + r'\b', preamble):
                continue
            cursor, depth, seen = match.start(), 0, False
            while cursor < len(source):
                character = source[cursor]
                if character == '{' and (cursor == 0 or source[cursor-1] != '\\'):
                    depth += 1
                    seen = True
                elif character == '}' and (cursor == 0 or source[cursor-1] != '\\'):
                    depth -= 1
                if seen and depth == 0 and character == '}' and (cursor + 1 == len(source) or source[cursor + 1] in '\n\r'):
                    break
                cursor += 1
            if cursor < len(source):
                declaration = source[match.start():cursor + 1].strip().replace('\\newcommand', '\\providecommand', 1)
                declarations.append(declaration)
    return '\n'.join(dict.fromkeys(declarations))


def typeset_side(data, directory, side):
    root = prepare_sources(data, directory, side)
    entry = root / data.get('entry', 'main.tex')
    main = entry.read_text()
    preamble = main.split('\\begin{document}', 1)[0]
    method_macros = extra_macros(root, preamble)
    labels = []
    reference_numbers = {}
    for line in '\n'.join(file.read_text(errors='replace') for file in root.rglob('*.aux')).splitlines():
        match = re.match(r'\\(newlabel|bibcite)\{([^}]+)\}(.*)', line)
        if match:
            prefix = 'r@' if match[1] == 'newlabel' else 'b@'
            labels.append('\\expandafter\\gdef\\csname ' + prefix + match[2] + '\\endcsname' + match[3])
            number = re.match(r'\{\{S?(\d+)\}', match[3]) if match[1] == 'newlabel' else None
            if number:
                reference_numbers[match[2]] = int(number[1])
    labels = '\n'.join(labels)
    snippets, lookup = [], {}
    for f in data['files']:
        if not f['path'].endswith('.tex'):
            continue
        source = f['before'] if side == 'before' else f['after']
        for h in f['hunks']:
            if source is None:
                continue
            context = render_context(source, h['base_span' if side == 'before' else 'proposal_span'])
            if not context.strip():
                continue
            before = render_context(f['before'] or '', h['base_span'])
            after = render_context(f['after'] or '', h['proposal_span'])
            colored = highlight_changes(before, after, side)
            # Suppress floats and isolated equation numbers in excerpt previews.
            content = re.sub(r'\\begin\{(figure|table|algorithm)\}(?:\[[^\]]*\])?',
                             lambda m: '\\begin{' + m[1] + '}[H]', colored)
            content = re.sub(r'\\(begin|end)\{equation\}', r'\\\1{equation*}', content)
            # An input figure can float; captions under review already carry their
            # surrounding figure environment through render_context.
            supplemental = f['path'].startswith('supplement/')
            revision = data['base'] if side == 'before' else data['proposed']
            key = hashlib.sha256((revision + str(supplemental) + content).encode()).hexdigest()[:20]
            if key not in lookup:
                lookup[key] = len(snippets)
                snippets.append((key, content, supplemental))
            h.setdefault('rendered', {})[side] = {
                'asset': side + '-' + key + '.svg', 'context': context,
                'extended': context.strip() != h[side].strip(), 'highlighted': True}
    if not snippets:
        return data
    document = preamble + r'''
\usepackage[active,tightpage]{preview}
\usepackage{xcolor,float}
\setlength\PreviewBorder{6pt}
\definecolor{reviewRemoved}{HTML}{A83245}
\definecolor{reviewAdded}{HTML}{15734E}
\newcommand{\reviewRemove}[1]{\begingroup\color{reviewRemoved}#1\endgroup}
\newcommand{\reviewAdd}[1]{\begingroup\color{reviewAdded}#1\endgroup}
\makeatletter
\@ifundefined{contcaption}{}{\renewcommand{\contcaption}[2][H]{\begin{figure}[H]\captionsetup{skip=0pt}\caption*{#2}\end{figure}}}
\@ifundefined{conttablecaption}{}{\renewcommand{\conttablecaption}[2][H]{\begin{table}[H]\captionsetup{skip=0pt}\caption*{#2}\end{table}}}
\makeatother
''' + method_macros + '\n\\begin{document}\n\\makeatletter\n' + labels + '\n\\makeatother\n'
    for key, content, supplemental in snippets:
        prefix = r'\renewcommand{\thefigure}{S\arabic{figure}}\renewcommand{\thetable}{S\arabic{table}}\makeatletter\@ifundefined{theproposition}{}{\renewcommand{\theproposition}{S\arabic{proposition}}}\makeatother' if supplemental else ''
        # Excerpts can repeat an enclosing float. Reset its displayed counter to
        # the actual manuscript label rather than the preview document sequence.
        for env in ('algorithm', 'figure', 'table', 'proposition', 'lemma', 'assumption'):
            match = re.search(r'\\begin\{' + env + r'\}.*?\\label\{([^}]+)\}', content, re.S)
            if match and match[1] in reference_numbers:
                prefix += '\\makeatletter\\@ifundefined{c@' + env + '}{}{\\setcounter{' + env + '}{' + str(reference_numbers[match[1]] - 1) + '}}\\makeatother'
        document += '\n\\begin{preview}\n\\begin{minipage}{\\textwidth}\n\\begingroup\n'
        document += '\\pagestyle{empty}\n' + prefix + '\n\\strut\n' + content
        document += '\n\\endgroup\n\\end{minipage}\n\\end{preview}\n'
    document += '\\end{document}\n'
    (entry.parent / 'review-previews.tex').write_text(document)
    run(['pdflatex', '-interaction=nonstopmode', '-halt-on-error', 'review-previews.tex'],
        entry.parent, directory / (side + '-previews-build.log'))
    # Conversion retains vector outlines, including the algorithmic package's output.
    for page, (key, _, _) in enumerate(snippets, 1):
        destination = directory / (side + '-' + key + '.svg')
        run(['pdftocairo', '-svg', '-f', str(page), '-l', str(page),
             'review-previews.pdf', str(destination)], entry.parent, directory / (side + '-convert.log'))
    print(f'{side}: {len(snippets)} actual LaTeX previews rendered', flush=True, file=sys.stderr)
    return data


def render(directory, data_override=None):
    directory = Path(directory).resolve()
    output = directory / 'renders'
    output.mkdir(exist_ok=True)
    data = data_override if data_override is not None else json.loads((directory / 'review.json').read_text())['snapshot']
    # Each worker writes only its own source directory and side of each manifest entry.
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(typeset_side, data, output, side) for side in ('before', 'after')]
        for future in futures:
            future.result()
    manifest = {h['id']: h.get('rendered', {}) for f in data['files'] for h in f['hunks']}
    atomic_json(output / 'manifest.json', manifest)
    print(f'Preview manifest ready: {output}', flush=True, file=sys.stderr)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--review', required=True)
    render(parser.parse_args().review)


if __name__ == '__main__':
    main()
