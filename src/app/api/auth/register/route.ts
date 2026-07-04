import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { authLogger } from '@/lib/utils/logger';

const registerSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres').max(128),
  username: z.string().trim().min(2).max(30),
});

export async function POST(req: Request) {
  try {
    const parsed = registerSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message || 'Datos inválidos' },
        { status: 400 }
      );
    }

    const email = parsed.data.email.toLowerCase();
    const { password, username } = parsed.data;

    const existing = await prisma.user.findFirst({
      where: { OR: [{ email }, { username }] },
      select: { id: true },
    });
    if (existing) {
      return NextResponse.json(
        { error: 'Ese email o nombre de usuario ya está registrado.' },
        { status: 400 }
      );
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    // Create the user + its wallet (starting balance) in one transaction — the
    // Supabase signup trigger that used to do this no longer exists.
    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: { email, username, name: username, password: hashedPassword },
      });
      await tx.wallet.create({ data: { userId: created.id } });
      return created;
    });

    return NextResponse.json({ success: true, userId: user.id });
  } catch (error) {
    authLogger.error('Registration error', error);
    return NextResponse.json({ error: 'Algo salió mal' }, { status: 500 });
  }
}
