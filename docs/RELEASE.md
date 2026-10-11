Manuscript Review 0.15.2 includes VS Code extension 0.2.2 and the standalone macOS app.

Native Send displays the saved comment immediately and prepares the agent task in one
service request. Source and sidebar refreshes continue in the background. The selected
CLI runs independently of the editor.

Comments reuse an existing pinned source when its wording matches the captured text.
Unsaved text and comments on deleted files retain exact source checkpoints. Mutable
review state reuses the serialized comparison within the same atomic JSON record;
comments, drafts, decisions and navigation avoid copying unchanged source. Entering
authoring and loading a comparison also avoid redundant copies.

Saved discussions, decisions, baselines, native buffers and source Undo are preserved.

See the README for installation, review controls, and the bundled agent skill.
