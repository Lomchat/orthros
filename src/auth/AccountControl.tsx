import React from "react";
import { CloudArrowUp, SignIn, SignOut, UserCircle } from "@phosphor-icons/react";
import { useCloudSaves } from "../cloud/CloudSaveProvider";
import { authClient } from "./auth-client";
import s from "./AccountControl.module.css";

type Mode = "signin" | "signup";

export default function AccountControl(): React.ReactElement {
  const cloud = useCloudSaves();
  const [open, setOpen] = React.useState(false);
  const [mode, setMode] = React.useState<Mode>("signin");
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);

  const runSaveChoice = async (action: () => Promise<void>) => {
    setBusy(true);
    setFormError(null);
    try { await action(); }
    catch (error) { setFormError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFormError(null);
    try {
      const result = mode === "signup"
        ? await authClient.signUp.email({ name: name.trim(), email: email.trim(), password })
        : await authClient.signIn.email({ email: email.trim(), password });
      if (result.error) throw new Error(result.error.message || "Authentication failed");
      await cloud.refetchSession();
      setPassword("");
      setOpen(false);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const statusText = cloud.phase === "checking" ? "Synchronizing saves…"
    : cloud.phase === "conflict" ? `${cloud.conflicts.length} save conflict${cloud.conflicts.length === 1 ? "" : "s"}`
    : cloud.phase === "error" ? "Cloud sync needs attention"
    : "Cloud saves synchronized";

  return (
    <>
      <button className={s["account-button"]} onClick={() => setOpen(true)} aria-label="Account">
        {cloud.user ? <CloudArrowUp size={18} aria-hidden /> : <SignIn size={18} aria-hidden />}
        <span>{cloud.user?.name || "Sign in"}</span>
      </button>

      {open && (
        <div className={s["backdrop"]} role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setOpen(false);
        }}>
          <section className={s["modal"]} role="dialog" aria-modal="true" aria-label="Orthros account">
            <button className={s["close"]} onClick={() => setOpen(false)} aria-label="Close">×</button>
            {cloud.user ? (
              <>
                <div className={s["identity"]}>
                  {cloud.user.image
                    ? <img src={cloud.user.image} alt="" referrerPolicy="no-referrer" />
                    : <UserCircle size={44} aria-hidden />}
                  <div><strong>{cloud.user.name}</strong><span>{cloud.user.email}</span></div>
                </div>
                <div className={s["sync-status"]} data-state={cloud.phase}>
                  <CloudArrowUp size={20} aria-hidden />
                  <div><strong>{statusText}</strong>{cloud.error && <span>{cloud.error}</span>}</div>
                </div>

                {cloud.conflicts.map((conflict) => (
                  <div className={s["conflict"]} key={conflict.containerId}>
                    <strong>{conflict.containerId}</strong>
                    <span>Local and cloud saves are different. Both versions are still intact.</span>
                    <div>
                      <button disabled={busy} onClick={() => void runSaveChoice(() => cloud.keepLocal(conflict.containerId))}>Use this device</button>
                      <button disabled={busy} onClick={() => {
                        if (confirm(`Replace the local saves for "${conflict.containerId}" with the cloud version?`)) {
                          void runSaveChoice(() => cloud.useCloud(conflict.containerId));
                        }
                      }}>Restore cloud</button>
                    </div>
                  </div>
                ))}
                {formError && <div className={s["error"]}>{formError}</div>}

                <div className={s["actions"]}>
                  <button disabled={cloud.phase === "checking"} onClick={() => void cloud.syncNow()}>Sync now</button>
                  <button onClick={async () => { await authClient.signOut(); await cloud.refetchSession(); setOpen(false); }}>
                    <SignOut size={17} aria-hidden /> Sign out
                  </button>
                </div>
              </>
            ) : (
              <>
                <h2>{mode === "signin" ? "Sign in" : "Create an account"}</h2>
                <p className={s["intro"]}>Your game keeps saving locally. Signing in adds versioned cloud backups.</p>
                <form onSubmit={submit}>
                  {mode === "signup" && (
                    <label>Display name<input required autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} /></label>
                  )}
                  <label>Email<input required type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
                  <label>Password<input required minLength={10} maxLength={128} type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} /></label>
                  {formError && <div className={s["error"]}>{formError}</div>}
                  <button className={s["primary"]} disabled={busy} type="submit">
                    {busy ? "Please wait…" : mode === "signin" ? "Sign in" : "Create account"}
                  </button>
                </form>
                <button className={s["switch"]} onClick={() => { setMode(mode === "signin" ? "signup" : "signin"); setFormError(null); }}>
                  {mode === "signin" ? "No account yet? Create one" : "Already have an account? Sign in"}
                </button>
              </>
            )}
          </section>
        </div>
      )}
    </>
  );
}
