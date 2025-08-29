import React, { useState } from 'react';

export default function AuthDialog({ onAuthenticated, onClose }) {
  const [mode, setMode] = useState('login');
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [registerName, setRegisterName] = useState('');
  const [registerEmail, setRegisterEmail] = useState('');
  const [registerPassword, setRegisterPassword] = useState('');
  const [registerRepeat, setRegisterRepeat] = useState('');
  const [error, setError] = useState('');

  const switchAuthTab = tab => {
    setMode(tab);
    setError('');
  };

  async function handleLogin() {
    const email = loginEmail.trim();
    const password = loginPassword;
    setError('');

    if (!email || !password) {
      setError('Please enter both email and password.');
      return;
    }

    try {
      const result = await callAuthApi('login', { username: email, password });
      localStorage.setItem('jwt', result.token);
      localStorage.setItem('email', email);
      onAuthenticated(email);
      onClose();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleRegister() {
    const name = registerName.trim();
    const email = registerEmail.trim();
    const password = registerPassword;
    const repeat = registerRepeat;
    setError('');

    if (!name || !email || !password || !repeat) {
      setError('Please fill in all fields.');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    if (password !== repeat) {
      setError('Passwords do not match.');
      return;
    }

    try {
      const result = await callAuthApi('register', { username: email, password });
      localStorage.setItem('jwt', result.token);
      localStorage.setItem('email', email);
      onAuthenticated(email);
      onClose();
    } catch (err) {
      setError(err.message);
    }
  }

  async function callAuthApi(endpoint, data) {
    const response = await fetch(`https://vectrabackyard-3dmb6.ondigitalocean.app/auth/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || 'Something went wrong');
    }
    return response.json();
  }

  return (
    <div id="authDialog" className="auth-dialog">
      <h2 className="auth-title">{mode === 'login' ? 'Login' : 'Register'}</h2>
        <div id="loginForm" className={`auth-form glass-effect${mode === 'login' ? '' : ' hidden'}`}>
        <input
          type="email"
          id="login1"
          placeholder="Email or username"
          autoComplete="off"
          value={loginEmail}
          onChange={e => setLoginEmail(e.target.value)}
        />
        <input
          type="password"
          id="login2"
          placeholder="Password"
          autoComplete="off"
          value={loginPassword}
          onChange={e => setLoginPassword(e.target.value)}
        />
        <div className="error-message" id="loginError">{mode === 'login' && error}</div>
        <button onClick={handleLogin}>Login</button>
        <p className="auth-link">
          Don't have an account? <a onClick={() => switchAuthTab('register')}>Register</a>
        </p>
      </div>
        <div id="registerForm" className={`auth-form glass-effect${mode === 'register' ? '' : ' hidden'}`}>
        <input
          type="text"
          id="registerName"
          placeholder="Name"
          value={registerName}
          onChange={e => setRegisterName(e.target.value)}
        />
        <input
          type="email"
          id="registerEmail"
          placeholder="Email"
          value={registerEmail}
          onChange={e => setRegisterEmail(e.target.value)}
        />
        <input
          type="password"
          id="registerPassword"
          placeholder="Password"
          value={registerPassword}
          onChange={e => setRegisterPassword(e.target.value)}
        />
        <input
          type="password"
          id="registerRepeatPassword"
          placeholder="Repeat Password"
          value={registerRepeat}
          onChange={e => setRegisterRepeat(e.target.value)}
        />
        <div className="error-message" id="registerError">{mode === 'register' && error}</div>
        <button onClick={handleRegister}>Register</button>
        <p className="auth-link">
          Already have an account? <a onClick={() => switchAuthTab('login')}>Login</a>
        </p>
      </div>
    </div>
  );
}

