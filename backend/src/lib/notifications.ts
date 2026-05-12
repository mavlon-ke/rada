// src/lib/notifications.ts
// Notification creation helper — single integration point for both in-app
// notification rows and (optionally) WhatsApp notification delivery.
//
// In-app notification creation is the source of truth. WhatsApp send is
// fire-and-forget alongside it: if Meta API is slow or down, the in-app
// notification still lands and the user sees it in the bell tray.
//
// CALLERS:
//   - 9 call sites in src/app/api/... and src/lib/referrals/...
//   - Paystack webhook uses raw prisma.notification.create directly and
//     calls sendWhatsAppNotification inline (separate path).

import { prisma } from '@/lib/db/prisma';
import {
  sendWhatsAppNotification,
  type WhatsAppTemplateKey,
} from '@/lib/whatsapp/whatsapp-notifications';

export type CreateNotificationInput = {
  userId:  string;
  type:    string;
  title:   string;
  message: string;
  link?:   string;

  // Optional WhatsApp mirror. If provided, the matching Meta template is
  // sent to the user's WhatsApp after the in-app notification is created.
  // Fail-closed via the four-layer kill switch in whatsapp-notifications.ts
  // — defaults to log-only mode unless WHATSAPP_NOTIFS_ENABLED=true.
  whatsapp?: {
    template:   WhatsAppTemplateKey;
    parameters: string[];   // ordered params for the template body
  };
};

export async function createNotification(input: CreateNotificationInput) {
  try {
    const notification = await prisma.notification.create({
      data: {
        userId:  input.userId,
        type:    input.type as any,
        title:   input.title,
        message: input.message,
        link:    input.link,
      },
    });

    // FIRE-AND-FORGET WhatsApp mirror.
    //
    // We deliberately do NOT await this — the function is responsible for
    // its own error handling (it never throws), and we don't want a slow
    // Meta API call to delay the response to whatever endpoint triggered
    // the notification.
    //
    // The void cast tells TypeScript and the Node runtime that we're
    // intentionally not awaiting; Node won't emit "unhandled promise"
    // warnings for promises that are clearly created and abandoned this way.
    if (input.whatsapp) {
      void sendWhatsAppNotification(
        input.userId,
        input.whatsapp.template,
        input.whatsapp.parameters,
      );
    }

    return notification;
  } catch (err) {
    console.error('[Notification] Failed to create:', err);
    return undefined;
  }
}
