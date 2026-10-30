import React, { useEffect, useRef } from "react";
import * as monaco from "monaco-editor/editor/editor.api.js";
import "monaco-editor/basic-languages/monaco.contribution.js";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker";
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
monaco.editor.defineTheme("deck-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#191a1c",
    "editorGutter.background": "#191a1c",
    "diffEditor.insertedTextBackground": "#2a734133",
    "diffEditor.removedTextBackground": "#a9404033",
    "editorLineNumber.foreground": "#66686b",
    "editor.lineHighlightBackground": "#ffffff04",
  },
});
const language = (name) =>
  ({
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    json: "json",
    dart: "dart",
    py: "python",
    css: "css",
    scss: "scss",
    html: "html",
    md: "markdown",
    yaml: "yaml",
    yml: "yaml",
    toml: "ini",
    sh: "shell",
    go: "go",
    rs: "rust",
    java: "java",
    kt: "kotlin",
    sql: "sql",
    xml: "xml",
    swift: "swift",
  })[name?.split(".").pop()] || "plaintext";
export default function CodeView({ document, sideBySide, onDirty, onError }) {
  const host = useRef(),
    editor = useRef();
  useEffect(() => {
    if (!document) return;
    const options = {
      theme: "deck-dark",
      automaticLayout: true,
      fontFamily: "Cascadia Mono, Consolas, monospace",
      fontSize: 12,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      wordWrap: "off",
      padding: { top: 12 },
      renderLineHighlight: "gutter",
      glyphMargin: false,
      contextmenu: true,
    };
    let models = [],
      subscription;
    if (document.kind === "diff") {
      const diff = monaco.editor.createDiffEditor(host.current, {
        ...options,
        readOnly: true,
        originalEditable: false,
        renderSideBySide: sideBySide,
        enableSplitViewResizing: true,
        renderOverviewRuler: false,
        hideUnchangedRegions: {
          enabled: true,
          contextLineCount: 4,
          minimumLineCount: 8,
          revealLineCount: 10,
        },
      });
      const original = monaco.editor.createModel(
          document.original,
          language(document.path),
        ),
        modified = monaco.editor.createModel(
          document.modified,
          language(document.path),
        );
      models = [original, modified];
      diff.setModel({ original, modified });
      editor.current = diff;
    } else {
      const model = monaco.editor.createModel(
        document.text,
        language(document.path),
      );
      models = [model];
      const code = monaco.editor.create(host.current, {
        ...options,
        model,
        readOnly: document.readOnly === true,
      });
      if (!document.readOnly)
        subscription = model.onDidChangeContent(() =>
          onDirty(model.getValue()),
        );
      editor.current = code;
      if (document.line) {
        code.revealLineInCenter(document.line);
        code.setPosition({ lineNumber: document.line, column: 1 });
      }
      code.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
        window.dispatchEvent(new Event("deck-save")),
      );
    }
    return () => {
      subscription?.dispose();
      editor.current?.dispose();
      models.forEach((model) => model.dispose());
      editor.current = null;
    };
  }, [document?.key, sideBySide]);
  useEffect(() => {
    if (document?.kind === "diff" && editor.current) {
      const models = editor.current.getModel();
      if (models?.original.getValue() !== document.original)
        models.original.setValue(document.original);
      if (models?.modified.getValue() !== document.modified)
        models.modified.setValue(document.modified);
    }
  }, [document?.original, document?.modified]);
  return <div className="code-editor" ref={host} />;
}
