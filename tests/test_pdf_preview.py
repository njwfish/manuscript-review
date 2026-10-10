import tempfile
import unittest
import shutil
import json
import gzip
from pathlib import Path
from manuscript_review.latex_highlight import Units
from manuscript_review.pdf_preview import pdf_words, word_locations, paragraph_bounds, source_boxes, outer_boxes
from manuscript_review.comparison import git, build_snapshot
from manuscript_review.render_latex import render


class PDFPreviewTests(unittest.TestCase):
    def test_pdf_words_preserve_hyphenated_word_boxes_and_old_font_characters(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory)/'words.html'
            file.write_text('<html xmlns="http://www.w3.org/1999/xhtml"><page width="612" height="792">'
                            '<word xMin="1" yMin="2" xMax="10" yMax="12">param-</word>'
                            '<word xMin="1" yMin="14" xMax="8" yMax="24">eter</word>'
                            '<word xMin="10" yMin="14" xMax="18" yMax="24">\x08</word></page></html>')
            page = pdf_words(file)[0]
            self.assertEqual(page['words'][0]['text'], 'parameter')
            self.assertEqual(page['words'][0]['boxes'], [[1, 2, 10, 12], [1, 14, 8, 24]])
            self.assertEqual(page['width'], 612)

    def test_repeated_words_use_the_full_source_context_and_source_linked_region(self):
        source = 'We keep cells and measure cells.'
        words = ['We', 'keep', 'cells', 'and', 'measure', 'cells.']
        page = {'words': [{'text': word, 'boxes': [[i*20, 10, i*20+15, 20]]} for i, word in enumerate(words)]}
        start = source.rindex('cells')
        locations = word_locations(source, (start, start+5), Units(source).parse(), [page], [(1, (0, 10, 120, 20))], {1:[(1, (0, 10, 120, 20))]})
        self.assertEqual(locations, [(1, [100, 10, 115, 20])])
        # Another occurrence elsewhere in the PDF cannot steal the highlight.
        other = {'words': [{'text': word, 'boxes': [[i*20, 100, i*20+15, 110]]} for i, word in enumerate(words)]}
        locations = word_locations(source, (start, start+5), Units(source).parse(), [page, other], [(2, (0, 100, 120, 110))], {1:[(2, (0, 100, 120, 110))]})
        self.assertEqual(locations, [(2, [100, 100, 115, 110])])

    def test_partial_word_matching_does_not_claim_an_exact_location(self):
        source = 'We keep cells.'
        pages = [{'words': [{'text': 'We', 'boxes': [[0, 0, 10, 10]]}]}]
        start = source.index('keep')
        self.assertEqual(word_locations(source, (start, len(source)), Units(source).parse(), pages, [(1, (0, 0, 40, 10))], {1:[(1, (0, 0, 40, 10))]}), [])

    def test_macro_output_cannot_steal_a_repeated_literal_word(self):
        source = r'cells \myterm cells.'
        pages = [{'words': [{'text': word, 'boxes': [[i*20, 0, i*20+15, 10]]}
                            for i, word in enumerate(['cells', 'cells', 'cells.'])]}]
        start = source.rindex('cells')
        self.assertEqual(word_locations(source, (start, start+5), Units(source).parse(), pages, [(1, (0, 0, 60, 10))], {1:[(1, (0, 0, 60, 10))]}), [])

    def test_paragraph_context_preserves_crlf_offsets(self):
        source = 'First.\r\n\r\nSecond paragraph.\r\n\r\nThird.'
        start = source.index('paragraph')
        lo, hi = paragraph_bounds(source, (start, start+9))
        self.assertEqual(source[lo:hi], 'Second paragraph.')

    def test_compressed_coordinates_follow_ignored_form_points(self):
        with tempfile.TemporaryDirectory() as directory:
            pdf = Path(directory)/'main.pdf'
            with gzip.open(pdf.with_suffix('.synctex.gz'), 'wt') as stream:
                stream.write('SyncTeX Version:1\nInput:1:main.tex\nUnit:1\nMagnification:1000\nContent:\n'
                             '{1\n<2\nf3:0,4000000\n>\n(1,5:1000000,=:1000000,400000,0\n)\n}\nPost scriptum:\n')
            bounds = source_boxes(pdf)[(str((Path(directory)/'main.tex').resolve()), 5)][0][1]
            self.assertAlmostEqual(bounds[1], 3600000/65781.76)

    def test_post_processing_transforms_are_not_silently_ignored(self):
        with tempfile.TemporaryDirectory() as directory:
            pdf = Path(directory)/'main.pdf'
            with gzip.open(pdf.with_suffix('.synctex.gz'), 'wt') as stream:
                stream.write('SyncTeX Version:1\nPost scriptum:\nX Offset:10\n')
            with self.assertRaisesRegex(ValueError, 'post-processing transform'):
                source_boxes(pdf)

    def test_nested_math_boxes_do_not_stack_highlight_layers(self):
        line = (1, (10, 20, 100, 40))
        next_line = (1, (10, 50, 100, 70))
        locations = [line, (1, (20, 25, 30, 35)), line, next_line, (2, (20, 25, 30, 35))]
        self.assertEqual(outer_boxes(locations), [line, next_line, (2, (20, 25, 30, 35))])


