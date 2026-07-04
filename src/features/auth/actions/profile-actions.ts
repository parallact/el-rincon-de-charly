'use server';

import { prisma } from '@/lib/prisma';
import { getUserId } from '@/lib/auth-helpers';

export async function updateProfileAction(updates: {
  username?: string;
  avatarUrl?: string;
}): Promise<{ error: string | null }> {
  const userId = await getUserId();
  if (!userId) return { error: 'No autenticado' };
  try {
    await prisma.user.update({
      where: { id: userId },
      data: {
        // `name` mirrors `username` (the session exposes name as the display name).
        ...(updates.username !== undefined ? { username: updates.username, name: updates.username } : {}),
        ...(updates.avatarUrl !== undefined ? { avatarUrl: updates.avatarUrl, image: updates.avatarUrl } : {}),
      },
    });
    return { error: null };
  } catch {
    return { error: 'No se pudo actualizar el perfil' };
  }
}
