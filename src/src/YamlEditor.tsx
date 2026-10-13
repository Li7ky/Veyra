import Editor, { loader } from "@monaco-editor/react";
import { useMemo } from "react";
import * as monaco from "monaco-editor";

// 本地打包 Monaco，不走 CDN（离线可用）
loader.config({ monaco });

/** Monaco YAML/JS 编辑器 + 简易 Clash schema 提示 */
export default function YamlEditor({
  value,
  onChange,
  placeholder,
  hint,
  language = "yaml",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  hint?: string;
  language?: "yaml" | "javascript" | "json";
}) {
  const options = useMemo(
    () => ({
      minimap: { enabled: false },
      fontSize: 12,
      fontFamily: "JetBrains Mono, Consolas, monospace",
      lineNumbers: "on" as const,
      wordWrap: "on" as const,
      automaticLayout: true,
      scrollBeyondLastLine: false,
      tabSize: 2,
      renderWhitespace: "selection" as const,
    }),
    []
  );

  return (
    <div className="yaml-editor monaco">
      {hint ? <div className="yaml-editor-hint">{hint}</div> : null}
      <div className="yaml-monaco-host">
        <Editor
          height="320px"
          language={language}
          theme="vs-dark"
          value={value || ""}
          options={options}
          onChange={(v) => onChange(v ?? "")}
          beforeMount={(monaco) => {
            // Clash Meta 常用字段补全
            monaco.languages.registerCompletionItemProvider("yaml", {
              provideCompletionItems: () => ({
                suggestions: [
                  "mixed-port",
                  "external-controller",
                  "secret",
                  "allow-lan",
                  "mode",
                  "log-level",
                  "dns",
                  "tun",
                  "proxies",
                  "proxy-groups",
                  "rules",
                  "prepend-rules",
                  "append-rules",
                  "delete-rules",
                  "prepend-proxies",
                  "append-proxies",
                  "delete-proxies",
                  "proxy-providers",
                  "rule-providers",
                  "unified-delay",
                  "tcp-concurrent",
                ].map((label) => ({
                  label,
                  kind: monaco.languages.CompletionItemKind.Keyword,
                  insertText: label,
                })),
              }),
            });
          }}
        />
        {!value && placeholder ? <div className="yaml-placeholder">{placeholder}</div> : null}
      </div>
    </div>
  );
}
