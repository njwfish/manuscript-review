"""Locate review edits on unchanged-layout PDF pages using SyncTeX and PDF words."""
import gzip
import re
import shutil
import unicodedata
import xml.etree.ElementTree as ET
from pathlib import Path
from .alignment import token_opcodes
from .latex_highlight import Units


def normalized(text):
    return ''.join(character for character in unicodedata.normalize('NFKC', text) if character.isalnum())


def pdf_words(path):
    # Older TeX fonts can make Poppler emit control characters in word text.
    document = ET.fromstring(re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', '', path.read_text()))
    pages = []
    for page in document.iter():
        if page.tag.rsplit('}', 1)[-1] != 'page':
            continue
        words = []
        for node in page.iter():
            if node.tag.rsplit('}', 1)[-1] == 'word':
                bounds = [float(node.attrib[key]) for key in ('xMin', 'yMin', 'xMax', 'yMax')]
                words.append({'text': node.text or '', 'boxes': [bounds]})
        joined = []
        for word in words:
            if joined and joined[-1]['text'].endswith(('-', '\u00ad')) and word['boxes'][0][1] > joined[-1]['boxes'][-1][1] + 3:
                joined[-1]['text'] = joined[-1]['text'][:-1] + word['text']
                joined[-1]['boxes'].extend(word['boxes'])
            else:
                joined.append(word)
        pages.append({'width': float(page.attrib['width']), 'height': float(page.attrib['height']), 'words': joined})
    return pages


def source_boxes(pdf):
    """Read source-linked horizontal boxes, retaining repeated source occurrences.

    SyncTeX's command-line query chooses one occurrence. The generated file
    preserves every occurrence and TeX's original line boxes in scaled points.
    """
    tags, index, stack = {}, {}, []
    page, vertical, form_depth, postscript = None, 0, 0, False
    scale, x_offset, y_offset = 1 / 65781.76, 0, 0
    unit, magnification = 1, 1000
    node_pattern = re.compile(r'([\[(hvkxg$])([0-9]+),([0-9]+)(?:,[0-9]+)?:(-?[0-9]+),(-?[0-9]+|=)(?::(-?[0-9]+),(-?[0-9]+),(-?[0-9]+))?')
    with gzip.open(pdf.with_suffix('.synctex.gz'), 'rt', errors='replace') as stream:
        if stream.readline().strip() != 'SyncTeX Version:1':
            raise ValueError('Unsupported SyncTeX output format.')
        for row in stream:
            if point := re.match(r'[\[(hvkxg$f][0-9]+(?:,[0-9]+){0,2}:(-?[0-9]+),(-?[0-9]+|=)', row):
                if point[2] != '=':
                    vertical = int(point[2])
            if row.startswith('Post scriptum:'):
                postscript = True
            if postscript and row.startswith(('Magnification:', 'X Offset:', 'Y Offset:')):
                raise ValueError('This PDF source map uses an unsupported post-processing transform.')
            if match := re.match(r'Input:(\d+):(.*)', row):
                tags[match[1]] = str((pdf.parent/Path(match[2])).resolve())
            elif row.startswith('Magnification:'):
                magnification = float(row.partition(':')[2]);scale = unit*magnification/1000/65781.76
            elif row.startswith('Unit:'):
                unit = float(row.partition(':')[2]);scale = unit*magnification/1000/65781.76
            elif row.startswith('X Offset:'):
                x_offset = float(row.partition(':')[2])
            elif row.startswith('Y Offset:'):
                y_offset = float(row.partition(':')[2])
            elif match := re.match(r'\{(\d+)\s*$', row):
                page = int(match[1]);stack = []
            elif row.startswith('}'):
                page = None;stack = []
            elif row.startswith('<'):
                form_depth += 1
            elif row.startswith('>'):
                form_depth = max(0, form_depth-1)
            elif row.strip() in (')', ']') and stack and not form_depth:
                stack.pop()
            elif page and not form_depth and (match := node_pattern.match(row)):
                kind, tag, line, x, y, width, height, depth = match.groups()
                vertical = vertical if y == '=' else int(y)
                box = None
                if kind in ('(', 'h') and width is not None and int(width) > 0 and int(height)+int(depth) > 0:
                    box = ((int(x)+x_offset)*scale, (vertical-int(height)+y_offset)*scale,
                           (int(x)+int(width)+x_offset)*scale, (vertical+int(depth)+y_offset)*scale)
                if kind in ('[', '('):
                    stack.append(box if kind == '(' else None)
                if box is None:
                    box = next((bounds for bounds in reversed(stack) if bounds), None)
                if box and tag in tags:
                    key = (tags[tag], int(line))
                    location = (page, box)
                    if location not in index.setdefault(key, []):
                        index[key].append(location)
    return index


def inside(word, bounds):
    x, y, right, bottom = word
    return bounds[0]-1 <= (x+right)/2 <= bounds[2]+1 and bounds[1]-3 <= (y+bottom)/2 <= bounds[3]+3


def outer_boxes(locations):
    """Keep line regions without layering their nested math boxes on top."""
    return [(page, box) for page, box in dict.fromkeys(locations)
            if not any(page == other_page and box != other and other[0] <= box[0] and other[1] <= box[1]
                       and other[2] >= box[2] and other[3] >= box[3] for other_page, other in locations)]


def paragraph_bounds(source, span):
    start, end = span
    breaks = list(re.finditer(r'\r?\n[ \t]*\r?\n', source))
    return (max((match.end() for match in breaks if match.end() <= start), default=0),
            min((match.start() for match in breaks if match.start() >= end), default=len(source)))


def word_locations(source, span, units, pages, regions, line_regions):
    """Align the enclosing source paragraph, preserving repeated-word positions."""
    start, end = span
    left, right = paragraph_bounds(source, span)
    tokens = [(normalized(source[a:b]), a, b) for a, b, *_ in units
              if left <= a and b <= right and not re.search(r'[\\{}$]', source[a:b]) and normalized(source[a:b])]
    page_numbers = {page for page, _ in regions}
    if any(pages[page-1].get('transformed') for page in page_numbers):
        tokens = [token for token in tokens if any(page in page_numbers
                  for line in range(source[:token[1]].count('\n')+1, source[:token[2]-1].count('\n')+2)
                  for page, _ in line_regions.get(line, []))]
    candidates = [(page, word) for page, data in enumerate(pages, 1) if page in page_numbers for word in data['words']
                  if normalized(word['text']) and any(page == number and (data.get('transformed') or any(inside(box, bounds) for box in word['boxes']))
                                                     for number, bounds in regions)]
    source_tokens, output_tokens = [token[0] for token in tokens], [normalized(word['text']) for _, word in candidates]
    wanted = [token for token in tokens if token[1] < end and token[2] > start]
    # Rotated pages lack usable source geometry. Only a unique, complete literal
    # paragraph can replace it; partial alignment would hide an ambiguous match.
    if any(pages[page-1].get('transformed') for page, _ in candidates):
        matches = [i for i in range(len(output_tokens)-len(source_tokens)+1)
                   if source_tokens and output_tokens[i:i+len(source_tokens)] == source_tokens]
        if len(matches) != 1:
            return []
        candidates = candidates[matches[0]:matches[0]+len(source_tokens)]
        output_tokens = source_tokens
    # Skipped macro output must not steal a repeated literal word's position.
    if source_tokens != output_tokens and any(source_tokens.count(token[0]) > 1 or output_tokens.count(token[0]) > 1 for token in wanted):
        return []
    locations, matched = [], 0
    for operation, a, b, c, _ in token_opcodes(source_tokens, output_tokens):
        if operation != 'equal':
            continue
        for offset in range(b-a):
            _, lo, hi = tokens[a+offset]
            if lo < end and hi > start:
                page, word = candidates[c+offset]
                own_regions = [region for line in range(source[:lo].count('\n')+1, source[:hi-1].count('\n')+2)
                               for region in line_regions.get(line, [])]
                if all(any(page == number and (pages[page-1].get('transformed') or inside(bounds, region))
                           for number, region in own_regions) for bounds in word['boxes']):
                    matched += 1
                    locations.extend((page, bounds) for bounds in word['boxes'])
    return locations if wanted and matched == len(wanted) else []


def document_preview(data, directory, side, root, run):
    if not all(shutil.which(tool) for tool in ('pdftotext', 'pdfinfo')):
        return {'pages': [], 'edits': {}, 'error': 'PDF locations require pdftotext and pdfinfo.'}
    entry = root / data['entry']
    pdf = entry.with_suffix('.pdf')
    words_file = directory / (side + '-pdf-words.html')
    run(['pdftotext', '-bbox', str(pdf), str(words_file)], entry.parent, directory / (side + '-pdf-words.log'))
    pages = pdf_words(words_file)
    try:
        source_regions = source_boxes(pdf)
        location_error = None
    except (OSError, ValueError) as error:
        source_regions, location_error = {}, str(error)
    revision = data['base' if side == 'before' else 'proposed']
    prefix = side + '-pdf-' + revision[:12]
    shutil.copyfile(pdf, directory / (prefix + '.pdf'))
    info = directory / (side + '-pdf-info.log')
    run(['pdfinfo', '-f', '1', '-l', str(len(pages)), str(pdf)], entry.parent, info)
    rotated = {int(number) for number, degrees in re.findall(r'Page\s+(\d+) rot:\s+(-?\d+)', info.read_text()) if int(degrees) % 360}
    for number, page in enumerate(pages, 1):
        page['asset'] = prefix + f'-{number}.svg'
        run(['pdftocairo', '-svg', '-f', str(number), '-l', str(number), str(pdf), str(directory / page['asset'])],
            entry.parent, directory / (side + '-pdf-convert.log'))
        _, _, width, height = map(float, ET.parse(directory / page['asset']).getroot().attrib['viewBox'].split())
        page['transformed'] = number in rotated or (page['width'], page['height']) != (width, height)
        page.update(width=width, height=height)
    edits = {}
    for file in data['files']:
        source = file['before' if side == 'before' else 'after']
        if not source or not file['path'].endswith('.tex'):
            continue
        parsed = Units(source)
        units = parsed.parse()
        path = str((root/file['path']).resolve())
        line_regions = {line: bounds for (name, line), bounds in source_regions.items() if name == path}
        if file['path'] == data['entry']:
            body = source.find('\\begin{document}')
            units = [unit for unit in units if unit[0] > body + len('\\begin{document}')] if body >= 0 else units
        for edit in file['edits']:
            span = edit['base_span' if side == 'before' else 'proposal_span']
            start, end = span
            math_span = min((scope for scope in parsed.math_spans if scope[0] <= start and end <= scope[1]),
                            key=lambda scope: scope[1]-scope[0], default=None)
            visible = [unit for unit in units if unit[0] < end and unit[1] > start]
            if not visible and not math_span and start != end:
                continue
            # Prose alignment needs its whole paragraph, not an isolated repeated word.
            left, right = paragraph_bounds(source, span)
            query_start, query_end = math_span or ((start, end) if edit['math'] or start == end else (left, right))
            first = source[:query_start].count('\n')+1
            last = source[:max(query_start, query_end-1)].count('\n')+1
            regions = []
            for line in range(first, last+1):
                regions.extend(item for item in line_regions.get(line, []) if item not in regions)
            # Each source occurrence has its own text alignment, including repeated inputs.
            locations = [] if edit['math'] else [box for number in sorted({page for page, _ in regions})
                         for box in word_locations(source, span, units, pages, [(page, bounds) for page, bounds in regions if page == number], line_regions)]
            precision = 'words' if locations else 'region'
            selected_start, selected_end = math_span or span
            selected_regions = [region for line in range(source[:selected_start].count('\n')+1, source[:max(selected_start, selected_end-1)].count('\n')+2)
                                for region in line_regions.get(line, [])]
            for page, bounds in locations or outer_boxes(selected_regions):
                if 1 <= page <= len(pages):
                    if not locations and (pages[page-1]['transformed'] or
                            not (0 <= bounds[0] < bounds[2] <= pages[page-1]['width'] and
                                 0 <= bounds[1] < bounds[3] <= pages[page-1]['height'])):
                        bounds = None
                    mark = {'page': page, 'bounds': bounds, 'precision': precision, 'location': start == end}
                    if mark not in edits.setdefault(edit['id'], []):
                        edits[edit['id']].append(mark)
    return {'pdf': prefix + '.pdf', 'pages': [{key: value for key, value in page.items() if key not in ('words', 'transformed')} for page in pages],
            'edits': edits, 'location_error': location_error}
