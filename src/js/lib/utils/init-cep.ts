import { dropDisable } from "./cep";
import {
  MAIN_EXTENSION_ID,
  SETTINGS_EXTENSION_ID,
} from "../../shared/layout-settings";

export const APPLY_ACTIVE_PALETTE_GRADIENT_EVENT =
  "chroma-relay:apply-active-palette-gradient";

const buildFlyoutMenu = () => {
  const isMainPanel = window.__adobe_cep__.getExtensionId() === MAIN_EXTENSION_ID;
  const menu = `<Menu>
  ${isMainPanel ? '<MenuItem Id="settings" Label="Settings…" Enabled="true" Checked="false"/>' : ""}
  <MenuItem Id="refresh" Label="Refresh" Enabled="true" Checked="false"/>
  </Menu>`;

  interface FlyoutMenuEvent {
    data:
      | {
          menuId: string;
        }
      | string;
  }
  const flyoutHandler = (event: FlyoutMenuEvent) => {
    let menuId;
    if (typeof event.data === "string") {
      try {
        //? On build the events come in garbled string which requires some replacing and then parsing to get the data
        menuId = JSON.parse(
          event.data.replace(/\$/g, "").replace(/\=2/g, ":")
        ).menuId;
      } catch (e) {
        console.error(e);
      }
    } else {
      menuId = event.data.menuId;
    }
    if (menuId === "apply-active-palette-gradient" && isMainPanel) {
      window.dispatchEvent(new Event(APPLY_ACTIVE_PALETTE_GRADIENT_EVENT));
    } else if (menuId === "settings" && isMainPanel) {
      window.__adobe_cep__.requestOpenExtension(SETTINGS_EXTENSION_ID, "");
    } else if (menuId === "refresh") {
      location.reload();
    }
  };

  window.__adobe_cep__.invokeSync("setPanelFlyoutMenu", menu);
  window.__adobe_cep__.addEventListener(
    "com.adobe.csxs.events.flyoutMenuClicked",
    flyoutHandler
  );
};

const buildContextMenu = () => {
  const menuObj = {
    menu: [
      {
        label: "Settings",
        enabled: true,
        checked: false,
        checkable: false,
        id: "c-0",
        callback: () => {
          window.__adobe_cep__.requestOpenExtension(SETTINGS_EXTENSION_ID, "");
        },
      },
    ],
  };
  window.__adobe_cep__.invokeAsync(
    "setContextMenuByJSON",
    JSON.stringify(menuObj),
    (e: string) => {
      menuObj.menu.find((m) => m.id === e)?.callback();
    }
  );
};

export const initializeCEP = () => {
  buildFlyoutMenu();
  buildContextMenu();
  dropDisable(); // to prevent drop files on panel and taking over
};
