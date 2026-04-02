export type { AlertType, AlertPayload, AlertDeps } from "./types.ts";
export { formatAlertMessage } from "./formatter.ts";

import type { AlertPayload, AlertDeps } from "./types.ts";
import { formatAlertMessage } from "./formatter.ts";

export class AlertSystem {
  constructor(private deps: AlertDeps) {}

  async send(payload: AlertPayload): Promise<void> {
    const html = formatAlertMessage(payload);
    const chatId = this.deps.alertsChatId ?? this.deps.fallbackChatId;
    await this.deps.sendMessage(chatId, html, { parseMode: "HTML" });
  }
}
