import { useEffect, useRef, type CSSProperties } from "react";
import { basicSetup } from "codemirror";
import { EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { StreamLanguage } from "@codemirror/language";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { oneDark } from "@codemirror/theme-one-dark";
import "./CodeEditor.css";

/**
 * CodeMirror 6 editor wrapper. Controlled-ish: `value` is pushed into the doc
 * when it changes externally (switching files); edits flow out via onChange.
 * Cmd/Ctrl-S calls onSave instead of the browser save dialog.
 */
export function CodeEditor({
  value,
  onChange,
  onSave,
  fontSize = 12,
  readOnly = false,
}: {
  value: string;
  onChange: (next: string) => void;
  onSave?: () => void;
  fontSize?: number;
  readOnly?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  useEffect(() => {
    if (!host.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        StreamLanguage.define(lua),
        oneDark,
        keymap.of([
          {
            key: "Mod-s",
            preventDefault: true,
            run: () => {
              onSaveRef.current?.();
              return true;
            },
          },
          // Tab / Shift-Tab indent (instead of moving focus) — expected in a
          // code editor.
          indentWithTab,
        ]),
        // Escape blurs the editor so keyboard users can Tab out (low priority,
        // so it yields to the autocomplete popup's own Escape when it's open).
        Prec.low(
          keymap.of([
            {
              key: "Escape",
              run: (v) => {
                v.contentDOM.blur();
                return true;
              },
            },
          ]),
        ),
        EditorView.editable.of(!readOnly),
        EditorState.readOnly.of(readOnly),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString());
        }),
        // Font size comes from the --fw-editor-fs CSS var (set by EditorTab) so
        // it can change without reconfiguring the editor; family stays here.
        EditorView.theme({
          "&": { height: "100%" },
          ".cm-scroller": { fontFamily: "var(--fw-font-mono)" },
        }),
      ],
    });
    const v = new EditorView({ state, parent: host.current });
    view.current = v;
    v.focus(); // land the caret in the editor when a file opens
    return () => {
      v.destroy();
      view.current = null;
    };
    // Create once; external value changes are synced by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly]);

  // Push external value changes (switching files) into the editor.
  useEffect(() => {
    const v = view.current;
    if (v && value !== v.state.doc.toString()) {
      v.dispatch({
        changes: { from: 0, to: v.state.doc.length, insert: value },
      });
    }
  }, [value]);

  // Re-measure after a font-size change so line heights/gutters stay aligned.
  useEffect(() => {
    view.current?.requestMeasure();
  }, [fontSize]);

  return (
    <div
      ref={host}
      className="fw-editor__cm"
      style={{ "--fw-editor-fs": `${fontSize}px` } as CSSProperties}
    />
  );
}
