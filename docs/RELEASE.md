Manuscript Review 0.17.2 includes VS Code extension 0.3.3 and the standalone macOS app.

Native comments use point markers at adjacent paragraph breaks, with their exact
quotations retained separately. Navigation moves to the original source start without
selecting the whole passage. A blank first line and selections ending at the next
line’s start are handled without moving the marker into unrelated source.

Source comments no longer paint a permanent gutter stripe down the manuscript.
Select text and use the comment button in the editor title, the context menu, or
Cmd+Shift+M on macOS (Ctrl+Shift+M elsewhere). The View change action uses the native
diff icon. Comments, replies, unsent input, and review choices are preserved.

VS Code can still repeat its own gutter icon when a wrapped comment location has no
adjacent paragraph break. The editor remains native to VS Code.