@unittest.skipUnless(all(shutil.which(tool) for tool in ('git', 'latexmk', 'pdflatex', 'pdftocairo', 'pdftotext', 'pdfinfo')), 'Local TeX and Poppler are required.')
class CompiledPDFTests(unittest.TestCase):
    def compile(self, main, before, after, path='main.tex'):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        repo = root/'repo';repo.mkdir()
        for args in [('init', '-q'), ('config', 'user.name', 'Sample'), ('config', 'user.email', 'sample@localhost')]:
            git(repo, *args)
        (repo/'main.tex').write_text(main if path != 'main.tex' else before)
        (repo/path).write_text(before)
        git(repo, 'add', '-A');git(repo, 'commit', '-qm', 'Starting manuscript')
        base = git(repo, 'rev-parse', 'HEAD').decode().strip()
        (repo/path).write_text(after)
        git(repo, 'add', '-A');git(repo, 'commit', '-qm', 'Proposed manuscript')
        snapshot = build_snapshot(repo, base, 'HEAD')
        snapshot['entry'] = 'main.tex'
        (root/'preview').mkdir()
        render(root/'preview', snapshot)
        manifest = json.loads((root/'preview/renders/manifest.json').read_text())
        return snapshot, manifest

    def test_repeated_input_is_located_on_both_pdf_pages(self):
        main = '\\documentclass{article}\n\\begin{document}\n\\input{body}\n\\newpage\n\\input{body}\n\\end{document}\n'
        snapshot, manifest = self.compile(main, 'We score cells.\n', 'We measure cells.\n', 'body.tex')
        identifier = snapshot['files'][0]['edits'][0]['id']
        for side in ('before', 'after'):
            self.assertEqual({mark['page'] for mark in manifest['documents'][side]['edits'][identifier]}, {1, 2})

    def test_pdf_survives_an_excerpt_that_cannot_compile(self):
        source = '\\documentclass{article}\n\\begin{document}\n\\def\\myterm{cells}\n\nWe keep \\myterm.\n\\end{document}\n'
        _, manifest = self.compile(source, source, source.replace('keep', 'measure'))
        for side in ('before', 'after'):
            self.assertEqual(len(manifest['documents'][side]['pages']), 1)
            self.assertIn('excerpt_error', manifest['documents'][side])
        self.assertFalse(any(side.get('asset') for passage in manifest['passages'].values() for side in passage.values()))

    def test_one_bad_excerpt_leaves_other_passages_available(self):
        gap = 'Unchanged context. ' * 50 + '\n\n'
        source = '\\documentclass{article}\n\\begin{document}\n\\def\\myterm{cells}\n\nWe count leaves.\n\n' + gap + 'We keep \\myterm.\n\n' + gap + 'We score nodes.\n\\end{document}\n'
        _, manifest = self.compile(source, source, source.replace('count', 'inspect').replace('keep', 'measure').replace('score', 'sample'))
        for side in ('before', 'after'):
            previews = [passage[side] for passage in manifest['passages'].values()]
            self.assertEqual(sum(bool(preview.get('asset')) for preview in previews), 2)
            self.assertEqual(sum(bool(preview.get('error')) for preview in previews), 1)
            self.assertTrue(manifest['documents'][side]['pages'])

    def test_highlighted_derivative_compiles_on_both_sides(self):
        source = '\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\n\\[e_t=m_t.\\]\n\\end{document}\n'
        _, manifest = self.compile(source, source, source.replace('m_t', '\\dot m_t'))
        for side in ('before', 'after'):
            self.assertFalse(manifest['documents'][side].get('excerpt_error'))
            self.assertTrue(all(passage[side].get('asset') for passage in manifest['passages'].values()))

    def test_bibliography_item_commands_remain_outside_highlight_groups(self):
        source = '\\documentclass{article}\n\\begin{document}\n\\begin{thebibliography}{9}\n\\bibitem{old}Author.\n\\end{thebibliography}\n\\end{document}\n'
        _, manifest = self.compile(source, source, source.replace('{old}Author', '{new}Another author'))
        for side in ('before', 'after'):
            self.assertFalse(manifest['documents'][side].get('excerpt_error'))
            self.assertTrue(all(passage[side].get('asset') for passage in manifest['passages'].values()))

    def test_empty_side_uses_a_source_region_rather_than_a_false_point(self):
        source = '\\documentclass{article}\n\\begin{document}\nWe estimate cells.\n\\end{document}\n'
        snapshot, manifest = self.compile(source, source, source.replace('estimate', 'carefully estimate'))
        identifier = snapshot['files'][0]['edits'][0]['id']
        marks = manifest['documents']['before']['edits'][identifier]
        self.assertTrue(all(mark['location'] and mark['precision'] == 'region' for mark in marks))
        self.assertTrue(all(mark['bounds'][2]-mark['bounds'][0] > 10 for mark in marks))

    def test_multiline_display_math_uses_the_enclosing_equation_location(self):
        source = '\\documentclass{article}\n\\begin{document}\n\\[\nE=2\n\\]\n\\end{document}\n'
        snapshot, manifest = self.compile(source, source, source.replace('E=2', 'E=1'))
        identifier = snapshot['files'][0]['edits'][0]['id']
        for side in ('before', 'after'):
            marks = manifest['documents'][side]['edits'][identifier]
            self.assertTrue(marks)
            self.assertTrue(all(mark['bounds'] and mark['precision'] == 'region' for mark in marks))

    def test_a_macro_copy_on_another_page_does_not_receive_a_literal_word_highlight(self):
        source = '\\documentclass{article}\n\\newcommand{\\myterm}{cells}\n\\begin{document}\nWe keep cells.\n\\newpage\nWe keep \\myterm.\n\\end{document}\n'
        snapshot, manifest = self.compile(source, source, source.replace('We keep cells.', 'We keep animals.'))
        identifier = snapshot['files'][0]['edits'][0]['id']
        for side in ('before', 'after'):
            self.assertEqual({mark['page'] for mark in manifest['documents'][side]['edits'][identifier]}, {1})

    def test_landscape_pages_keep_their_actual_dimensions_and_locate_literal_prose(self):
        source = '\\documentclass{article}\n\\usepackage{pdflscape}\n\\begin{document}\nOrdinary page.\n\\newpage\n\\begin{landscape}\nWe score cells. This is a wide table.\n\\end{landscape}\n\\end{document}\n'
        snapshot, manifest = self.compile(source, source, source.replace('score', 'measure'))
        identifier = snapshot['files'][0]['edits'][0]['id']
        for side in ('before', 'after'):
            document = manifest['documents'][side]
            self.assertEqual((document['pages'][1]['width'], document['pages'][1]['height']), (792, 612))
            marks = document['edits'][identifier]
            self.assertTrue(all(mark['page'] == 2 and mark['precision'] == 'words' for mark in marks))
            self.assertTrue(all(130 < mark['bounds'][1] < 150 for mark in marks))

    def test_rotated_math_keeps_the_page_without_painting_false_geometry(self):
        source = '\\documentclass{article}\n\\usepackage{pdflscape}\n\\begin{document}\n\\begin{landscape}\n\\[\nE=2\n\\]\n\\end{landscape}\n\\end{document}\n'
        snapshot, manifest = self.compile(source, source, source.replace('E=2', 'E=1'))
        identifier = snapshot['files'][0]['edits'][0]['id']
        for side in ('before', 'after'):
            self.assertTrue(manifest['documents'][side]['pages'])
            marks = manifest['documents'][side]['edits'][identifier]
            self.assertTrue(marks)
            self.assertTrue(all(mark['bounds'] is None for mark in marks))

    def test_algorithm_text_is_located_in_the_full_manuscript(self):
        source = '\\documentclass{article}\n\\usepackage{algorithm,algpseudocode}\n\\begin{document}\n\\begin{algorithm}\n\\caption{Measurement}\n\\begin{algorithmic}[1]\n\\State Measure all cells\n\\end{algorithmic}\n\\end{algorithm}\n\\end{document}\n'
        snapshot, manifest = self.compile(source, source, source.replace('all cells', 'observed cells'))
        identifier = snapshot['files'][0]['edits'][0]['id']
        for side in ('before', 'after'):
            marks = manifest['documents'][side]['edits'][identifier]
            self.assertTrue(marks)
            self.assertTrue(all(mark['bounds'] and mark['page'] == 1 for mark in marks))
