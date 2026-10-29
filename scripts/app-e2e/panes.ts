import type { LaunchOptions } from "./launch.ts";
import { installProbe, pageErrors, record, recorded, shot, until, type Ctx } from "./scenarios.ts";
import { center, moveSteps } from "./webdriver.ts";

type SavedLayout = { version: number; focus: string; panes: { id: string }[]; tree: unknown };
const snapshot = (ctx: Ctx) => ctx.app.api<{ prefs: { paneLayout?: SavedLayout } }>("GET", "/api/snapshot");
const layoutJSON = async (ctx: Ctx) => JSON.stringify((await snapshot(ctx)).prefs.paneLayout);

export async function panesScenario(ctx: Ctx, launch: Omit<LaunchOptions, "name">) {
  const S = "2 중첩 분할";
  let wd = ctx.app.wd;
  await wd.setWindowRect({ width: 1500, height: 1000 });
  const click = async (selector: string) => wd.click(await wd.waitFor(selector));
  await click('.topbar-right button[aria-label="오른쪽으로 분할"]');
  await click('.pane[data-pane="a"] button[aria-label="아래로 분할"]');
  await click('.pane[data-pane="pane-1"] button[aria-label="아래로 분할"]');
  await until(async () => (await wd.findAll('.pane:not([hidden])')).length === 4);
  const geometry = await wd.execute<{ id: string; x: number; y: number; width: number; height: number }[]>(`return [...document.querySelectorAll('.pane:not([hidden])')].map(p => { const r=p.getBoundingClientRect(); return {id:p.dataset.pane,x:r.x,y:r.y,width:r.width,height:r.height}; });`);
  const overlaps = geometry.some((a, i) => geometry.slice(i + 1).some((b) => a.x < b.x + b.width - 1 && a.x + a.width > b.x + 1 && a.y < b.y + b.height - 1 && a.y + a.height > b.y + 1));
  ctx.report.check(S, "좌우·상하 분할로 네 칸 생성, 겹침 없음", geometry.length === 4 && !overlaps && geometry.every((r) => r.width >= 359 && r.height >= 219), JSON.stringify(geometry), await shot(ctx, "2-four-panes.png"));
  if (geometry.length !== 4 || overlaps) throw new Error("Invalid four-pane geometry");

  // Place a marker on the existing DOM node: a move must preserve its identity.
  await wd.execute(`document.querySelector('.pane[data-pane="a"]').dataset.nativeIdentity = 'original'; return true;`);
  const source = await wd.waitFor('.pane[data-pane="a"] .pane-head-title');
  const target = await wd.waitFor('.pane[data-pane="pane-3"]');
  const from = center(await wd.rect(source)), to = center(await wd.rect(target));
  await record(wd);
  await wd.pointer([{ type: "pointerMove", ...from }, { type: "pointerDown", button: 0 }, ...moveSteps(from, to, 16), { type: "pointerUp", button: 0 }]);
  const events = await recorded(wd);
  const moved = await wd.rect(await wd.waitFor('.pane[data-pane="a"]'));
  const targetBefore = geometry.find((r) => r.id === "pane-3")!;
  const identity = await wd.attribute(await wd.waitFor('.pane[data-pane="a"]'), "data-native-identity");
  ctx.report.check(S, "실제 드래그로 칸 교환, 기존 화면 노드 유지", events.trusted && Math.abs(moved.x - targetBefore.x) < 2 && Math.abs(moved.y - targetBefore.y) < 2 && identity === "original", JSON.stringify(events), await shot(ctx, "2-moved-pane.png"));

  const divider = await wd.waitFor('.pane-divider.vertical');
  await wd.click(divider);
  const ratioBefore = Number(await wd.attribute(divider, "aria-valuenow"));
  await wd.press("\uE015"); // ArrowDown
  await until(async () => Number(await wd.attribute(divider, "aria-valuenow")) !== ratioBefore);
  ctx.report.check(S, "상하 경계선을 키보드로 조절", Number(await wd.attribute(divider, "aria-valuenow")) > ratioBefore);
  await wd.setWindowRect({ width: 900, height: 700 });
  const narrow = await until(async () => (await wd.findAll('.pane:not([hidden])')).length === 1);
  ctx.report.check(S, "좁은 창에서 한 칸만 표시하고 나머지는 보존", narrow && (await wd.findAll('.pane')).length === 4);
  await wd.setWindowRect({ width: 1500, height: 1000 });
  ctx.report.check(S, "창을 넓히면 네 칸 복원", await until(async () => (await wd.findAll('.pane:not([hidden])')).length === 4));
  await until(async () => (await snapshot(ctx)).prefs.paneLayout?.panes.length === 4);
  // Wait for the final resize/focus preferences to settle before closing the app.
  let saved = await layoutJSON(ctx);
  await until(async () => { const next = await layoutJSON(ctx); const same = saved === next; saved = next; return same; }, 3000, 350);
  const oldOrigin = ctx.app.gateway.url;
  const errorsBefore = await pageErrors(wd);
  await ctx.app.close();
  ctx.app = await ctx.stage.launch({ ...launch, name: "panes-restarted", freshPort: true, window: { width: 1500, height: 1000 } });
  wd = ctx.app.wd;
  await installProbe(wd);
  const restored = await until(async () => (await wd.findAll('.pane:not([hidden])')).length === 4, 20_000);
  const after = await layoutJSON(ctx);
  ctx.report.check(S, "앱을 종료하고 새 포트로 재시작해 배치·비율·초점 복원", restored && saved === after && oldOrigin !== ctx.app.gateway.url, `ports changed: ${oldOrigin !== ctx.app.gateway.url}; persisted layout equal: ${saved === after}`, await shot(ctx, "2-restarted-panes.png"));
  await click('.pane[data-pane="a"] button[title="이 칸 닫기"]');
  ctx.report.check(S, "칸 하나를 닫으면 나머지 세 칸 유지", await until(async () => (await wd.findAll('.pane')).length === 3));
  ctx.report.check(S, "검사 중 페이지 예외 없음", !errorsBefore.length && !(await pageErrors(wd)).length);
}
