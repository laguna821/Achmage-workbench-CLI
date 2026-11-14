import type { NavLayout } from "@workbench/contracts";
import { Icon } from "../Icon.tsx";
import { Menu, MenuItem, useMenuTrigger } from "../ui/Menu.tsx";
import { LAYOUTS, type LayoutChoice } from "./model.ts";

/** The sidebar head's layout control: the icon of the layout in use, opening the layouts (the shared Menu). */
export function LayoutButton({ drawn, choices, onChoose }: { drawn: NavLayout; choices: LayoutChoice[]; onChoose: (layout: NavLayout | "auto") => void }) {
  const menu = useMenuTrigger();
  const now = LAYOUTS.find((entry) => entry.id === drawn)!;
  return (
    <>
      <button ref={menu.anchorRef} type="button" className={`icon-button small side-layout${menu.open ? " pressed" : ""}`} title={`사이드바 배치: ${now.label}`} aria-label="사이드바 배치" {...menu.triggerProps}>
        <Icon name={now.icon} size={16} />
      </button>
      <Menu {...menu.menuProps} label="사이드바 배치" align="end">
        {choices.map((choice) => (
          <MenuItem key={choice.id} type="radio" icon={choice.icon} checked={choice.checked} hint={choice.hint} value={choice.id} onSelect={() => onChoose(choice.id)}>
            {choice.label}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
