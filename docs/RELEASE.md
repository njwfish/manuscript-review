Manuscript Review 0.15.0 includes VS Code extension 0.2.0 and the standalone macOS app.

Native source authoring now keeps one accumulated agent comparison against saved
author wording. Clean results join saved native files with undo; dirty buffers wait
for Save, and overlapping changes remain for explicit review. Focused review retains
Apply. Original baselines, comments, decisions and earlier comparisons are preserved.

The sidebar now chooses Codex or Claude Code and a model, reopens provider sessions,
and exposes retained proposals in the version picker. Working files can be either
comparison endpoint. Native saves refresh the view without rebuilding its panel.

See the README for installation, review controls, and the bundled agent skill.
