// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DONE_SOUND_DEFAULTS, doneSoundPrefs, soundPlayer } from "../done-sound.ts";
import { DoneSoundSettings } from "./DoneSoundSettings.tsx";
import { GeneralSection } from "./Connections.tsx";
import { chooseOption, chosenLabel } from "./ui/select-testing.ts";

afterEach(cleanup);

it("shows the defaults: 완료 소리 on, 45 %, three sounds, quiet for the conversation in front", () => {
  render(<DoneSoundSettings prefs={doneSoundPrefs({})} onChange={() => {}} preview={() => {}} />);
  expect(screen.getByRole("switch", { name: "완료 소리" })).toHaveProperty("checked", true);
  expect(screen.getByRole("slider", { name: "소리 크기" })).toHaveProperty("value", "45");
  expect(screen.getByText("45%")).toBeTruthy();
  expect(chosenLabel("끝났을 때 소리")).toBe("맑은 두 음");
  expect(chosenLabel("확인이 필요할 때 소리")).toBe("올라가는 세 음");
  expect(chosenLabel("실패했을 때 소리")).toBe("내려가는 두 음");
  expect(screen.getByRole("switch", { name: "보고 있는 대화는 소리 내지 않기" })).toHaveProperty("checked", true);
  for (const name of ["끝났을 때 소리", "확인이 필요할 때 소리", "실패했을 때 소리"]) {
    fireEvent.click(screen.getByRole("button", { name }));
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["맑은 두 음", "작은 종", "톡", "올라가는 세 음", "내려가는 두 음"]);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  }
});

it("saves each change under its own key and plays a newly picked sound once", () => {
  const onChange = vi.fn(), preview = vi.fn();
  render(<DoneSoundSettings prefs={DONE_SOUND_DEFAULTS} onChange={onChange} preview={preview} />);
  fireEvent.click(screen.getByRole("switch", { name: "완료 소리" }));
  expect(onChange).toHaveBeenLastCalledWith({ doneSound: false });
  fireEvent.change(screen.getByRole("slider", { name: "소리 크기" }), { target: { value: "35" } });
  expect(onChange).toHaveBeenLastCalledWith({ doneSoundVolume: 35 });
  chooseOption("확인이 필요할 때 소리", "작은 종");
  expect(onChange).toHaveBeenLastCalledWith({ doneSoundNeeds: "bell" });
  expect(preview).toHaveBeenLastCalledWith("bell", 45);
  fireEvent.click(screen.getByRole("switch", { name: "보고 있는 대화는 소리 내지 않기" }));
  expect(onChange).toHaveBeenLastCalledWith({ doneSoundQuietOnScreen: false });
  fireEvent.click(screen.getByRole("button", { name: "들어 보기" }));
  expect(preview).toHaveBeenLastCalledWith("chime", 45);
  expect(preview).toHaveBeenCalledTimes(2);
});

it("greys the other rows while 완료 소리 is off", () => {
  render(<DoneSoundSettings prefs={{ ...DONE_SOUND_DEFAULTS, on: false }} onChange={() => {}} preview={() => {}} />);
  expect(screen.getByRole("switch", { name: "완료 소리" })).toHaveProperty("disabled", false);
  expect(screen.getByRole("slider", { name: "소리 크기" })).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "들어 보기" })).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "끝났을 때 소리" })).toHaveProperty("disabled", true);
});

it("sits right under 끝나면 알림 보내기 in 설정 › 일반", () => {
  const { container } = render(<GeneralSection startScreen="home" onStartScreen={() => {}} notifications onNotifications={() => {}} brandMotion onBrandMotion={() => {}} onOnboarding={() => {}}
    sound={<DoneSoundSettings prefs={DONE_SOUND_DEFAULTS} onChange={() => {}} preview={() => {}} />} />);
  const labels = [...container.querySelectorAll(".settings-row-label")].map((label) => label.textContent);
  const at = labels.indexOf("끝나면 알림 보내기");
  expect(labels.slice(at, at + 7)).toEqual(["끝나면 알림 보내기", "완료 소리", "소리 크기", "끝났을 때", "확인이 필요할 때", "실패했을 때", "보고 있는 대화는 소리 내지 않기"]);
});

it("plays through one reused audio element per sound, at the chosen volume, and never at 0", () => {
  const made: { url: string; volume: number; play: ReturnType<typeof vi.fn> }[] = [];
  const play = soundPlayer((url) => { const element = { url, volume: 1, currentTime: 5, preload: "", play: vi.fn(() => Promise.resolve()) }; made.push(element); return element as unknown as HTMLAudioElement; });
  play("chime", 70); play("chime", 40); play("rise", 100); play("fall", 0);
  expect(made.map((element) => element.url.endsWith(".wav") || element.url.startsWith("data:audio"))).toEqual([true, true]);
  expect(made[0].play).toHaveBeenCalledTimes(2);
  expect(made[0].volume).toBe(0.4);
  expect(made[1].volume).toBe(1);
});
