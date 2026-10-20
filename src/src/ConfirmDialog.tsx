import { useEffect, useRef } from "react";
import { t } from "./i18n";

/** 焦点圈闭：容器内 Tab/Shift+Tab 循环，不逃到遮罩后的背景页面。
 *  传 active=false 时不生效（组件未挂载或不可用）。 */
export function useFocusTrap<T extends HTMLElement>(active: boolean) {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const list = Array.from(
        root.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        )
      ).filter((n) => !n.hasAttribute("disabled") && n.offsetParent !== null);
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      const cur = document.activeElement as HTMLElement | null;
      const inside = cur ? root.contains(cur) : false;
      if (e.shiftKey) {
        if (!inside || cur === first) {
          e.preventDefault();
          last.focus();
        }
      } else if (!inside || cur === last) {
        e.preventDefault();
        first.focus();
      }
    };
    root.addEventListener("keydown", onKey);
    return () => root.removeEventListener("keydown", onKey);
  }, [active]);
  return ref;
}

export type ConfirmRequest = {
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  onConfirm: () => void;
};

/** 统一二次确认弹窗：危险操作先问一句。
 *  - Esc / 点遮罩 = 取消（默认焦点在「取消」上，误按回车不会触发危险操作）
 *  - Tab 焦点圈闭在弹窗内 */
export default function ConfirmDialog({
  req,
  onClose,
}: {
  req: ConfirmRequest | null;
  onClose: () => void;
}) {
  const boxRef = useFocusTrap<HTMLDivElement>(!!req);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!req) return;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [req, onClose]);

  if (!req) return null;
  return (
    <div className="modal-mask" onClick={onClose}>
      <div
        className="modal-box confirm-box"
        role="dialog"
        aria-modal="true"
        aria-label={req.title}
        ref={boxRef}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>{req.title}</h3>
        <p className="confirm-msg">{req.message}</p>
        <div className="confirm-actions">
          <button ref={cancelRef} type="button" className="btn ghost btn-sm" onClick={onClose}>
            {req.cancelText || t("common.cancel", "取消")}
          </button>
          <button
            type="button"
            className={req.danger ? "btn danger btn-sm" : "btn primary btn-sm"}
            onClick={() => {
              onClose();
              req.onConfirm();
            }}
          >
            {req.confirmText || t("common.confirm", "确认")}
          </button>
        </div>
      </div>
    </div>
  );
}
