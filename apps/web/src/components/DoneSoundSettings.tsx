import { DONE_SOUND_KEYS, SOUND_CHOICES, SOUND_KIND_LABEL, type DoneSoundPrefs, type SoundId, type SoundKind } from "../done-sound.ts";
import { SettingsRow, SettingsSwitch } from "./SettingsSheet.tsx";
import { Select } from "./ui/Select.tsx";

/** 설정 › 일반, under "끝나면 알림 보내기": the 완료 소리 rows. Every change saves at once; a new sound or 들어 보기 plays it. */
export function DoneSoundSettings({ prefs, onChange, preview }: {
  prefs: DoneSoundPrefs;
  onChange(patch: Record<string, unknown>): void;
  preview(id: SoundId, volume: number): void;
}) {
  const off = !prefs.on;
  return <>
    <SettingsRow className="done-sound" label="완료 소리" hint="답이 오거나, 확인이 필요하거나, 실패하면 짧은 소리를 냅니다. 창이 뒤에 있거나 다른 프로젝트를 보고 있어도 납니다."
      control={<SettingsSwitch label="완료 소리" checked={prefs.on} onChange={(next) => onChange({ [DONE_SOUND_KEYS.on]: next })} />} />
    <SettingsRow className="done-sound" label="소리 크기"
      control={<span className="done-sound-volume">
        <label className="slider-row"><input type="range" aria-label="소리 크기" min={0} max={100} step={5} value={prefs.volume} disabled={off}
          onChange={(event) => onChange({ [DONE_SOUND_KEYS.volume]: Number(event.target.value) })} /><span className="slider-value">{prefs.volume}%</span></label>
        <button type="button" className="button small" disabled={off || prefs.volume <= 0} onClick={() => preview(prefs.done, prefs.volume)}>들어 보기</button>
      </span>} />
    {(["done", "needs", "failed"] as const satisfies readonly SoundKind[]).map((kind) =>
      <SettingsRow key={kind} className="done-sound" label={SOUND_KIND_LABEL[kind]}
        control={<Select<SoundId> className="settings-select" label={`${SOUND_KIND_LABEL[kind]} 소리`} value={prefs[kind]} disabled={off}
          onChange={(id) => { onChange({ [DONE_SOUND_KEYS[kind]]: id }); preview(id, prefs.volume); }}
          options={SOUND_CHOICES.map((choice) => ({ value: choice.id, label: choice.label }))} />} />)}
    <SettingsRow className="done-sound" label="보고 있는 대화는 소리 내지 않기" hint="창을 앞에 두고 보고 있는 대화가 끝날 때는 소리를 내지 않습니다."
      control={<SettingsSwitch label="보고 있는 대화는 소리 내지 않기" checked={prefs.quietOnScreen} disabled={off} onChange={(next) => onChange({ [DONE_SOUND_KEYS.quietOnScreen]: next })} />} />
  </>;
}
