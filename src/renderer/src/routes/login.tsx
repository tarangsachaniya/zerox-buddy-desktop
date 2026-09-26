import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/field";
import { Logo } from "@/components/ui/primitives";
import { run } from "@/lib/app-state";

const POINTS = ["Print requests arrive the moment customers submit", "Each job goes to the right printer", "Keeps printing from the tray"];

export function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      await run(window.zerox.login(email, password));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't sign in");
      setPending(false);
    }
  }

  return (
    <div className="grid h-dvh grid-cols-[1fr_minmax(0,520px)]">
      <aside className="relative flex flex-col overflow-hidden bg-deep p-12 text-deep-foreground">
        <div aria-hidden className="deep-glow pointer-events-none absolute inset-0" />
        <div className="relative">
          <Logo onDark />
        </div>
        <div className="relative mt-auto max-w-md">
          <p className="text-overline text-lime">Zerox Buddy Desktop</p>
          <p className="mt-5 font-display text-[3rem] font-extrabold leading-[1] tracking-[-0.045em]">
            Your counter&apos;s
            <br />
            <span className="text-lime">print station.</span>
          </p>
          <ul className="mt-10 space-y-3 border-t border-deep-foreground/15 pt-8">
            {POINTS.map((p, i) => (
              <li key={p} className="flex gap-4 text-[15px] text-deep-foreground/80">
                <span className="font-mono text-[12px] text-lime">0{i + 1}</span>
                {p}
              </li>
            ))}
          </ul>
        </div>
      </aside>
      <main className="flex items-center justify-center px-12">
        <form onSubmit={submit} className="w-full max-w-sm animate-fade-up" noValidate>
          <h1 className="text-title">Sign in</h1>
          <p className="mt-1.5 text-[15px] text-muted-foreground">Use your Zerox Buddy shop account, the same one as on the web.</p>
          <div className="mt-8 grid gap-5">
            <Field label="Email" htmlFor="email">
              <Input id="email" type="email" autoComplete="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label="Password" htmlFor="password">
              <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            {error && (
              <p role="alert" className="rounded-xl bg-destructive/10 px-3.5 py-2.5 text-sm text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" size="lg" caps loading={pending} disabled={!email || !password} className="w-full">
              Sign in
            </Button>
          </div>
          <p className="mt-6 text-center text-sm text-muted-foreground">
            No account yet? Create your shop at{" "}
            <a href="https://zerox.priinteve.com/register" className="font-semibold text-foreground underline decoration-lime decoration-2 underline-offset-4">
              zerox.priinteve.com
            </a>
          </p>
        </form>
      </main>
    </div>
  );
}
