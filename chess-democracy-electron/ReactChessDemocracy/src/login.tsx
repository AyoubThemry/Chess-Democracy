/**
 * LoginScreen — Identity selection screen.
 *
 * Shown on first launch (or after logout) when no remembered identity exists.
 * Two paths:
 *   1. Generate new key  — creates a fresh Ed25519 keypair at the default path.
 *   2. Import key        — opens a file picker for an existing .pem file.
 *
 * This only loads or creates the key; nothing connects yet. The user can check
 * "Remember me" to skip this screen next launch. After it comes the network
 * screen, where they pick local or global play.
 */

import { useState } from 'react';
import { useStore }  from './store';
import { bridge } from './bridge';
import './login.css';

type Step = 'pick' | 'confirm';

export default function LoginScreen() {
    const [step,        setStep]        = useState<Step>('pick');
    const [loading,     setLoading]     = useState(false);
    const [error,       setError]       = useState<string | null>(null);
    const [publicKey,   setPublicKey]   = useState<string | null>(null);
    const [identityPath, setIdentityPath] = useState<string | null>(null);
    const [remember,    setRemember]    = useState(true);

    const setAuthenticated  = useStore(s => s.setAuthenticated);

    const api = bridge;

    async function handleGenerate() {
        setError(null);
        setLoading(true);
        try {
            const res = await api().startNode(undefined, true); // forceNew — always generate fresh
            if (!res.ok) { setError(res.error); return; }
            setPublicKey(res.value.publicKey);
            setIdentityPath(res.value.identityPath);
            setStep('confirm');
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Unknown error');
        } finally {
            setLoading(false);
        }
    }

    async function handleImport() {
        setError(null);
        setLoading(true);
        try {
            const fileRes = await api().openIdentityFile();
            if (!fileRes.ok || !fileRes.value.filePath) {
                setLoading(false);
                return; // user cancelled
            }
            const res = await api().startNode(fileRes.value.filePath);
            if (!res.ok) { setError(res.error); return; }
            setPublicKey(res.value.publicKey);
            setIdentityPath(res.value.identityPath);
            setStep('confirm');
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Unknown error');
        } finally {
            setLoading(false);
        }
    }

    async function handleEnter() {
        if (!identityPath) return;
        setError(null);
        setLoading(true);
        try {
            if (remember) {
                await api().saveIdentityPref(identityPath);
            }
            // Just the identity. The network screen comes next.
            setAuthenticated(true);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Unknown error');
        } finally {
            setLoading(false);
        }
    }

    const shortKey = publicKey
        ? publicKey.slice(0, 8) + '…' + publicKey.slice(-8)
        : null;

    return (
        <div className="login-screen">

            <header className="login-header">
                <div className="login-logo">♟</div>
                <h1>Chess Democracy</h1>
                <p>Decentralised P2P chess — no server required</p>
            </header>

            <div className="login-card">

                {step === 'pick' && (
                    <>
                        <h2>Choose your identity</h2>
                        <p className="login-sub">
                            Your identity is an Ed25519 keypair stored locally.
                            Peers recognise you by your public key.
                        </p>

                        <div className="login-options">
                            <button
                                className="id-btn id-btn--primary"
                                onClick={handleGenerate}
                                disabled={loading}
                            >
                                {loading
                                    ? <span className="btn-spinner" />
                                    : <span className="id-icon">✦</span>
                                }
                                <span className="id-label">New identity</span>
                                <span className="id-hint">Generate a fresh keypair</span>
                            </button>

                            <button
                                className="id-btn id-btn--secondary"
                                onClick={handleImport}
                                disabled={loading}
                            >
                                <span className="id-icon">⤓</span>
                                <span className="id-label">Import key</span>
                                <span className="id-hint">Use an existing .pem file</span>
                            </button>
                        </div>

                        {error && <p className="login-error">⚠ {error}</p>}
                    </>
                )}

                {step === 'confirm' && (
                    <>
                        <h2>Identity ready</h2>

                        <div className="key-display">
                            <span className="key-label">Public key</span>
                            <span className="key-value">{shortKey}</span>
                        </div>

                        <div className="key-path">
                            <span className="key-path-label">Stored at</span>
                            <span className="key-path-value">{identityPath}</span>
                        </div>

                        <label className="remember-row">
                            <input
                                type="checkbox"
                                checked={remember}
                                onChange={e => setRemember(e.target.checked)}
                                className="remember-checkbox"
                            />
                            <span>Remember me on this device</span>
                        </label>

                        <p className="remember-hint">
                            {remember
                                ? 'Next launch will skip this screen.'
                                : 'You will see this screen again on next launch.'
                            }
                        </p>

                        {error && <p className="login-error">⚠ {error}</p>}

                        <div className="confirm-row">
                            <button
                                className="back-btn"
                                onClick={() => { setStep('pick'); setError(null); }}
                                disabled={loading}
                            >
                                ← Back
                            </button>
                            <button
                                className="enter-btn"
                                onClick={handleEnter}
                                disabled={loading}
                            >
                                {loading ? <span className="btn-spinner" /> : 'Continue →'}
                            </button>
                        </div>
                    </>
                )}
            </div>

            <p className="login-footer">Chess Democracy — peer-to-peer, no server required</p>
        </div>
    );
}
