import { ConfirmDialog } from "../ConfirmDialog.tsx";

/**
 * Before a document tab whose editor reports unsaved edits moves beside a conversation (대화 옆에).
 * The person decides: 취소, 저장하지 않고 옮기기, 저장하고 옮기기. `same` (the app's own comparison:
 * the editor's text equals the saved revision) is only said — it never chooses for the person.
 */
export function MoveQuestion({ name, certain, same, onSave, onDrop, onClose }: {
  name: string;
  /** The editor says it holds edits (else: it cannot tell). */
  certain: boolean;
  same: boolean;
  onSave: () => Promise<void>;
  onDrop: () => Promise<void>;
  onClose: () => void;
}) {
  const said = same
    ? [`「${name}」 편집기가 바뀐 내용이 있다고 알립니다. 저장된 판과 같아 보입니다.`]
    : [certain ? `「${name}」에 저장하지 않은 편집이 있습니다.` : `「${name}」 편집기에 저장하지 않은 편집이 있을 수 있습니다.`];
  return (
    <ConfirmDialog title="옮기기 전에 확인" tone="primary"
      lines={[...said, "저장하지 않고 옮기면 편집기에서 저장하지 않은 내용은 버리고, 파일은 그대로 둡니다.", "취소하면 문서는 지금 자리에 그대로 있습니다."]}
      confirmLabel="저장하고 옮기기" busyLabel="저장하는 중…" onConfirm={onSave}
      alternative={{ label: "저장하지 않고 옮기기", busyLabel: "옮기는 중…", run: onDrop }}
      onClose={onClose} />
  );
}
