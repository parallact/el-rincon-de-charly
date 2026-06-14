'use client';

import { useEffect, useState, useCallback, useRef, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import {
  Hash,
  Gamepad2,
  Zap,
  Moon,
  Flame,
  Triangle,
} from 'lucide-react';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { useTheme, type Theme } from '@/components/client/theme-provider';

// Game icons mapping
const gameIcons: Record<string, typeof Hash> = {
  'tic-tac-toe': Hash,
  'plinko': Triangle,
};

// Available games (only show games that are actually playable)
const games = [
  { slug: 'tic-tac-toe', name: 'Tic Tac Toe' },
  { slug: 'plinko', name: 'Plinko' },
];

// Theme options
const themes: { name: Theme; label: string; icon: typeof Zap }[] = [
  { name: 'ember', label: 'Ember', icon: Flame },
  { name: 'midnight', label: 'Midnight', icon: Moon },
  { name: 'neon', label: 'Neon', icon: Zap },
];

interface CommandPaletteProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  isMobile?: boolean;
}

// Client-only mount detection without setState-in-effect. useSyncExternalStore
// returns the server snapshot (false) during SSR and the client snapshot (true)
// once hydrated, which keeps Radix UI generated IDs from causing a hydration
// mismatch. The store never changes after mount, so subscribe is a no-op.
const emptySubscribe = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

export function CommandPalette({ open: controlledOpen, onOpenChange, isMobile = false }: CommandPaletteProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const router = useRouter();
  const { theme, setTheme } = useTheme();

  // Prevent hydration mismatch with Radix UI generated IDs
  const mounted = useSyncExternalStore(emptySubscribe, getMountedSnapshot, getMountedServerSnapshot);

  // Use controlled or internal state
  const isOpen = controlledOpen !== undefined ? controlledOpen : internalOpen;
  const setIsOpen = onOpenChange || setInternalOpen;

  // Keep refs to avoid stale closures in the keyboard handler.
  // Ref writes happen in an effect (not during render) so React's
  // render-purity rules are respected.
  const isOpenRef = useRef(isOpen);
  const setIsOpenRef = useRef(setIsOpen);
  useEffect(() => {
    isOpenRef.current = isOpen;
    setIsOpenRef.current = setIsOpen;
  }, [isOpen, setIsOpen]);

  const runCommand = useCallback((command: () => void) => {
    setIsOpen(false);
    command();
  }, [setIsOpen]);

  // Keyboard shortcut: Ctrl/Cmd + K
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setIsOpenRef.current(!isOpenRef.current);
      }
    };

    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, []);

  // Don't render dialog until mounted to prevent hydration mismatch
  if (!mounted) {
    return null;
  }

  return (
    <CommandDialog open={isOpen} onOpenChange={setIsOpen}>
      <CommandInput placeholder="Buscar juegos, acciones..." />
      <CommandList>
        <CommandEmpty>No se encontraron resultados.</CommandEmpty>

        {/* Games */}
        <CommandGroup heading="Juegos">
          {games.map((game) => {
            const Icon = gameIcons[game.slug] || Gamepad2;
            return (
              <CommandItem
                key={game.slug}
                onSelect={() => runCommand(() => router.push(`/games/${game.slug}`))}
              >
                <Icon size={16} className="mr-2" />
                <span>{game.name}</span>
              </CommandItem>
            );
          })}
        </CommandGroup>

        {/* Themes - Only on desktop */}
        {!isMobile && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Tema">
              {themes.map((t) => {
                const Icon = t.icon;
                const isActive = theme === t.name;
                return (
                  <CommandItem
                    key={t.name}
                    onSelect={() => runCommand(() => setTheme(t.name))}
                  >
                    <Icon size={16} className="mr-2" />
                    <span>{t.label}</span>
                    {isActive && (
                      <span className="ml-auto text-xs text-(--color-primary)">
                        Activo
                      </span>
                    )}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </>
        )}

        {/* Navigation - Only on desktop */}
        {!isMobile && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Navegacion">
              <CommandItem onSelect={() => runCommand(() => router.push('/games'))}>
                <Gamepad2 size={16} className="mr-2" />
                <span>Ir a Juegos</span>
              </CommandItem>
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}

export default CommandPalette;
