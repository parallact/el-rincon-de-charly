'use client';

import { useState, useEffect } from 'react';
import { getProviders } from 'next-auth/react';
import { motion } from 'framer-motion';
import { Mail, Lock, User, Eye, EyeOff, CheckCircle, ShieldCheck } from 'lucide-react';
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalTitle,
  ModalDescription,
} from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { useAuth } from '../hooks/use-auth';
import { cn } from '@/lib/utils/cn';

interface AuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Optional message to show above the form (e.g., for shared game links) */
  message?: string;
}

type AuthMode = 'login' | 'register';

export function AuthModal({ isOpen, onClose, message }: AuthModalProps) {
  const [mode, setMode] = useState<AuthMode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [registrationSuccess, setRegistrationSuccess] = useState(false);
  const [googleAvailable, setGoogleAvailable] = useState(false);

  const { signIn, signUp, signInWithProvider } = useAuth();

  // Only show the Google button when the provider is actually configured.
  useEffect(() => {
    getProviders()
      .then((p) => setGoogleAvailable(Boolean(p?.google)))
      .catch(() => setGoogleAvailable(false));
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      if (mode === 'login') {
        const { error } = await signIn(email, password);
        if (error) {
          setError(error.message);
        } else {
          onClose();
        }
      } else {
        if (!username.trim()) {
          setError('Username is required');
          setIsSubmitting(false);
          return;
        }
        const { error } = await signUp(email, password, username);
        if (error) {
          setError(error.message);
        } else {
          setError(null);
          setRegistrationSuccess(true);
        }
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleGoogleLogin = async () => {
    setError(null);
    const { error } = await signInWithProvider('google');
    if (error) {
      setError(error.message);
    }
  };

  const ariaLabel = registrationSuccess
    ? 'Registro exitoso'
    : mode === 'login'
      ? 'Iniciar sesion'
      : 'Crear cuenta';

  return (
    <Modal open={isOpen} onClose={onClose}>
      <ModalContent size="default" ariaLabel={ariaLabel} className="max-h-[90vh] overflow-y-auto">
        {/* Registration Success Screen */}
        {registrationSuccess ? (
          <ModalBody className="py-12">
            <motion.div
              className="text-center"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3 }}
            >
              <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-(--color-success)/10 border border-(--color-success)/30 flex items-center justify-center">
                <CheckCircle className="text-(--color-success)" size={48} />
              </div>

              <h2 className="text-2xl font-heading font-bold mb-4 text-(--color-text)">
                Registro exitoso
              </h2>
              <div className="p-4 rounded-xl bg-(--color-background) border border-(--color-border) mb-6">
                <p className="text-(--color-text-muted)">
                  Revisa tu email{' '}
                  <span className="text-(--color-primary) font-semibold">
                    {email}
                  </span>{' '}
                  y haz clic en el enlace para confirmar tu cuenta.
                </p>
              </div>

              <Button
                variant="primary"
                size="lg"
                onClick={() => {
                  setRegistrationSuccess(false);
                  setMode('login');
                  setEmail('');
                  setPassword('');
                  setUsername('');
                }}
              >
                Ir a Iniciar Sesion
              </Button>
            </motion.div>
          </ModalBody>
        ) : (
          <>
            {/* Header */}
            <ModalHeader showClose>
              <div className="flex items-center gap-3 w-full">
                <div className="w-12 h-12 rounded-xl bg-primary/10 border border-primary/30 flex items-center justify-center">
                  <ShieldCheck className="text-(--color-primary)" size={24} />
                </div>
                <div>
                  <ModalTitle className="text-xl font-heading">
                    {mode === 'login' ? 'Bienvenido' : 'Crear Cuenta'}
                  </ModalTitle>
                  <ModalDescription>
                    {mode === 'login'
                      ? 'Ingresa a tu cuenta para continuar'
                      : 'Unete y empieza a jugar'}
                  </ModalDescription>
                </div>
              </div>
            </ModalHeader>

            <ModalBody>
              {/* Custom message (e.g., for shared game links) */}
              {message && (
                <div className="mb-6 p-4 rounded-xl bg-(--color-primary)/10 border border-(--color-primary)/30">
                  <p className="text-sm text-(--color-text) text-center">
                    {message}
                  </p>
                </div>
              )}

              {/* Google login button — only when the provider is configured */}
              {googleAvailable && (
                <>
                  <Button
                    variant="outline"
                    size="lg"
                    onClick={handleGoogleLogin}
                    className="w-full mb-6"
                    icon={
                      <svg className="w-5 h-5" viewBox="0 0 24 24">
                        <path
                          fill="currentColor"
                          d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                        />
                      </svg>
                    }
                  >
                    Continuar con Google
                  </Button>

                  {/* Divider */}
                  <div className="relative mb-6">
                    <div className="absolute inset-0 flex items-center">
                      <div className="w-full border-t border-(--color-border)" />
                    </div>
                    <div className="relative flex justify-center">
                      <span className="px-3 bg-(--color-surface) text-(--color-text-muted) text-sm">
                        o continua con email
                      </span>
                    </div>
                  </div>
                </>
              )}

              {/* Form */}
              <form onSubmit={handleSubmit} className="space-y-4">
                {mode === 'register' && (
                  <div className="relative">
                    <User
                      className="absolute left-4 top-1/2 -translate-y-1/2 text-(--color-text-subtle) pointer-events-none"
                      size={18}
                    />
                    <input
                      type="text"
                      placeholder="Username"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      className={cn(
                        'w-full pl-12 pr-4 py-3 rounded-xl',
                        'bg-(--color-background) border border-(--color-border)',
                        'text-sm text-(--color-text) placeholder:text-(--color-text-subtle)',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-primary) focus-visible:ring-offset-2',
                        'transition-all duration-200'
                      )}
                      required
                    />
                  </div>
                )}

                <div className="relative">
                  <Mail
                    className="absolute left-4 top-1/2 -translate-y-1/2 text-(--color-text-subtle) pointer-events-none"
                    size={18}
                  />
                  <input
                    type="email"
                    placeholder="Email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className={cn(
                      'w-full pl-12 pr-4 py-3 rounded-xl',
                      'bg-(--color-background) border border-(--color-border)',
                      'text-sm text-(--color-text) placeholder:text-(--color-text-subtle)',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-primary) focus-visible:ring-offset-2',
                      'transition-all duration-200'
                    )}
                    required
                  />
                </div>

                <div className="relative">
                  <Lock
                    className="absolute left-4 top-1/2 -translate-y-1/2 text-(--color-text-subtle) pointer-events-none"
                    size={18}
                  />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    placeholder="Password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className={cn(
                      'w-full pl-12 pr-12 py-3 rounded-xl',
                      'bg-(--color-background) border border-(--color-border)',
                      'text-sm text-(--color-text) placeholder:text-(--color-text-subtle)',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-primary) focus-visible:ring-offset-2',
                      'transition-all duration-200'
                    )}
                    required
                    minLength={6}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-4 top-1/2 -translate-y-1/2 text-(--color-text-subtle) hover:text-(--color-text) transition-colors rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-primary) focus-visible:ring-offset-2"
                    aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                  >
                    {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>

                {error && (
                  <motion.div
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className={cn(
                      'text-sm text-center p-3 rounded-lg',
                      error.includes('Check your email')
                        ? 'text-(--color-success) bg-(--color-success)/10 border border-(--color-success)/30'
                        : 'text-(--color-error) bg-(--color-error)/10 border border-(--color-error)/30'
                    )}
                  >
                    {error}
                  </motion.div>
                )}

                <Button
                  type="submit"
                  variant="primary"
                  size="lg"
                  disabled={isSubmitting}
                  loading={isSubmitting}
                  className="w-full"
                >
                  {mode === 'login' ? 'Iniciar Sesion' : 'Crear Cuenta'}
                </Button>
              </form>

              {/* Switch mode */}
              <div className="text-center mt-6">
                <p className="text-sm text-(--color-text-muted)">
                  {mode === 'login' ? (
                    <>
                      ¿No tienes cuenta?{' '}
                      <button
                        onClick={() => {
                          setMode('register');
                          setError(null);
                        }}
                        className="text-(--color-primary) hover:underline font-medium rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-primary) focus-visible:ring-offset-2"
                      >
                        Registrate
                      </button>
                    </>
                  ) : (
                    <>
                      ¿Ya tienes cuenta?{' '}
                      <button
                        onClick={() => {
                          setMode('login');
                          setError(null);
                        }}
                        className="text-(--color-primary) hover:underline font-medium rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-primary) focus-visible:ring-offset-2"
                      >
                        Inicia sesion
                      </button>
                    </>
                  )}
                </p>
              </div>
            </ModalBody>
          </>
        )}
      </ModalContent>
    </Modal>
  );
}

export default AuthModal;
