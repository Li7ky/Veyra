import Editor, { loader } from "@monaco-editor/react";
import { useEffect, useMemo, useState } from "react";
import * as monaco from "monaco-editor";

// 本地打包 Monaco，不走 CDN（离线可用）
loader.config({ monaco });

const YAML_COMPLETIONS = [
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
];

/** 注册 YAML 补全。
 *  原先放在 <Editor beforeMount> 里：monaco.languages.registerCompletionItemProvider
 *  每次挂载都会新增一份注册且从不 dispose（monaco 全局单例），
 *  反复打开/关闭编辑器后同一个下拉里会出现 N 份重复候选。
 *  补全项与组件状态无关，因此用模块级标记保证整个进程只注册一次。 */
let completionRegistered = false;
function ensureYamlCompletions() {
  if (completionRegistered) return;
  completionRegistered = true;
  monaco.languages.registerCompletionItemProvider("yaml", {
    // range 必填：直接 import 的 monaco 类型比 @monaco-editor/react 回调里
    // 传进来的实例更严格，缺 range 会编译报错。
    // 用当前光标位置作为插入范围，等价于「替换正在输入的词」。
    provideCompletionItems: (model, position) => {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      return {
        suggestions: YAML_COMPLETIONS.map((label) => ({
          label,
          kind: monaco.languages.CompletionItemKind.Keyword,
          insertText: label,
          range,
        })),
      };
    },
  });
}

/** 跟随应用主题：读取 <html data-theme>，并在主题切换时实时更新。
 *  之前 theme="vs-dark" 是硬编码的，浅色界面里会显示成刺眼的黑色大块。 */
function useEditorTheme(): "vs" | "vs-dark" {
  const read = (): "vs" | "vs-dark" =>
    document.documentElement.getAttribute("data-theme") === "light" ? "vs" : "vs-dark";
  const [theme, setTheme] = useState<"vs" | "vs-dark">(read);
  useEffect(() => {
    const root = document.documentElement;
    const mo = new MutationObserver(() => setTheme(read()));
    mo.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    setTheme(read());
    return () => mo.disconnect();
  }, []);
  return theme;
}

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
  const editorTheme = useEditorTheme();
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
          height="100%"
          language={language}
          theme={editorTheme}
          value={value || ""}
          options={options}
          onChange={(v) => onChange(v ?? "")}
          beforeMount={() => {
            ensureYamlCompletions();
          }}
        />
        {!value && placeholder ? <div className="yaml-placeholder">{placeholder}</div> : null}
      </div>
    </div>
  );
}
