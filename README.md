# El Rincón de Charly

Plataforma de juegos online multijugador con autenticación, matchmaking en tiempo real y sistema de wallet.

**[Jugar ahora](https://el-rincon-de-charly.vercel.app)**

## Features

### Juegos
- **Tic Tac Toe** - Con 4 niveles de dificultad de IA (fácil a imposible)
  - Modos: vs IA, local (2 jugadores), online multijugador
- **Plinko** - Juego de casino: dejá caer la bola y ganá multiplicadores (1 jugador, con apuestas)
- Más juegos próximamente (Connect 4, Ajedrez, Damas)

### Multijugador Online
- Matchmaking automático
- Salas privadas con link de invitación
- Realtime con WebSocket (Ably)
- Reconexión automática
- Sistema de revancha

### Usuario
- Autenticación con email/OAuth
- Perfil con estadísticas
- Leaderboard global
- Sistema de wallet

### UX
- 3 temas: Ember, Midnight, Neon
- Diseño responsive (mobile/tablet/desktop)
- Command palette (Ctrl+K)
- Animaciones con Framer Motion

## Stack

| Categoría | Tecnología |
|-----------|------------|
| Framework | Next.js 16, React 19, TypeScript |
| Styling | Tailwind CSS 4, Radix UI |
| Backend | PostgreSQL (Neon) + Prisma, NextAuth v5 |
| Realtime | Ably (WebSocket) |
| State | Zustand |
| Animations | Framer Motion |

## Desarrollo

```bash
# Instalar dependencias
npm install

# Variables de entorno
cp .env.example .env.local
# Configurar DATABASE_URL, AUTH_SECRET, AUTH_URL y ABLY_API_KEY (ver .env.example)

# Iniciar servidor de desarrollo
npm run dev
```

## Estructura

```
src/
├── app/           # Rutas (App Router)
├── features/      # Features por dominio (auth, games, wallet, profile)
├── components/    # Componentes UI reutilizables
├── stores/        # Zustand stores
├── lib/           # Utilidades y configuración
└── types/         # Tipos TypeScript

prisma/
├── schema.prisma  # Modelo de datos (Prisma + PostgreSQL)
└── migrations/    # Migraciones SQL
```

## Licencia

MIT
