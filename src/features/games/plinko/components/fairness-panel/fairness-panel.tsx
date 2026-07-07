'use client';

import { useEffect, useState } from 'react';
import { Shield, ChevronDown, Check, Copy } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { gameLogger } from '@/lib/utils/logger';
import {
  getPlinkoFairnessAction,
  rotatePlinkoSeedAction,
  type PlinkoFairness,
  type PlinkoRotateResult,
} from '../../actions/plinko-actions';

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          /* clipboard unavailable */
        }
      }}
      className="shrink-0 text-(--color-text-muted) hover:text-(--color-text)"
      aria-label="Copiar"
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-(--color-text-muted)">{label}</div>
      <div className="flex items-center gap-1.5">
        <code className="min-w-0 flex-1 truncate text-[11px] text-(--color-text)">{value}</code>
        <CopyButton value={value} />
      </div>
    </div>
  );
}

// `refreshKey` bumps once per settled drop so the displayed nonce ("Próxima
// tirada") stays current while the panel is open.
export function FairnessPanel({ refreshKey = 0 }: { refreshKey?: number }) {
  const [open, setOpen] = useState(false);
  const [fairness, setFairness] = useState<PlinkoFairness | null>(null);
  const [revealed, setRevealed] = useState<PlinkoRotateResult['revealed']>(null);
  const [rotating, setRotating] = useState(false);

  // Refetch the commitment whenever the panel opens or a drop advances the nonce.
  useEffect(() => {
    if (!open) return;
    getPlinkoFairnessAction()
      .then((f) => f && setFairness(f))
      .catch(() => gameLogger.warn('[Plinko] no se pudo cargar la información de fairness'));
  }, [open, refreshKey]);

  async function rotate() {
    setRotating(true);
    try {
      const res = await rotatePlinkoSeedAction();
      if (res) {
        setRevealed(res.revealed);
        setFairness({ serverSeedHash: res.next.serverSeedHash, clientSeed: res.next.clientSeed, nonce: 0 });
      }
    } catch {
      gameLogger.warn('[Plinko] no se pudo rotar la semilla');
    } finally {
      setRotating(false);
    }
  }

  return (
    <div className="rounded-xl border border-(--color-border) bg-(--color-surface) text-(--color-text)">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-sm font-medium"
      >
        <Shield size={15} className="text-(--color-success)" />
        <span className="flex-1 text-left">Juego justo verificable</span>
        <ChevronDown size={16} className={cn('transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="space-y-3 border-t border-(--color-border) px-3 py-3">
          <p className="text-[11px] leading-snug text-(--color-text-muted)">
            El servidor decide cada tirada de antemano. Cada resultado sale de{' '}
            <code>HMAC-SHA256(serverSeed, clientSeed:nonce)</code>. Rotá la semilla para revelar la
            anterior y verificar tus tiradas pasadas.
          </p>

          {fairness ? (
            <div className="space-y-2">
              <Field label="Hash de semilla del servidor" value={fairness.serverSeedHash} />
              <Field label="Semilla del cliente" value={fairness.clientSeed} />
              <div className="text-[10px] uppercase tracking-wide text-(--color-text-muted)">
                Próxima tirada: <span className="text-(--color-text)">#{fairness.nonce}</span>
              </div>
            </div>
          ) : (
            <div className="text-[11px] text-(--color-text-muted)">Cargando…</div>
          )}

          <button
            type="button"
            onClick={rotate}
            disabled={rotating}
            className="w-full rounded-lg border border-(--color-border) px-3 py-2 text-xs font-medium hover:bg-(--color-border)/40 disabled:opacity-50"
          >
            {rotating ? 'Rotando…' : 'Rotar y revelar semilla anterior'}
          </button>

          {revealed && (
            <div className="space-y-2 rounded-lg bg-(--color-border)/30 p-2">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-(--color-success)">
                Semilla revelada — verificá tus {revealed.nonce} tiradas
              </div>
              <Field label="Semilla del servidor (revelada)" value={revealed.serverSeed} />
              <Field label="Su hash (debe coincidir)" value={revealed.serverSeedHash} />
              <Field label="Semilla del cliente" value={revealed.clientSeed} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
