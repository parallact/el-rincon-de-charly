# Migraciones de Supabase

## ⚠️ Falta la migración base (`001_create_game_stats_table.sql`)

Las migraciones de este directorio empiezan en `002` y asumen que ya existen
las tablas base (`profiles`, `game_stats`, `game_rooms`) con sus políticas RLS
—`002` incluso dice "Run this after 001_create_game_stats_table.sql"—, pero ese
archivo `001` **no está versionado** en el repo. Se aplicó directo en el editor
SQL de Supabase.

Consecuencia: un setup desde cero con solo estas migraciones **no reproduce** el
esquema completo. La forma del esquema base puede verse en
[`src/types/supabase.types.ts`](../../src/types/supabase.types.ts) (tablas
`profiles`, `game_stats`, `game_rooms`), pero las políticas RLS exactas de esas
tablas no están capturadas aquí. Pendiente: exportar el esquema base vivo
(`supabase db dump`) y commitearlo como `001` para dejar las migraciones
reproducibles.

## Nota de integridad: wallet y apuestas son autoridad del cliente

El wallet usa **créditos virtuales** (no dinero real). La liquidación de apuestas
y el balance se manejan del lado del cliente:

- La política RLS `"Users can update their own wallet"` (`002_create_wallet_tables.sql`)
  permite `UPDATE` de cualquier columna de la propia fila, incluido `balance`,
  sin `WITH CHECK` que restrinja el valor nuevo. Un usuario autenticado puede
  fijar su `balance` a cualquier monto.
- El store del cliente expone `addCredits()` / `recordWin()`, que escriben el
  balance directamente; al terminar una partida con apuesta, cada cliente
  acredita su propio premio. No hay liquidación autoritativa del lado del servidor.

Para integridad real (aunque sea moneda virtual), la dirección correcta es mover
las mutaciones de balance a funciones `SECURITY DEFINER` que validen la
transición (apuesta ≤ balance, premio = pozo, un solo pago por partida) y quitar
la política de `UPDATE` directo sobre `wallets`.
