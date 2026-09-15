import type { Db } from "@paperclipai/db";
import { forbidden } from "../../errors.js";
import { instanceSettingsService } from "../instance-settings.js";

/** Read on delivery and on every tool call, including retained runner sessions. */
export async function liveServicesEnabled(db: Db): Promise<boolean> {
  return (await instanceSettingsService(db).getExperimental()).enableLiveServices === true;
}

export async function assertLiveServicesEnabled(db: Db): Promise<void> {
  if (!(await liveServicesEnabled(db))) {
    throw forbidden("Experimental Live Services is not enabled", { code: "FEATURE_DISABLED" });
  }
}
