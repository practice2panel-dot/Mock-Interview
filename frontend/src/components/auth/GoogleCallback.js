import React, { useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { API_BASE_URL } from '../../config';
import './Auth.css';

const CALLBACK_TIMEOUT_MS = 20000;
const CHECK_AUTH_TIMEOUT_MS = 10000;

const fetchWithTimeout = async (url, options = {}, timeoutMs = 15000) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
};

const GoogleCallback = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { checkAuth } = useAuth();
  const hasProcessed = useRef(false);

  useEffect(() => {
    // Guard against double-execution: the OAuth code is single-use, so we must
    // never call the backend callback endpoint more than once per page load.
    if (hasProcessed.current) return;
    hasProcessed.current = true;

    const handleCallback = async () => {
      const code = searchParams.get('code');
      const state = searchParams.get('state');
      const error = searchParams.get('error');

      if (error) {
        navigate('/login', { state: { error: 'Google login cancelled or failed' } });
        return;
      }

      if (!code || !state) {
        navigate('/login', { state: { error: 'Invalid OAuth callback' } });
        return;
      }

      try {
        const response = await fetchWithTimeout(`${API_BASE_URL}/api/auth/google/callback`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          credentials: 'include',
          body: JSON.stringify({ code, state }),
        }, CALLBACK_TIMEOUT_MS);

        const data = await response.json();

        if (data.success) {
          const isAuthenticated = await Promise.race([
            checkAuth(),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Auth check timeout')), CHECK_AUTH_TIMEOUT_MS)
            ),
          ]);

          if (isAuthenticated) {
            navigate('/mock-interview');
          } else {
            navigate('/login', {
              state: {
                error: 'Google sign-in succeeded but session was not saved. Please allow third-party cookies and try again.',
              },
            });
          }
        } else {
          navigate('/login', { state: { error: data.message || 'Google login failed' } });
        }
      } catch (error) {
        const isTimeout = error.name === 'AbortError' || error.message === 'Auth check timeout';
        navigate('/login', {
          state: {
            error: isTimeout
              ? 'Google login is taking too long. Please try again.'
              : 'Network error during Google login',
          },
        });
      }
    };

    handleCallback();
  }, [searchParams, navigate, checkAuth]);

  return (
    <div className="auth-container">
      <div className="auth-card">
        <div className="auth-header">
          <h1>Completing Google Sign In...</h1>
          <p>Please wait while we complete your authentication</p>
        </div>
      </div>
    </div>
  );
};

export default GoogleCallback;

