# Migraciones de Supabase

## ⚠️ El proyecto Supabase original es irrecuperable

El proyecto de Supabase que servía a la app estuvo **pausado más de 90 días y ya
no se puede restaurar** (su base de datos se perdió). Para volver a levantar el
backend hay que **crear un proyecto Supabase nuevo y aplicar estas migraciones en
orden** (`001` → `010`), y setear `NEXT_PUBLIC_SUPABASE_URL` /
`NEXT_PUBLIC_SUPABASE_ANON_KEY`.

## `001_create_base_schema.sql` — reconstruido

El `001` original nunca se versionó (se aplicó a mano en el editor SQL). Como la
DB viva ya no existe, **no se pudo exportar el DDL/RLS exacto**; `001` es una
**reconstrucción best-effort** a partir de
[`src/types/supabase.types.ts`](../../src/types/supabase.types.ts) y de los
patrones de query de la app (`profiles`, `game_stats`, `game_rooms` + trigger de
perfil + RLS). **Revisá las políticas RLS antes de confiar en ellas.** Crea solo
las columnas previas a `005`/`007` para que esas migraciones sigan aplicando.

## `010_wallet_server_authoritative.sql` — integridad del wallet

Antes el balance era **autoridad del cliente**: la RLS `"Users can update their
own wallet"` permitía fijar el `balance` a cualquier valor, y el cliente
acreditaba sus propios premios y minteaba un bono diario sin límite. Son créditos
virtuales, pero la integridad de las apuestas y el leaderboard dependía del
cliente.

`010` lo vuelve **autoritativo del servidor**:

- Funciones `SECURITY DEFINER` para todas las mutaciones de balance: `wallet_ensure`,
  `wallet_place_bet` (valida saldo), `wallet_settle_bet` (**liquida desde el
  resultado real de la sala**, paga el pozo/ reembolsa empate **una sola vez** por
  jugador vía la tabla `bet_settlements`), `wallet_cancel_bet`, `wallet_claim_daily_bonus`
  (límite de 24 h).
- Quita las políticas de `UPDATE`/`INSERT` directo sobre `wallets` y
  `wallet_transactions`.
- El cliente (`wallet-store.ts`) ahora llama a estos RPCs, nunca escribe el balance.

**Limitación conocida (Plinko):** Plinko resuelve el multiplicador con física del
lado del cliente, así que su premio (`wallet_credit`) sigue siendo **afirmado por
el cliente**. Está confinado a una función nombrada en vez de un `UPDATE` abierto,
pero el hardening real de Plinko —RNG del lado del servidor que decide los buckets,
con el cliente animando hacia ellos— queda como follow-up.
