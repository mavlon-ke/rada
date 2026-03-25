import { prisma } from '@/lib/db/prisma';

export type CreateNotificationInput = {
  userId:  string;
  type:    string;
  title:   string;
  message: string;
  link?:   string;
};

export async function createNotification(input: CreateNotificationInput) {
  try {
    return await prisma.notification.create({
      data: {
        userId:  input.userId,
        type:    input.type as any,
        title:   input.title,
        message: input.message,
        link:    input.link,
      },
    });
  } catch (err) {
    console.error('[Notification] Failed to create:', err);
  }
}