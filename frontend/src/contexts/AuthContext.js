import React, { createContext, useState, useEffect, useContext, useCallback, useRef } from 'react';
import { API_BASE_URL } from '../config';

/** Abort auth check if the backend is unreachable (wrong URL, sleeping host, hung proxy). */
const AUTH_CHECK_TIMEOUT_MS = 20000;
const AUTH_HINT_KEY = 'mockinterview_auth_hint';

const AuthContext = createContext();

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

export const AuthProvider = ({ children }) => {
  const hasStoredAuthHint = () => {
    try {
      return window.localStorage.getItem(AUTH_HINT_KEY) === '1';
    } catch {
      return false;
    }
  };

  const persistAuthHint = () => {
    try {
      window.localStorage.setItem(AUTH_HINT_KEY, '1');
    } catch {
      /* ignore storage errors */
    }
  };

  const clearAuthHint = () => {
    try {
      window.localStorage.removeItem(AUTH_HINT_KEY);
    } catch {
      /* ignore storage errors */
    }
  };

  const initialHasAuthHintRef = useRef(hasStoredAuthHint());
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(initialHasAuthHintRef.current);
  const [authenticated, setAuthenticated] = useState(false);

  const checkAuth = useCallback(async ({ silent = false } = {}) => {
    if (!silent) {
      setLoading(true);
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), AUTH_CHECK_TIMEOUT_MS);

    try {
      const response = await fetch(`${API_BASE_URL}/api/auth/check`, {
        method: 'GET',
        credentials: 'include',
        signal: controller.signal,
      });

      let data = {};
      try {
        data = await response.json();
      } catch {
        /* HTML error page or empty body */
      }

      if (data.success && data.authenticated) {
        setUser(data.user);
        setAuthenticated(true);
        persistAuthHint();
        return true;
      }

      setUser(null);
      setAuthenticated(false);
      clearAuthHint();
      return false;
    } catch (error) {
      if (error.name === 'AbortError') {
        console.error(
          'Auth check timed out. Are REACT_APP_API_URL (Vercel) and the backend (e.g. Render) up?',
          API_BASE_URL
        );
      } else {
        console.error('Auth check failed:', error);
      }
      setUser(null);
      setAuthenticated(false);
      clearAuthHint();
      return false;
    } finally {
      clearTimeout(timeoutId);
      setLoading(false);
    }
  }, []);

  // Check authentication status on mount
  useEffect(() => {
    checkAuth({ silent: !initialHasAuthHintRef.current });
  }, [checkAuth]);

  const login = async (email, password, rememberMe = false) => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ email, password, remember_me: rememberMe }),
      });

      const data = await response.json();

      if (data.success) {
        setUser(data.user);
        setAuthenticated(true);
        persistAuthHint();
        return { success: true, message: data.message };
      } else {
        return { success: false, message: data.message };
      }
    } catch (error) {
      return { success: false, message: 'Network error. Please try again.' };
    }
  };

  const signup = async (email, password, fullName) => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/auth/signup`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({
          email,
          password,
          full_name: fullName,
        }),
      });

      if (!response.ok) {
        // If response is not OK, try to parse error message
        try {
          const errorData = await response.json();
          return { success: false, message: errorData.message || 'Signup failed. Please try again.' };
        } catch (parseError) {
          return { 
            success: false, 
            message: `Server error (${response.status}). Please check if the backend server is running on ${API_BASE_URL}` 
          };
        }
      }

      const data = await response.json();
      return { success: data.success, message: data.message, user_id: data.user_id };
    } catch (error) {
      console.error('Signup error:', error);
      if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
        return { 
          success: false, 
          message: `Cannot connect to server at ${API_BASE_URL}. Please ensure the backend server is running.` 
        };
      }
      return { success: false, message: `Network error: ${error.message}` };
    }
  };

  const verifyEmail = async (email, code) => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/auth/verify-email`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ email, code }),
      });

      const data = await response.json();
      return { success: data.success, message: data.message };
    } catch (error) {
      return { success: false, message: 'Network error. Please try again.' };
    }
  };

  const resendVerification = async (email) => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/auth/resend-verification`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ email }),
      });

      const data = await response.json();
      return { success: data.success, message: data.message };
    } catch (error) {
      return { success: false, message: 'Network error. Please try again.' };
    }
  };

  const forgotPassword = async (email) => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/auth/forgot-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ email }),
      });

      const data = await response.json();
      return { success: data.success, message: data.message };
    } catch (error) {
      return { success: false, message: 'Network error. Please try again.' };
    }
  };

  const verifyResetCode = async (email, code) => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/auth/verify-reset-code`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ email, code }),
      });

      const data = await response.json();
      return { success: data.success, message: data.message };
    } catch (error) {
      return { success: false, message: 'Network error. Please try again.' };
    }
  };

  const resetPassword = async (email, code, newPassword) => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/auth/reset-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ email, code, new_password: newPassword }),
      });

      const data = await response.json();
      return { success: data.success, message: data.message };
    } catch (error) {
      return { success: false, message: 'Network error. Please try again.' };
    }
  };

  const changePassword = async (currentPassword, newPassword) => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/auth/change-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({
          current_password: currentPassword,
          new_password: newPassword,
        }),
      });

      const data = await response.json();
      return { success: data.success, message: data.message };
    } catch (error) {
      return { success: false, message: 'Network error. Please try again.' };
    }
  };

  const logout = async () => {
    try {
      await fetch(`${API_BASE_URL}/api/auth/logout`, {
        method: 'POST',
        credentials: 'include',
      });
    } catch (error) {
      console.error('Logout error:', error);
    } finally {
      setUser(null);
      setAuthenticated(false);
      clearAuthHint();
    }
  };

  const getProfile = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/auth/profile`, {
        method: 'GET',
        credentials: 'include',
      });

      const data = await response.json();
      
      if (data.success) {
        setUser(data.user);
        return { success: true, user: data.user };
      } else {
        return { success: false, message: data.message };
      }
    } catch (error) {
      return { success: false, message: 'Network error. Please try again.' };
    }
  };

  const updateProfile = async (fullName) => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/auth/profile`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({
          full_name: fullName,
        }),
      });

      const data = await response.json();
      
      if (data.success) {
        setUser(data.user);
        return { success: true, user: data.user, message: data.message };
      } else {
        return { success: false, message: data.message };
      }
    } catch (error) {
      return { success: false, message: 'Network error. Please try again.' };
    }
  };

  const googleLogin = async () => {
    try {
      // Get Google OAuth authorization URL from backend
      const response = await fetch(`${API_BASE_URL}/api/auth/google/authorize`, {
        method: 'GET',
        credentials: 'include',
      });

      if (!response.ok) {
        // Try to parse error response
        try {
          const errorData = await response.json();
          return { success: false, message: errorData.message || `Server error: ${response.status}` };
        } catch (e) {
          return { success: false, message: `Cannot connect to server at ${API_BASE_URL}. Please ensure the backend server is running.` };
        }
      }

      const data = await response.json();
      
      if (data.success && data.authorization_url) {
        // Redirect to Google OAuth
        window.location.href = data.authorization_url;
        return { success: true };
      } else {
        return { success: false, message: data.message || 'Failed to initiate Google login' };
      }
    } catch (error) {
      console.error('Google login error:', error);
      return { success: false, message: `Network error: ${error.message || 'Cannot connect to server. Please ensure the backend server is running.'}` };
    }
  };

  const value = {
    user,
    authenticated,
    loading,
    login,
    signup,
    verifyEmail,
    resendVerification,
    forgotPassword,
    verifyResetCode,
    resetPassword,
    changePassword,
    logout,
    getProfile,
    updateProfile,
    checkAuth,
    googleLogin,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

