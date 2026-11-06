'use client';

import { confirmSignIn, signIn, type SignInOutput } from 'aws-amplify/auth';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useAuth } from '@/components/AuthProvider';
import { isConfigured } from '@/lib/config';

type Step = 'credentials' | 'newPassword' | 'totp';

const inputClass =
  'w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2.5 text-base outline-none placeholder:text-zinc-500 focus:border-sky-500 sm:text-sm';
const buttonClass =
  'w-full rounded-lg bg-sky-600 px-3 py-2.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-60';

export default function LoginPage() {
  const router = useRouter();
  const { auth, refresh } = useAuth();
  const [step, setStep] = useState<Step>('credentials');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (auth.status === 'signedIn') router.replace('/');
  }, [auth.status, router]);

  async function handleNext(output: SignInOutput) {
    const next = output.nextStep.signInStep;
    if (next === 'DONE') {
      await refresh();
      router.replace('/');
    } else if (next === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') {
      setStep('newPassword');
    } else if (next === 'CONFIRM_SIGN_IN_WITH_TOTP_CODE') {
      setStep('totp');
    } else {
      setError(`Unsupported sign-in step: ${next}`);
    }
  }

  async function run(action: () => Promise<void>) {
    setError(null);
    setBusy(true);
    try {
      await action();
    } catch (err) {
      const e = err as Error;
      if (e.name === 'UserAlreadyAuthenticatedException') {
        await refresh();
        router.replace('/');
        return;
      }
      setError(e.message || 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  if (!isConfigured) {
    return (
      <Shell>
        <p className="text-sm text-amber-300">
          Missing configuration. Deploy the stacks and run <code>npm run env:web</code> to create{' '}
          <code>web/.env.local</code>, then restart <code>npm run dev:web</code>.
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      {step === 'credentials' && (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => handleNext(await signIn({ username: email.trim(), password })));
          }}
        >
          <input className={inputClass} type="email" autoComplete="username" placeholder="Email" required
            value={email} onChange={(e) => setEmail(e.target.value)} />
          <input className={inputClass} type="password" autoComplete="current-password" placeholder="Password" required
            value={password} onChange={(e) => setPassword(e.target.value)} />
          <button className={buttonClass} disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
      )}

      {step === 'newPassword' && (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (newPassword !== confirmPassword) {
              setError('Passwords do not match');
              return;
            }
            void run(async () => handleNext(await confirmSignIn({ challengeResponse: newPassword })));
          }}
        >
          <p className="text-sm text-zinc-400">
            Choose a new password: at least 12 characters with upper- and lowercase letters and a number.
          </p>
          <input className={inputClass} type="password" autoComplete="new-password" placeholder="New password"
            required minLength={12} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
          <input className={inputClass} type="password" autoComplete="new-password" placeholder="Confirm new password"
            required minLength={12} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />
          <button className={buttonClass} disabled={busy}>{busy ? 'Saving…' : 'Set password'}</button>
        </form>
      )}

      {step === 'totp' && (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => handleNext(await confirmSignIn({ challengeResponse: code.trim() })));
          }}
        >
          <p className="text-sm text-zinc-400">Enter the 6-digit code from your authenticator app.</p>
          <input className={`${inputClass} tracking-[0.4em]`} inputMode="numeric" autoComplete="one-time-code"
            pattern="[0-9]{6}" maxLength={6} placeholder="123456" required autoFocus
            value={code} onChange={(e) => setCode(e.target.value)} />
          <button className={buttonClass} disabled={busy}>{busy ? 'Verifying…' : 'Verify'}</button>
        </form>
      )}

      {error && <p role="alert" className="mt-3 text-sm text-red-400">{error}</p>}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <h1 className="mb-6 text-center text-2xl font-semibold tracking-tight">mypic</h1>
        {children}
      </div>
    </main>
  );
}
