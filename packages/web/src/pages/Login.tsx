import { Button, FieldRow, Input, LockIcon } from '@shutro/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { ApiError, api } from '../api.js';

const FEATURES = [
  ['Every app, one place', 'Accounting, Sales, Purchase, Project and your own modules.'],
  ['Your screens, your way', 'Save the columns, filters and grouping you need.'],
  ['Live and safe', 'Changes appear as they happen; nothing is lost to a conflicting edit.'],
] as const;

export function Login() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(login.trim(), password);
      await client.invalidateQueries({ queryKey: ['meta'] });
      await navigate({ to: '/' });
    } catch (e) {
      setError(
        e instanceof ApiError ? e : new ApiError(0, { message: 'The server cannot be reached.' }),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.1fr_1fr]">
      <aside className="relative hidden overflow-hidden bg-[linear-gradient(150deg,oklch(0.36_0.16_277),oklch(0.24_0.1_265))] p-12 text-white lg:flex lg:flex-col lg:justify-between">
        <div className="pointer-events-none absolute -top-40 -right-40 h-[520px] w-[520px] rounded-full bg-[radial-gradient(circle,oklch(0.7_0.2_300/0.35),transparent_65%)]" />
        <div className="pointer-events-none absolute -bottom-48 -left-24 h-[480px] w-[480px] rounded-full bg-[radial-gradient(circle,oklch(0.75_0.15_220/0.25),transparent_65%)]" />
        <div className="relative flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/15 text-lg font-bold backdrop-blur">
            S
          </span>
          <span className="text-lg font-semibold tracking-tight">Shutro</span>
        </div>
        <div className="relative max-w-md">
          <h1 className="text-4xl leading-tight font-semibold tracking-tight">
            Business software that feels effortless.
          </h1>
          <ul className="mt-10 grid gap-6">
            {FEATURES.map(([title, text]) => (
              <li key={title} className="flex gap-4">
                <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-white/70" />
                <div>
                  <p className="font-medium">{title}</p>
                  <p className="mt-0.5 text-sm text-white/70">{text}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-white/50">PostgreSQL · audited · secure by default</p>
      </aside>

      <main className="flex items-center justify-center p-6">
        <form onSubmit={submit} className="w-full max-w-sm animate-in" noValidate>
          <div className="mb-8">
            <h2 className="text-2xl font-semibold tracking-tight text-ink">Sign in</h2>
            <p className="mt-1.5 text-sm text-muted">
              Welcome back. Use the login your administrator gave you.
            </p>
          </div>
          <div className="grid gap-4">
            <FieldRow label="Login" htmlFor="login">
              <Input
                id="login"
                autoComplete="username"
                autoFocus
                value={login}
                onChange={(e) => setLogin(e.target.value)}
                aria-invalid={error !== null}
              />
            </FieldRow>
            <FieldRow label="Password" htmlFor="password">
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={error !== null}
              />
            </FieldRow>
            {error !== null ? (
              <div
                role="alert"
                className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger"
              >
                <p className="font-medium">{error.message}</p>
                {error.hint !== '' ? <p className="mt-0.5 opacity-80">{error.hint}</p> : null}
              </div>
            ) : null}
            <Button
              type="submit"
              variant="primary"
              size="lg"
              loading={busy}
              disabled={login === '' || password === ''}
            >
              <LockIcon size={15} /> Sign in
            </Button>
          </div>
        </form>
      </main>
    </div>
  );
}
