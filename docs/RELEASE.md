Manuscript Review 0.15.1 includes VS Code extension 0.2.1 and the standalone macOS app.

Native typing now reuses review data and unchanged comment locations, and sidebar
updates read a small summary. Interactive reads copy only the source they need.
Background reads no longer hold up saves, and record watchers no longer parse large
review records in the extension host.

Git and PDF pickers open immediately and refresh their choices in place. Sending a
comment keeps the focused panel open and reuses installed agent tools. Focused review
loads collapsed context when opened and combines queued decisions into the latest save.

Saved discussions, decisions, baselines, native buffers and source Undo are preserved.

See the README for installation, review controls, and the bundled agent skill.
