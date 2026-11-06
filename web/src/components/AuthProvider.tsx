'use client';

import { fetchAuthSession, getCurrentUser, signOut as amplifySignOut } from 'aws-amplify/auth';
import { Hub } from 'aws-amplify/utils';
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { configureAmplify } from '@/lib/amplify';

configureAmplify();

type AuthState =
  | { status: 'loading' }
  | { status: 'signedOut' }
  | { status: 'signedIn'; userId: string; email?: string; isAdmin: boolean };

interface AuthContextValue {
  auth: AuthState;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function loadAuthState(): Promise<AuthState> {
  try {
    const user = await getCurrentUser();
    const session = await fetchAuthSession();
    const payload = session.tokens?.idToken?.payload ?? {};
    const groups = (payload['cognito:groups'] as string[] | undefined) ?? [];
    return {
      status: 'signedIn',
      userId: user.userId,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      isAdmin: groups.includes('admin'),
    };
  } catch {
    return { status: 'signedOut' };
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' });

  const refresh = useCallback(async () => setAuth(await loadAuthState()), []);

  useEffect(() => {
    let active = true;
    const sync = () =>
      loadAuthState().then((state) => {
        if (active) setAuth(state);
      });
    void sync();
    const stop = Hub.listen('auth', ({ payload }) => {
      if (payload.event === 'signedIn' || payload.event === 'signedOut' || payload.event === 'tokenRefresh_failure') {
        void sync();
      }
    });
    return () => {
      active = false;
      stop();
    };
  }, []);

  const signOut = useCallback(async () => {
    await amplifySignOut();
    setAuth({ status: 'signedOut' });
  }, []);

  const value = useMemo(() => ({ auth, refresh, signOut }), [auth, refresh, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
